// In-memory vector store with a compact binary serialisation.
// Brute-force cosine search: 10k chunks x 1024 dims is a few milliseconds.

interface Entry {
  hash: string;
  vec: Float32Array;
}

export class VectorStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    public model = '',
    public dims = 0,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  has(id: string, hash: string): boolean {
    return this.entries.get(id)?.hash === hash;
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  set(id: string, hash: string, vector: number[]): void {
    if (this.dims === 0) this.dims = vector.length;
    if (vector.length !== this.dims) throw new Error(`Vector size ${vector.length} does not match store size ${this.dims}`);
    this.entries.set(id, { hash, vec: normalize(Float32Array.from(vector)) });
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  /** Drops vectors whose id is not in `keep`. */
  retain(keep: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) if (!keep.has(id)) this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
    this.dims = 0;
  }

  /** Takes over the content of another store (e.g. one loaded from disk). */
  replaceWith(other: VectorStore): void {
    this.entries.clear();
    this.model = other.model;
    this.dims = other.dims;
    for (const [id, e] of other.entries) this.entries.set(id, e);
  }

  search(query: number[], limit: number, filter?: (id: string) => boolean): { id: string; score: number }[] {
    if (this.entries.size === 0 || query.length !== this.dims) return [];
    const q = normalize(Float32Array.from(query));
    const out: { id: string; score: number }[] = [];
    for (const [id, e] of this.entries) {
      if (filter && !filter(id)) continue;
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += q[i] * e.vec[i];
      out.push({ id, score: dot });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  /** Layout: [u32 header length][header JSON utf8][f32 vectors…] */
  serialize(): Uint8Array {
    const ids = [...this.entries.keys()];
    const header = new TextEncoder().encode(JSON.stringify({ model: this.model, dims: this.dims, entries: ids.map((id) => [id, this.entries.get(id)!.hash]) }));
    const floats = new Float32Array(ids.length * this.dims);
    ids.forEach((id, i) => floats.set(this.entries.get(id)!.vec, i * this.dims));
    const out = new Uint8Array(4 + header.length + floats.byteLength);
    new DataView(out.buffer).setUint32(0, header.length, true);
    out.set(header, 4);
    out.set(new Uint8Array(floats.buffer), 4 + header.length);
    return out;
  }

  static deserialize(data: Uint8Array): VectorStore {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const headerLen = view.getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + headerLen))) as { model: string; dims: number; entries: [string, string][] };
    const store = new VectorStore(header.model, header.dims);
    const floatBytes = data.slice(4 + headerLen);
    const floats = new Float32Array(floatBytes.buffer, floatBytes.byteOffset, floatBytes.byteLength / 4);
    header.entries.forEach(([id, hash], i) => {
      store.entries.set(id, { hash, vec: floats.slice(i * header.dims, (i + 1) * header.dims) });
    });
    return store;
  }
}

function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/** Query/document prefixes expected by common embedding models. */
export function embeddingPrefixes(model: string): { query: string; document: string } {
  const m = model.toLowerCase();
  if (m.includes('nomic-embed')) return { query: 'search_query: ', document: 'search_document: ' };
  if (m.includes('qwen3-embedding')) {
    return { query: 'Instruct: Given a question about a code repository, retrieve the code or documentation that answers it\nQuery: ', document: '' };
  }
  if (m.includes('embeddinggemma')) return { query: 'task: code retrieval | query: ', document: 'title: none | text: ' };
  if (m.includes('mxbai-embed') || m.includes('snowflake-arctic')) return { query: 'Represent this sentence for searching relevant passages: ', document: '' };
  return { query: '', document: '' };
}
