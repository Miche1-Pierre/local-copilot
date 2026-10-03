// Keeps the codebase index in sync with the workspace: initial scan, file
// watching, .gitignore, background embeddings and their persistence (in VS
// Code's workspace storage, never in the repository).

import * as vscode from 'vscode';
import { CodebaseIndex } from '../core/index/codebaseIndex';
import { IgnoreMatcher } from '../core/index/gitignore';
import { INDEXABLE_EXTENSIONS, languageIdForPath } from '../core/index/languages';
import { detectFrameworks, isManifestPath, type Manifest, type ProjectSummary } from '../core/index/projectSummary';
import { VectorStore } from '../core/index/vectors';
import { debounce, isCancellation, sleep } from '../core/util/async';
import { LruCache } from '../core/util/lru';
import { normalizeEol, toPosixPath } from '../core/util/text';
import type { Logger } from './logger';
import type { ModelManager } from './modelManager';
import { settings } from './settings';

export interface IndexStatus {
  state: 'idle' | 'indexing' | 'embedding' | 'disabled' | 'error';
  files: number;
  symbols: number;
  chunks: number;
  embedded: number;
  message?: string;
  progress?: { done: number; total: number };
}

const EXCLUDED_DIRS = [
  'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', 'bin', 'obj', 'target', '.next', '.nuxt', '.svelte-kit', 'coverage',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.gradle', '.idea', '.vs', '.vscode-test', 'Library', 'Temp',
  'Logs', 'UserSettings', 'MemoryCaptures', 'Builds', '.godot', '.import', 'Pods', 'DerivedData', '.cache', '.turbo', '.parcel-cache',
];
const EXCLUDED_FILES = ['*.min.js', '*.min.css', '*.map', '*.lock', 'package-lock.json', '*.g.cs', '*.designer.cs', '*.generated.*'];
const EMBED_BATCH = 16;
const VECTORS_FILE = 'vectors.bin';

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function looksGeneratedOrBinary(text: string): boolean {
  if (text.slice(0, 8000).includes('\u0000')) return true;
  const lines = text.split('\n');
  if (lines.some((l) => l.length > 5000)) return true;
  return lines.length < 20 && text.length / Math.max(1, lines.length) > 400;
}

