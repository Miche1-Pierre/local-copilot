// Splits files into retrieval chunks aligned on symbols when possible.

import { hashString } from '../util/text';
import { CALLABLE_KINDS, TYPE_KINDS, type SymbolInfo } from './symbols';

export interface Chunk {
  /** `${path}#${startLine}-${endLine}` */
  id: string;
  path: string;
  /** 0-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Symbol the chunk is centred on, if any (e.g. "PlayerHealth.TakeDamage"). */
  symbol?: string;
  /** Content hash, used to detect stale embeddings. */
  hash: string;
}

export interface ChunkOptions {
  maxLines: number;
  windowLines: number;
  overlap: number;
}

const DEFAULTS: ChunkOptions = { maxLines: 80, windowLines: 50, overlap: 10 };

export function chunkFile(path: string, text: string, symbols: SymbolInfo[], options: Partial<ChunkOptions> = {}): Chunk[] {
  const opts = { ...DEFAULTS, ...options };
  const lines = text.split('\n');
  const covered = new Uint8Array(lines.length);
  const ranges: { start: number; end: number; symbol?: string }[] = [];

  const qualified = (s: SymbolInfo) => (s.container ? `${s.container}.${s.name}` : s.name);
  const addWindowed = (start: number, end: number, symbol?: string) => {
    if (end - start + 1 <= opts.maxLines) {
      ranges.push({ start, end, symbol });
      return;
    }
    const step = Math.max(1, opts.windowLines - opts.overlap);
    for (let s = start; s <= end; s += step) {
      ranges.push({ start: s, end: Math.min(end, s + opts.windowLines - 1), symbol });
      if (s + opts.windowLines - 1 >= end) break;
    }
  };

  // 1. Callables and sections are the natural retrieval unit.
  for (const s of symbols) {
    if (!CALLABLE_KINDS.has(s.kind) && s.kind !== 'section') continue;
    addWindowed(s.startLine, s.endLine, qualified(s));
    covered.fill(1, s.startLine, s.endLine + 1);
  }
  // 2. Type headers: declaration + fields up to the first member already covered.
  for (const s of symbols) {
    if (!TYPE_KINDS.has(s.kind) || s.kind === 'namespace') continue;
    let end = s.declLine;
    while (end < s.endLine && !covered[end + 1] && end - s.startLine < opts.maxLines - 1) end++;
    if (end > s.startLine) {
      ranges.push({ start: s.startLine, end, symbol: qualified(s) });
      covered.fill(1, s.startLine, end + 1);
    }
  }
  // 3. Everything else (top-level code, small files) in windows.
  let runStart = -1;
  for (let i = 0; i <= lines.length; i++) {
    const free = i < lines.length && !covered[i];
    if (free && runStart < 0) runStart = i;
    if (!free && runStart >= 0) {
      const slice = lines.slice(runStart, i).join('\n');
      if (slice.trim().length > 20) addWindowed(runStart, i - 1);
      runStart = -1;
    }
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  return ranges.map((r) => {
    const content = lines.slice(r.start, r.end + 1).join('\n');
    return { id: `${path}#${r.start}-${r.end}`, path, startLine: r.start, endLine: r.end, symbol: r.symbol, hash: hashString(content) };
  });
}

export function chunkText(lines: string[], chunk: Chunk): string {
  return lines.slice(chunk.startLine, chunk.endLine + 1).join('\n');
}
