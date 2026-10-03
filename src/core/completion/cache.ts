import type { ProcessedCompletion } from '../fim/postprocess';

interface Entry {
  docKey: string;
  offset: number;
  /** Last characters of the prefix when the completion was computed. */
  prefixTail: string;
  suffixKey: string;
  result: ProcessedCompletion;
  model: string;
}

const TAIL = 400;
const MAX_TYPEAHEAD = 200;

/**
 * Completion cache with type-ahead: when the user types characters that match
 * the beginning of a cached suggestion, the remainder is served instantly
 * without asking the model again.
 */
export class CompletionCache {
  private entries: Entry[] = [];

  constructor(private readonly capacity = 64) {}

  lookup(docKey: string, offset: number, prefix: string, suffixKey: string, model: string): ProcessedCompletion | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.docKey !== docKey || e.suffixKey !== suffixKey || e.model !== model) continue;
      const typed = offset - e.offset;
      if (typed < 0 || typed > MAX_TYPEAHEAD) continue;
      const before = prefix.slice(0, prefix.length - typed);
      if (!before.endsWith(e.prefixTail)) continue;
      if (typed === 0) return e.result;
      const delta = prefix.slice(prefix.length - typed);
      if (delta.includes('\n') || !e.result.text.startsWith(delta)) continue;
      const rest = e.result.text.slice(delta.length);
      if (!rest.trim()) continue;
      return { text: rest, replaceLineSuffix: e.result.replaceLineSuffix };
    }
    return undefined;
  }

  store(docKey: string, offset: number, prefix: string, suffixKey: string, model: string, result: ProcessedCompletion): void {
    this.entries.push({ docKey, offset, prefixTail: prefix.slice(-TAIL), suffixKey, result, model });
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }

  clear(): void {
    this.entries = [];
  }
}

export function suffixKeyOf(suffix: string): string {
  return suffix.slice(0, 200);
}