export class WorkspaceIndexer implements vscode.Disposable {
  readonly index: CodebaseIndex;
  private readonly texts = new LruCache<string, string>(200);
  private readonly statusEmitter = new vscode.EventEmitter<IndexStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  private status: IndexStatus = { state: 'idle', files: 0, symbols: 0, chunks: 0, embedded: 0 };
  private summary: ProjectSummary = { languages: [], frameworks: [], testFrameworks: [], topDirectories: [] };
  private ignore = new IgnoreMatcher();
  private watcher?: vscode.FileSystemWatcher;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private scanToken = 0;
  private lastTypingAt = 0;
  private embedAbort?: AbortController;
  private readonly saveVectorsSoon = debounce(() => void this.saveVectors(), 20_000);
  private readonly embedSoon = debounce(() => void this.runEmbeddings(this.scanToken), 5_000);

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly models: ModelManager,
    private readonly log: Logger,
  ) {
    this.index = new CodebaseIndex((p) => this.readText(p));
    this.disposables.push(vscode.workspace.onDidGrantWorkspaceTrust(() => this.start()));
  }

  get current(): IndexStatus {
    return this.status;
  }

  get projectSummary(): ProjectSummary {
    return this.summary;
  }

  get ready(): boolean {
    return this.status.files > 0;
  }

  /** Background embedding yields the GPU while the user types (completions come first). */
  noteTyping(): void {
    this.lastTypingAt = Date.now();
  }

  start(): void {
    if (!settings.indexEnabled()) {
      this.setStatus({ state: 'disabled', message: 'Indexing is turned off (localCopilot.index.enabled).' });
      return;
    }
    if (!vscode.workspace.isTrusted) {
      this.setStatus({ state: 'disabled', message: 'Restricted mode: trust this workspace to enable the codebase index.' });
      return;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      this.setStatus({ state: 'disabled', message: 'No folder open.' });
      return;
    }
    void this.rebuild(false);
  }

  async rebuild(dropVectors: boolean): Promise<void> {
    const token = ++this.scanToken;
    this.embedAbort?.abort();
    this.index.clear();
    this.texts.clear();
    if (dropVectors) await this.deleteVectors();
    else await this.loadVectors();
    this.setStatus({ state: 'indexing', message: 'Scanning workspace…', progress: { done: 0, total: 0 } });
    const t0 = Date.now();
    try {
      await this.loadIgnoreFiles();
      const uris = (await vscode.workspace.findFiles(this.includeGlob(), this.excludeGlob(), settings.maxFiles())).filter((u) => !this.isIgnored(u));
      for (let i = 0; i < uris.length; i += 25) {
        if (token !== this.scanToken) return;
        await Promise.all(uris.slice(i, i + 25).map((u) => this.indexUri(u).catch((err) => this.log.debug(`index ${u.fsPath}: ${(err as Error).message}`))));
        this.setStatus({ state: 'indexing', message: 'Indexing…', progress: { done: Math.min(uris.length, i + 25), total: uris.length } });
        await sleep(0);
      }
      await this.loadManifests();
      this.index.vectors.retain(new Set([...this.index.allChunks()].map((c) => c.id)));
      this.ensureWatcher();
      const s = this.index.stats();
      this.log.info(`Indexed ${s.files} files, ${s.symbols} symbols, ${s.chunks} chunks in ${Date.now() - t0} ms`);
      this.setStatus({ state: 'idle', message: undefined, progress: undefined });
      void this.runEmbeddings(token);
    } catch (err) {
      this.log.error('Indexing failed', err);
      this.setStatus({ state: 'error', message: (err as Error).message });
    }
  }

  /** Workspace-relative POSIX path (prefixed by the folder name in multi-root workspaces). */
  relPath(uri: vscode.Uri): string {
    const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    return toPosixPath(vscode.workspace.asRelativePath(uri, multi));
  }

  uriOf(relPath: string): vscode.Uri | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return undefined;
    if (folders.length === 1) return vscode.Uri.joinPath(folders[0].uri, relPath);
    const [head, ...rest] = relPath.split('/');
    const folder = folders.find((f) => f.name === head) ?? folders[0];
    return vscode.Uri.joinPath(folder.uri, folder.name === head ? rest.join('/') : relPath);
  }

  get repoName(): string {
    return vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name ?? 'workspace';
  }

  /** Live text: open editor buffer first, then cache, then disk. */
  async readText(relPath: string): Promise<string | undefined> {
    const uri = this.uriOf(relPath);
    if (!uri) return undefined;
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return normalizeEol(open.getText());
    const cached = this.texts.get(relPath);
    if (cached !== undefined) return cached;
    try {
      const text = normalizeEol(decode(await vscode.workspace.fs.readFile(uri)));
      this.texts.set(relPath, text);
      return text;
    } catch {
      return undefined;
    }
  }

  async queryVector(query: string, signal?: AbortSignal): Promise<number[] | undefined> {
    if (!settings.embeddingsEnabled() || this.index.vectors.size === 0) return undefined;
    try {
      const [vec] = await this.models.embed([query], 'query', signal);
      return vec;
    } catch (err) {
      if (!isCancellation(err)) this.log.debug(`query embedding failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  summaryText(): string {
    const langs = this.summary.languages.slice(0, 4).map((l) => `${l.id} (${l.files})`).join(', ');
    const parts = [
      this.summary.frameworks.length ? `Frameworks: ${this.summary.frameworks.join(', ')}` : undefined,
      langs ? `Languages: ${langs}` : undefined,
      this.summary.testFrameworks.length ? `Tests: ${this.summary.testFrameworks.join(', ')}` : undefined,
    ].filter(Boolean);
    return parts.join('\n');
  }

  fileTree(): string {
    return this.summary.topDirectories.join('\n');
  }

  dispose(): void {
    this.scanToken++;
    this.embedAbort?.abort();
    this.saveVectorsSoon.cancel();
    void this.saveVectors();
    this.watcher?.dispose();
    for (const d of this.disposables) d.dispose();
    for (const t of this.pending.values()) clearTimeout(t);
    this.statusEmitter.dispose();
  }

  // -------------------------------------------------------------------------

  private includeGlob(): string {
    const patterns = INDEXABLE_EXTENSIONS.map((e) => `**/*${e}`);
    patterns.push('**/Dockerfile', '**/Makefile', ...settings.indexInclude());
    return `{${patterns.join(',')}}`;
  }

  private excludeGlob(): string {
    const patterns = [...EXCLUDED_DIRS.map((d) => `**/${d}/**`), ...EXCLUDED_FILES.map((f) => `**/${f}`), ...settings.indexExclude()];
    const filesExclude = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude', {});
    for (const [glob, on] of Object.entries(filesExclude)) if (on) patterns.push(glob);
    return `{${patterns.join(',')}}`;
  }

  private isIgnored(uri: vscode.Uri): boolean {
    return settings.respectGitignore() && this.ignore.ignores(this.relPath(uri));
  }

  private async loadIgnoreFiles(): Promise<void> {
    this.ignore = new IgnoreMatcher();
    if (!settings.respectGitignore()) return;
    const files = await vscode.workspace.findFiles('**/.gitignore', this.excludeGlob(), 200);
    for (const uri of files) {
      try {
        const rel = this.relPath(uri);
        const base = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        this.ignore.add(base, decode(await vscode.workspace.fs.readFile(uri)));
      } catch {
        /* unreadable .gitignore: skip */
      }
    }
  }

  private async indexUri(uri: vscode.Uri): Promise<void> {
    const rel = this.relPath(uri);
    const languageId = languageIdForPath(rel);
    if (!languageId) return;
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > settings.maxFileSizeKB() * 1024) return;
    const text = normalizeEol(decode(await vscode.workspace.fs.readFile(uri)));
    if (looksGeneratedOrBinary(text)) return;
    this.texts.set(rel, text);
    this.index.upsert(rel, text, languageId, { size: stat.size, mtime: stat.mtime });
  }

  private async loadManifests(): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      '{**/package.json,**/requirements.txt,**/pyproject.toml,**/setup.py,**/go.mod,**/Cargo.toml,**/pom.xml,**/build.gradle,**/build.gradle.kts,**/ProjectSettings/ProjectVersion.txt,**/Packages/manifest.json,**/project.godot,**/composer.json,**/Gemfile,**/*.csproj,**/*.asmdef}',
      this.excludeGlob(),
      300,
    );
    const manifests: Manifest[] = [];
    for (const uri of uris) {
      const rel = this.relPath(uri);
      if (!isManifestPath(rel)) continue;
      try {
        manifests.push({ path: rel, text: decode(await vscode.workspace.fs.readFile(uri)).slice(0, 200_000) });
      } catch {
        /* skip */
      }
    }
    const { frameworks, testFrameworks } = detectFrameworks(manifests);
    const dirs = new Map<string, number>();
    for (const f of this.index.files.keys()) {
      const parts = f.split('/');
      const key = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
      if (parts.length > 1) dirs.set(key, (dirs.get(key) ?? 0) + 1);
    }
    this.summary = {
      languages: this.index.languageCounts(),
      frameworks,
      testFrameworks,
      topDirectories: [...dirs.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([d, n]) => `${d}/ (${n} files)`),
    };
  }

  private ensureWatcher(): void {
    if (this.watcher) return;
    this.watcher = vscode.workspace.createFileSystemWatcher(this.includeGlob());
    const schedule = (uri: vscode.Uri, deleted: boolean) => {
      if (this.isIgnored(uri) || /[\\/](node_modules|\.git|Library|Temp|obj|bin)[\\/]/.test(uri.fsPath)) return;
      const key = uri.toString();
      const prev = this.pending.get(key);
      if (prev) clearTimeout(prev);
      this.pending.set(
        key,
        setTimeout(async () => {
          this.pending.delete(key);
          const rel = this.relPath(uri);
          this.texts.delete(rel);
          try {
            if (deleted) this.index.remove(rel);
            else await this.indexUri(uri);
          } catch {
            this.index.remove(rel);
          }
          this.setStatus({});
          this.embedSoon();
        }, 1500),
      );
    };
    this.watcher.onDidCreate((u) => schedule(u, false));
    this.watcher.onDidChange((u) => schedule(u, false));
    this.watcher.onDidDelete((u) => schedule(u, true));
  }

  private async runEmbeddings(token: number): Promise<void> {
    if (!settings.embeddingsEnabled() || token !== this.scanToken) return;
    const model = settings.embeddingModel();
    if (!(await this.models.isInstalled(model))) {
      this.setStatus({ message: `Embedding model "${model}" is not installed: semantic search is off (symbols + keywords still work).` });
      return;
    }
    const todo = this.index.chunksToEmbed(model);
    if (todo.length === 0) return;
    this.embedAbort?.abort();
    const abort = new AbortController();
    this.embedAbort = abort;
    this.setStatus({ state: 'embedding', message: `Embedding ${todo.length} chunks with ${model}…`, progress: { done: 0, total: todo.length } });
    for (let i = 0; i < todo.length; i += EMBED_BATCH) {
      if (token !== this.scanToken || abort.signal.aborted) return;
      // Never compete with an analysis or with typing for the GPU.
      while ((this.models.busyWithChat || Date.now() - this.lastTypingAt < 2000) && !abort.signal.aborted) await sleep(500);
      const batch = todo.slice(i, i + EMBED_BATCH);
      const texts = await Promise.all(batch.map(async (c) => `${c.path}${c.symbol ? ` (${c.symbol})` : ''}\n${((await this.index.chunkText(c)) ?? '').slice(0, 6000)}`));
      try {
        const vectors = await this.models.embed(texts, 'document', abort.signal);
        batch.forEach((c, k) => this.index.vectors.set(c.id, c.hash, vectors[k]));
      } catch (err) {
        if (isCancellation(err)) return;
        this.log.warn(`Embeddings stopped: ${(err as Error).message}`);
        this.setStatus({ state: 'idle', message: `Embeddings paused: ${(err as Error).message}`, progress: undefined });
        return;
      }
      this.setStatus({ state: 'embedding', progress: { done: Math.min(todo.length, i + EMBED_BATCH), total: todo.length } });
      this.saveVectorsSoon();
    }
    this.setStatus({ state: 'idle', message: undefined, progress: undefined });
    await this.saveVectors();
  }

  private vectorsUri(): vscode.Uri | undefined {
    return this.context.storageUri ? vscode.Uri.joinPath(this.context.storageUri, VECTORS_FILE) : undefined;
  }

  private async loadVectors(): Promise<void> {
    const uri = this.vectorsUri();
    if (!uri) return;
    try {
      this.index.vectors.replaceWith(VectorStore.deserialize(await vscode.workspace.fs.readFile(uri)));
    } catch {
      /* no stored vectors yet */
    }
  }

  private async saveVectors(): Promise<void> {
    const uri = this.vectorsUri();
    if (!uri || this.index.vectors.size === 0) return;
    try {
      await vscode.workspace.fs.createDirectory(this.context.storageUri!);
      await vscode.workspace.fs.writeFile(uri, this.index.vectors.serialize());
    } catch (err) {
      this.log.warn(`Could not save embeddings: ${(err as Error).message}`);
    }
  }

  private async deleteVectors(): Promise<void> {
    const uri = this.vectorsUri();
    if (!uri) return;
    try {
      await vscode.workspace.fs.delete(uri);
    } catch {
      /* nothing to delete */
    }
  }

  private setStatus(patch: Partial<IndexStatus>): void {
    const stats = this.index.stats();
    this.status = { ...this.status, ...stats, ...patch };
    this.statusEmitter.fire(this.status);
  }
}
