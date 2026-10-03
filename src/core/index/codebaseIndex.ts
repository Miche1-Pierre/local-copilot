// The local codebase index: per-file symbols, imports and chunks, a symbol table
// (name → definitions), an import/reference graph, BM25 over chunks and optional
// embeddings. Pure logic; file I/O is injected.

import { hashString } from '../util/text';
import { Bm25Index, reciprocalRankFusion, tokenizeCode } from './bm25';
import { chunkFile, type Chunk } from './chunker';
import { declaredNamespace, extractImports, resolveImport, type ImportRef } from './imports';
import { isCodeFamily, familyOf } from './languages';
import { maskCode } from './scanner';
import { CALLABLE_KINDS, extractSymbols, TYPE_KINDS, type SymbolInfo } from './symbols';
import { VectorStore } from './vectors';

export interface IndexedFile {
  path: string;
  languageId: string;
  size: number;
  mtime: number;
  hash: string;
  symbols: SymbolInfo[];
  imports: ImportRef[];
  resolvedImports: string[];
  namespace?: string;
  chunks: Chunk[];
  /** Distinct identifiers used in the code, for the reference graph. */
  references: string[];
}

export interface Definition {
  path: string;
  symbol: SymbolInfo;
}

export interface SearchHit {
  chunk: Chunk;
  score: number;
  reasons: ('symbol' | 'lexical' | 'semantic' | 'path')[];
}

export interface RelatedFile {
  path: string;
  score: number;
  reason: string;
}

export type ReadText = (path: string) => Promise<string | undefined>;

/** Names defined in many files (Unity's Start/Update, main, init…) carry no signal. */
const MAX_DEFINITION_FANOUT = 3;
const MAX_REFERENCES = 400;

export class CodebaseIndex {
  readonly files = new Map<string, IndexedFile>();
  readonly vectors = new VectorStore();
  private readonly bm25 = new Bm25Index();
  private readonly chunks = new Map<string, Chunk>();
  private readonly definitions = new Map<string, Definition[]>();
  private readonly namespaces = new Map<string, string[]>();
  private importsDirty = true;

  constructor(private readonly readText: ReadText) {}

  upsert(path: string, text: string, languageId: string, meta: { size: number; mtime: number }): IndexedFile {
    this.remove(path);
    const symbols = extractSymbols(text, languageId);
    const chunks = chunkFile(path, text, symbols);
    const lines = text.split('\n');
    for (const c of chunks) {
      this.chunks.set(c.id, c);
      // The symbol name counts twice: a chunk is mostly "about" the symbol it holds.
      const header = `${path} ${c.symbol ?? ''} ${c.symbol ?? ''}`;
      this.bm25.add(c.id, tokenizeCode(`${header}\n${lines.slice(c.startLine, c.endLine + 1).join('\n')}`));
    }
    const file: IndexedFile = {
      path,
      languageId,
      size: meta.size,
      mtime: meta.mtime,
      hash: hashString(text),
      symbols,
      imports: extractImports(text, languageId),
      resolvedImports: [],
      namespace: declaredNamespace(text, languageId),
      chunks,
      references: isCodeFamily(familyOf(languageId)) ? collectReferences(text, languageId) : [],
    };
    this.files.set(path, file);
    for (const s of symbols) {
      if (!TYPE_KINDS.has(s.kind) && !CALLABLE_KINDS.has(s.kind)) continue;
      const key = s.name.toLowerCase();
      const list = this.definitions.get(key) ?? [];
      list.push({ path, symbol: s });
      this.definitions.set(key, list);
    }
    if (file.namespace) {
      const list = this.namespaces.get(file.namespace) ?? [];
      list.push(path);
      this.namespaces.set(file.namespace, list);
    }
    this.importsDirty = true;
    return file;
  }

