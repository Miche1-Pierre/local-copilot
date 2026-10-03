// Token budgeting without a tokenizer. Code averages ~3.3-3.8 characters per
// token on BPE vocabularies (Qwen, Llama, StarCoder); we use a conservative ratio.

const CHARS_PER_TOKEN = 3.4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function tokensToChars(tokens: number): number {
  return Math.floor(tokens * CHARS_PER_TOKEN);
}

/** Keeps the end of `text` within the budget, cutting at a line boundary when possible. */
export function takeLastTokens(text: string, maxTokens: number): string {
  const maxChars = tokensToChars(maxTokens);
  if (text.length <= maxChars) return text;
  const start = text.length - maxChars;
  const nl = text.indexOf('\n', start);
  // Never cut into the last line (the one the cursor is on).
  const lastNl = text.lastIndexOf('\n');
  if (nl >= 0 && nl < lastNl) return text.slice(nl + 1);
  return text.slice(start);
}

/** Keeps the start of `text` within the budget, cutting at a line boundary when possible. */
export function takeFirstTokens(text: string, maxTokens: number): string {
  const maxChars = tokensToChars(maxTokens);
  if (text.length <= maxChars) return text;
  const nl = text.lastIndexOf('\n', maxChars);
  return nl > 0 ? text.slice(0, nl + 1) : text.slice(0, maxChars);
}
