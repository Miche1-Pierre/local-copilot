// "Neighbouring tabs" retrieval: find the window of an open file that looks most
// like the code around the cursor (Jaccard similarity over identifier sets).

const COMMON = new Set([
  'the', 'and', 'for', 'var', 'let', 'const', 'new', 'return', 'public', 'private', 'protected', 'static', 'void', 'int', 'string', 'bool',
  'true', 'false', 'null', 'none', 'self', 'this', 'def', 'function', 'class', 'import', 'from', 'using', 'namespace', 'else', 'elif',
  'while', 'foreach', 'float', 'double', 'async', 'await', 'export', 'default', 'case', 'break', 'continue', 'try', 'catch', 'finally',
  'throw', 'struct', 'interface', 'override', 'virtual', 'readonly', 'get', 'set', 'value', 'not', 'pass', 'with', 'yield', 'lambda',
]);

export function similarityTokens(text: string): Set<string> {
  const out = new Set<string>();
  const re = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const w = m[0].toLowerCase();
    if (!COMMON.has(w)) out.add(w);
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface WindowMatch {
  startLine: number;
  endLine: number;
  score: number;
}

/** Precomputed sliding windows of one document, reusable across keystrokes. */
export class WindowIndex {
  private readonly windows: { startLine: number; endLine: number; tokens: Set<string> }[] = [];

  constructor(
    readonly lines: string[],
    windowLines = 30,
    stride = 10,
  ) {
    for (let start = 0; start < lines.length; start += stride) {
      const end = Math.min(lines.length, start + windowLines);
      this.windows.push({ startLine: start, endLine: end - 1, tokens: similarityTokens(lines.slice(start, end).join('\n')) });
      if (end >= lines.length) break;
    }
  }

  best(reference: ReadonlySet<string>, exclude?: { startLine: number; endLine: number }): WindowMatch | undefined {
    let best: WindowMatch | undefined;
    for (const w of this.windows) {
      if (exclude && w.startLine <= exclude.endLine && w.endLine >= exclude.startLine) continue;
      const score = jaccard(reference, w.tokens);
      if (!best || score > best.score) best = { startLine: w.startLine, endLine: w.endLine, score };
    }
    return best;
  }
}
