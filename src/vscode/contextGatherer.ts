// Chooses the repository context that goes into prompts.
// Inline completion: small, fast and stable (so the server can reuse its KV cache).
// Analyses: richer — definitions of what the code uses, related files, project summary.

import * as vscode from 'vscode';
import { similarityTokens, WindowIndex } from '../core/context/similarity';
import type { ContextSnippet } from '../core/intelligence/prompts';
import { familyOf } from '../core/index/languages';
import { CALLABLE_KINDS, outlineOf, TYPE_KINDS, type SymbolInfo } from '../core/index/symbols';
import type { ContextFile } from '../core/providers/types';
import { LruCache } from '../core/util/lru';
import { estimateTokens } from '../core/util/tokens';
import type { WorkspaceIndexer } from './indexer';

const IDENT = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const NOISE = new Set(['this', 'self', 'base', 'super', 'null', 'true', 'false', 'void', 'return', 'string', 'float', 'double', 'bool', 'object', 'var', 'const', 'let', 'new', 'public', 'private', 'static', 'class', 'function', 'async', 'await', 'import', 'from', 'using']);

interface CachedContext {
  at: number;
  budget: number;
  files: ContextFile[];
}

export class ContextGatherer implements vscode.Disposable {
  private readonly windows = new LruCache<string, WindowIndex>(40);
  private readonly inlineCache = new LruCache<string, CachedContext>(60);
  private readonly recency: string[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly indexer: WorkspaceIndexer) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (!e) return;
        const key = e.document.uri.toString();
        const i = this.recency.indexOf(key);
        if (i >= 0) this.recency.splice(i, 1);
        this.recency.unshift(key);
        this.recency.length = Math.min(this.recency.length, 30);
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  /** Repository context for a completion at `position`. Cached per region for ~20 s to keep prompts stable. */
  inlineContext(document: vscode.TextDocument, position: vscode.Position, budgetTokens: number): ContextFile[] {
    const key = `${document.uri.toString()}#${Math.floor(position.line / 15)}`;
    const cached = this.inlineCache.get(key);
    if (cached && cached.budget === budgetTokens && Date.now() - cached.at < 20_000) return cached.files;

    const path = this.indexer.relPath(document.uri);
    const parts = new Map<string, { content: string[]; tokens: number }>();
    let remaining = budgetTokens;
    const add = (p: string, text: string, maxTokens: number): boolean => {
      const t = Math.min(estimateTokens(text), maxTokens);
      if (t > remaining || !text.trim()) return false;
      const entry = parts.get(p) ?? { content: [], tokens: 0 };
      entry.content.push(text);
      entry.tokens += t;
      parts.set(p, entry);
      remaining -= t;
      return true;
    };

    // 1. Definitions of the symbols used around the cursor (most useful: real APIs).
    const from = Math.max(0, position.line - 12);
    const near = document.getText(new vscode.Range(from, 0, Math.min(document.lineCount - 1, position.line + 2), 0));
    const idents = this.identifiers(near);
    const defBudget = Math.floor(budgetTokens * 0.5);
    let spent = 0;
    const seenDefs = new Set<string>();
    for (const name of idents.slice(0, 16)) {
      for (const def of this.indexer.index.meaningfulDefinitionsOf(name, path).slice(0, 2)) {
        const id = `${def.path}:${def.symbol.declLine}`;
        if (seenDefs.has(id)) continue;
        seenDefs.add(id);
        const text = this.definitionOutline(def.path, def.symbol);
        const t = estimateTokens(text);
        if (spent + t > defBudget) continue;
        if (add(def.path, text, 300)) spent += t;
      }
    }

    // 2. The most similar code in recently used editors.
    const reference = similarityTokens(document.getText(new vscode.Range(Math.max(0, position.line - 20), 0, position.line, position.character)));
    const family = familyOf(document.languageId);
    const candidates: { path: string; text: string; score: number }[] = [];
    for (const doc of this.recentDocuments(document)) {
      if (familyOf(doc.languageId) !== family && family !== 'other') continue;
      const win = this.windowIndex(doc);
      const best = win.best(reference);
      if (!best || best.score < 0.12) continue;
      candidates.push({ path: this.indexer.relPath(doc.uri), text: win.lines.slice(best.startLine, best.endLine + 1).join('\n'), score: best.score });
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const c of candidates.slice(0, 2)) add(c.path, c.text, 400);

    // 3. Outlines of the files this one imports.
    const file = this.indexer.index.files.get(path);
    for (const imp of (file ? this.indexer.index.relatedFiles(path, 4) : []).filter((r) => r.reason.includes('imported'))) {
      const other = this.indexer.index.files.get(imp.path);
      if (other) add(imp.path, outlineOf(other.symbols, 20), 200);
    }

    const files = [...parts.entries()].map(([p, e]) => ({ path: p, content: e.content.join('\n\n') }));
    this.inlineCache.set(key, { at: Date.now(), budget: budgetTokens, files });
    return files;
  }