  remove(path: string): void {
    const file = this.files.get(path);
    if (!file) return;
    for (const c of file.chunks) {
      this.chunks.delete(c.id);
      this.bm25.remove(c.id);
      this.vectors.delete(c.id);
    }
    for (const s of file.symbols) {
      const key = s.name.toLowerCase();
      const list = this.definitions.get(key)?.filter((d) => d.path !== path);
      if (list && list.length > 0) this.definitions.set(key, list);
      else this.definitions.delete(key);
    }
    if (file.namespace) {
      const list = this.namespaces.get(file.namespace)?.filter((p) => p !== path);
      if (list && list.length > 0) this.namespaces.set(file.namespace, list);
      else this.namespaces.delete(file.namespace);
    }
    this.files.delete(path);
    this.importsDirty = true;
  }

  clear(): void {
    for (const p of [...this.files.keys()]) this.remove(p);
    this.vectors.clear();
  }

  private ensureImportsResolved(): void {
    if (!this.importsDirty) return;
    const paths = new Set(this.files.keys());
    for (const f of this.files.values()) {
      const resolved = new Set<string>();
      for (const ref of f.imports) for (const p of resolveImport(ref, f.path, f.languageId, paths, this.namespaces)) if (p !== f.path) resolved.add(p);
      f.resolvedImports = [...resolved];
    }
    this.importsDirty = false;
  }

  /** Definitions of a symbol name across the workspace (case-insensitive). */
  definitionsOf(name: string): Definition[] {
    return this.definitions.get(name.toLowerCase()) ?? [];
  }

  /** Definitions that carry signal: unique-ish names only. */
  meaningfulDefinitionsOf(name: string, excludePath?: string): Definition[] {
    const defs = this.definitionsOf(name);
    if (defs.length === 0 || defs.length > MAX_DEFINITION_FANOUT) return [];
    return defs.filter((d) => d.path !== excludePath);
  }

