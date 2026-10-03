// Robust parsing of model answers: code fences, loose JSON, reasoning tags.

export interface CodeBlock {
  lang: string;
  code: string;
}

/** Removes <think>…</think> blocks (and an unterminated one while streaming). */
export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/^\s*<think>[\s\S]*$/, '');
}

export function extractCodeBlocks(text: string): CodeBlock[] {
  const out: CodeBlock[] = [];
  const re = /(^|\n)[ \t]*(```|~~~)[ \t]*([\w#+.-]*)[^\n]*\n([\s\S]*?)(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ lang: m[3].toLowerCase(), code: m[4] });
    if (m[5] === '') break;
  }
  return out;
}

/**
 * The code the model meant to produce: the fenced block matching the language,
 * else the largest block, else the whole answer when it is plain code.
 */
export function primaryCode(text: string, preferLang?: string): string | undefined {
  const cleaned = stripThinkTags(text);
  const blocks = extractCodeBlocks(cleaned);
  if (blocks.length === 0) {
    const t = cleaned.trim();
    return t.length > 0 ? t : undefined;
  }
  const aliases = preferLang ? languageAliases(preferLang) : [];
  const matching = blocks.filter((b) => aliases.includes(b.lang));
  const pool = matching.length > 0 ? matching : blocks;
  return pool.reduce((a, b) => (b.code.length > a.code.length ? b : a)).code.replace(/\s+$/, '');
}

function languageAliases(languageId: string): string[] {
  const map: Record<string, string[]> = {
    csharp: ['csharp', 'cs', 'c#'],
    typescript: ['typescript', 'ts'],
    typescriptreact: ['tsx', 'typescript', 'ts'],
    javascript: ['javascript', 'js'],
    javascriptreact: ['jsx', 'javascript', 'js'],
    python: ['python', 'py'],
    cpp: ['cpp', 'c++', 'cc'],
    shellscript: ['bash', 'sh', 'shell', 'zsh'],
    powershell: ['powershell', 'ps1', 'pwsh'],
    rust: ['rust', 'rs'],
    go: ['go', 'golang'],
    kotlin: ['kotlin', 'kt'],
    ruby: ['ruby', 'rb'],
  };
  return map[languageId] ?? [languageId];
}

/** Parses JSON from a model answer that may wrap it in prose or fences, with trailing commas. */
export function parseJsonLoose<T>(text: string): T | undefined {
  const cleaned = stripThinkTags(text).trim();
  const candidates: string[] = [cleaned];
  const fenced = extractCodeBlocks(cleaned).find((b) => b.lang === 'json' || b.code.trim().startsWith('{'));
  if (fenced) candidates.push(fenced.code);
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));
  for (const c of candidates) {
    for (const variant of [c, c.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        return JSON.parse(variant) as T;
      } catch {
        /* try next */
      }
    }
  }
  return undefined;
}

/**
 * Models are unreliable with line numbers. Given the excerpt they quote, find
 * the real line near their guess. `lines` are the document lines (0-based
 * result); `approxLine` is 0-based.
 */
export function locateExcerpt(lines: string[], excerpt: string | undefined, approxLine: number, window = 25): number {
  const clamped = Math.max(0, Math.min(lines.length - 1, approxLine));
  const needle = excerpt?.trim().replace(/^\d+\|\s?/, '').trim();
  if (!needle || needle.length < 4) return clamped;
  let best = -1;
  let bestDist = Infinity;
  for (let i = Math.max(0, clamped - window); i <= Math.min(lines.length - 1, clamped + window); i++) {
    const hay = lines[i].trim();
    if (!hay) continue;
    if (hay.includes(needle) || (needle.includes(hay) && hay.length >= 8)) {
      const d = Math.abs(i - clamped);
      if (d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
  }
  return best >= 0 ? best : clamped;
}