  /** Context for an analysis of `range`: definitions it uses and related files. */
  async taskContext(document: vscode.TextDocument, range: vscode.Range, budgetTokens: number): Promise<ContextSnippet[]> {
    const path = this.indexer.relPath(document.uri);
    const code = document.getText(range);
    const counts = new Map<string, number>();
    for (const m of code.match(IDENT) ?? []) if (!NOISE.has(m.toLowerCase())) counts.set(m, (counts.get(m) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);

    const out: ContextSnippet[] = [];
    let remaining = budgetTokens;
    const push = (s: ContextSnippet) => {
      const t = estimateTokens(s.text);
      if (t > remaining || !s.text.trim()) return;
      out.push(s);
      remaining -= t;
    };

    const seen = new Set<string>();
    for (const name of ranked.slice(0, 40)) {
      for (const def of this.indexer.index.meaningfulDefinitionsOf(name, undefined).slice(0, 2)) {
        // Skip definitions inside the code under analysis itself.
        if (def.path === path && def.symbol.declLine >= range.start.line && def.symbol.declLine <= range.end.line) continue;
        const id = `${def.path}:${def.symbol.declLine}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const file = this.indexer.index.files.get(def.path);
        if (!file) continue;
        let text: string;
        let startLine = def.symbol.startLine;
        let endLine = def.symbol.endLine;
        if (CALLABLE_KINDS.has(def.symbol.kind) && def.symbol.endLine - def.symbol.startLine <= 40) {
          const full = await this.indexer.readText(def.path);
          text = full?.split('\n').slice(def.symbol.startLine, def.symbol.endLine + 1).join('\n') ?? def.symbol.signature;
        } else {
          text = this.definitionOutline(def.path, def.symbol);
          endLine = def.symbol.declLine;
          startLine = def.symbol.declLine;
        }
        push({ path: def.path, startLine: startLine + 1, endLine: endLine + 1, label: `defines ${def.symbol.name}`, languageId: file.languageId, text });
      }
      if (remaining < 200) break;
    }

    for (const rel of this.indexer.index.relatedFiles(path, 4)) {
      const file = this.indexer.index.files.get(rel.path);
      if (!file || out.some((s) => s.path === rel.path)) continue;
      push({ path: rel.path, label: rel.reason, languageId: file.languageId, text: outlineOf(file.symbols, 30) });
    }
    return out;
  }

  /** Signature of a symbol; for types, their member signatures too. */
  private definitionOutline(path: string, symbol: SymbolInfo): string {
    const file = this.indexer.index.files.get(path);
    if (!file) return symbol.signature;
    const doc = symbol.doc ? `// ${symbol.doc}\n` : '';
    if (!TYPE_KINDS.has(symbol.kind)) return `${doc}${symbol.signature}`;
    const members = file.symbols.filter((s) => s.container === symbol.name && s.startLine > symbol.startLine && s.endLine <= symbol.endLine);
    return `${doc}${symbol.signature}\n${members.slice(0, 25).map((m) => `    ${m.signature}`).join('\n')}`;
  }

  private identifiers(text: string): string[] {
    const found = text.match(IDENT) ?? [];
    const out: string[] = [];
    const seen = new Set<string>();
    // Nearest to the cursor first.
    for (let i = found.length - 1; i >= 0; i--) {
      const w = found[i];
      if (seen.has(w) || NOISE.has(w.toLowerCase())) continue;
      if (!/[A-Z]/.test(w) && w.length < 6) continue;
      seen.add(w);
      out.push(w);
    }
    return out;
  }

  private recentDocuments(exclude: vscode.TextDocument): vscode.TextDocument[] {
    const docs = vscode.workspace.textDocuments.filter(
      (d) => d !== exclude && (d.uri.scheme === 'file' || d.uri.scheme === 'untitled' || d.uri.scheme === 'vscode-remote') && d.getText().length < 500_000,
    );
    const rank = (d: vscode.TextDocument) => {
      const i = this.recency.indexOf(d.uri.toString());
      return i < 0 ? 1000 : i;
    };
    return docs.sort((a, b) => rank(a) - rank(b)).slice(0, 12);
  }

  private windowIndex(doc: vscode.TextDocument): WindowIndex {
    const key = `${doc.uri.toString()}@${doc.version}`;
    let win = this.windows.get(key);
    if (!win) {
      win = new WindowIndex(doc.getText().split(/\r?\n/));
      this.windows.set(key, win);
    }
    return win;
  }
}