  /** Files connected to `path`: its imports, the files defining what it uses, and the files importing it. */
  relatedFiles(path: string, limit = 8): RelatedFile[] {
    this.ensureImportsResolved();
    const file = this.files.get(path);
    if (!file) return [];
    const scores = new Map<string, { score: number; reasons: Set<string> }>();
    const bump = (p: string, s: number, reason: string) => {
      if (p === path) return;
      const e = scores.get(p) ?? { score: 0, reasons: new Set<string>() };
      e.score += s;
      e.reasons.add(reason);
      scores.set(p, e);
    };
    for (const p of file.resolvedImports) bump(p, 3, 'imported');
    for (const name of file.references) {
      for (const d of this.meaningfulDefinitionsOf(name, path)) bump(d.path, TYPE_KINDS.has(d.symbol.kind) ? 1 : 0.6, `uses ${d.symbol.name}`);
    }
    for (const other of this.files.values()) if (other.resolvedImports.includes(path)) bump(other.path, 1, 'imports this file');
    return [...scores.entries()]
      .map(([p, e]) => ({ path: p, score: e.score, reason: [...e.reasons].slice(0, 3).join(', ') }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  chunk(id: string): Chunk | undefined {
    return this.chunks.get(id);
  }

  allChunks(): IterableIterator<Chunk> {
    return this.chunks.values();
  }

  async chunkText(chunk: Chunk): Promise<string | undefined> {
    const text = await this.readText(chunk.path);
    if (text === undefined) return undefined;
    return text.split('\n').slice(chunk.startLine, chunk.endLine + 1).join('\n');
  }

  /** Chunks without an up-to-date vector for the current embedding model. */
  chunksToEmbed(model: string): Chunk[] {
    if (this.vectors.model !== model) {
      this.vectors.clear();
      this.vectors.model = model;
    }
    const out: Chunk[] = [];
    for (const c of this.chunks.values()) if (!this.vectors.has(c.id, c.hash)) out.push(c);
    return out;
  }

  /** Hybrid retrieval: exact symbol names, BM25, embeddings and path hints, fused by reciprocal rank. */
  search(query: string, opts: { limit: number; queryVector?: number[]; maxPerFile?: number; filter?: (path: string) => boolean }): SearchHit[] {
    const filterChunk = opts.filter ? (id: string) => opts.filter!(this.chunks.get(id)?.path ?? '') : undefined;
    const reasons = new Map<string, Set<SearchHit['reasons'][number]>>();
    const tag = (list: { id: string }[], reason: SearchHit['reasons'][number]) => {
      for (const { id } of list) {
        const set = reasons.get(id) ?? new Set();
        set.add(reason);
        reasons.set(id, set);
      }
      return list;
    };

    // Exact symbol lookups only for words that look like identifiers ("TakeDamage", "load_save"),
    // never for prose ("How does…") and never for names defined all over the codebase.
    const symbolHits: { id: string }[] = [];
    const words = query.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
    for (const w of new Set(words.filter((word, i) => looksLikeIdentifier(word, i === 0)))) {
      const defs = this.definitionsOf(w);
      if (defs.length > 5) continue;
      for (const d of defs) {
        const file = this.files.get(d.path);
        const c = file?.chunks.find((ch) => ch.startLine <= d.symbol.declLine && ch.endLine >= d.symbol.declLine);
        if (c && (!filterChunk || filterChunk(c.id))) symbolHits.push({ id: c.id });
      }
    }

    const lexical = this.bm25.search(tokenizeCode(query), 50, filterChunk);
    const semantic = opts.queryVector ? this.vectors.search(opts.queryVector, 50, filterChunk) : [];
    const fused = reciprocalRankFusion([tag(symbolHits, 'symbol'), tag(lexical, 'lexical'), tag(semantic, 'semantic')]);

    const maxPerFile = opts.maxPerFile ?? 3;
    const perFile = new Map<string, Chunk[]>();
    const out: SearchHit[] = [];
    for (const { id, score } of fused) {
      const chunk = this.chunks.get(id);
      if (!chunk) continue;
      const taken = perFile.get(chunk.path) ?? [];
      if (taken.length >= maxPerFile) continue;
      if (taken.some((t) => t.startLine <= chunk.endLine && t.endLine >= chunk.startLine)) continue;
      taken.push(chunk);
      perFile.set(chunk.path, taken);
      out.push({ chunk, score, reasons: [...(reasons.get(id) ?? [])] });
      if (out.length >= opts.limit) break;
    }
    return out;
  }

  stats(): { files: number; symbols: number; chunks: number; embedded: number } {
    let symbols = 0;
    for (const f of this.files.values()) symbols += f.symbols.length;
    return { files: this.files.size, symbols, chunks: this.chunks.size, embedded: this.vectors.size };
  }

  languageCounts(): { id: string; files: number }[] {
    const counts = new Map<string, number>();
    for (const f of this.files.values()) counts.set(f.languageId, (counts.get(f.languageId) ?? 0) + 1);
    return [...counts.entries()].map(([id, files]) => ({ id, files })).sort((a, b) => b.files - a.files);
  }
}

const PROSE = new Set([
  'how', 'what', 'where', 'when', 'why', 'who', 'which', 'does', 'the', 'this', 'that', 'there', 'with', 'from', 'into', 'about', 'should',
  'could', 'would', 'have', 'comment', 'quoi', 'quand', 'pourquoi', 'quel', 'quelle', 'quels', 'quelles', 'est', 'sont', 'dans', 'avec',
  'pour', 'les', 'des', 'une', 'faire', 'fait',
]);

/** camelCase, PascalCase with two humps, snake_case, or a capitalised word that is not the first of the sentence. */
function looksLikeIdentifier(word: string, firstWord: boolean): boolean {
  if (PROSE.has(word.toLowerCase())) return false;
  if (/[a-z][A-Z]/.test(word) || word.includes('_')) return true;
  return !firstWord && /^[A-Z]/.test(word) && word.length >= 4;
}

function collectReferences(text: string, languageId: string): string[] {
  const { masked } = maskCode(text, languageId);
  const seen = new Set<string>();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) && seen.size < MAX_REFERENCES) {
    const w = m[0];
    // Types (capitalised) and long function names are the useful graph edges.
    if ((w.length >= 3 && /^[A-Z]/.test(w)) || w.length >= 8) seen.add(w);
  }
  return [...seen];
}
