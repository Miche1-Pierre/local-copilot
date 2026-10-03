// Lexical retrieval tuned for code: identifiers are indexed whole and split into
// their camelCase / snake_case parts, so "takeDamage" matches "damage taken".

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'with', 'as', 'by', 'be', 'this', 'that', 'at', 'from',
  'if', 'else', 'return', 'var', 'let', 'const', 'new', 'public', 'private', 'protected', 'static', 'void', 'int', 'string', 'bool',
  'true', 'false', 'null', 'none', 'self', 'this', 'def', 'function', 'class', 'import', 'using', 'namespace', 'end', 'do', 'then',
  'where', 'what', 'how', 'which', 'when', 'does', 'are', 'can', 'there', 'code', 'file', 'les', 'des', 'est', 'une', 'pour', 'dans',
]);

export function splitIdentifier(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-$]+/)
    .map((p) => p.toLowerCase())
    .filter((p) => p.length >= 2);
}

export function tokenizeCode(text: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const word = m[0];
    if (word.length < 2) continue;
    const lower = word.toLowerCase();
    if (!STOPWORDS.has(lower)) out.push(lower);
    const parts = splitIdentifier(word);
    if (parts.length > 1) for (const p of parts) if (!STOPWORDS.has(p)) out.push(p);
  }
  return out;
}

interface DocStats {
  length: number;
  tf: Map<string, number>;
}

export class Bm25Index {
  private readonly docs = new Map<string, DocStats>();
  private readonly postings = new Map<string, Set<string>>();
  private totalLength = 0;

  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  get size(): number {
    return this.docs.size;
  }

  add(docId: string, tokens: string[]): void {
    if (this.docs.has(docId)) this.remove(docId);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.set(docId, { length: tokens.length, tf });
    this.totalLength += tokens.length;
    for (const term of tf.keys()) {
      let set = this.postings.get(term);
      if (!set) this.postings.set(term, (set = new Set()));
      set.add(docId);
    }
  }

  remove(docId: string): void {
    const doc = this.docs.get(docId);
    if (!doc) return;
    for (const term of doc.tf.keys()) {
      const set = this.postings.get(term);
      set?.delete(docId);
      if (set && set.size === 0) this.postings.delete(term);
    }
    this.totalLength -= doc.length;
    this.docs.delete(docId);
  }

  search(queryTokens: string[], limit: number, filter?: (docId: string) => boolean): { id: string; score: number }[] {
    const n = this.docs.size;
    if (n === 0) return [];
    const avgLen = this.totalLength / n;
    const scores = new Map<string, number>();
    for (const term of new Set(queryTokens)) {
      const set = this.postings.get(term);
      if (!set) continue;
      const idf = Math.log(1 + (n - set.size + 0.5) / (set.size + 0.5));
      for (const id of set) {
        if (filter && !filter(id)) continue;
        const doc = this.docs.get(id)!;
        const f = doc.tf.get(term) ?? 0;
        const s = (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * doc.length) / avgLen));
        scores.set(id, (scores.get(id) ?? 0) + s);
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/** Reciprocal rank fusion of several ranked lists. */
export function reciprocalRankFusion(lists: { id: string }[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, rank) => scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
