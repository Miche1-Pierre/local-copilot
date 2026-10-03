/** FNV-1a 32-bit hash, hex encoded. Fast, stable, not cryptographic. */
export function hashString(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function normalizeEol(text: string): string {
  return text.indexOf('\r') >= 0 ? text.replace(/\r\n?/g, '\n') : text;
}

export function leadingWhitespace(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

/** Visual indentation width (tabs count as `tabSize`). */
export function indentWidth(line: string, tabSize = 4): number {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') w += 1;
    else if (ch === '\t') w += tabSize - (w % tabSize);
    else break;
  }
  return w;
}

export function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Prefixes each line with its 1-based number: "  12| code". */
export function withLineNumbers(text: string, firstLine = 1): string {
  const lines = text.split('\n');
  const width = String(firstLine + lines.length - 1).length;
  return lines.map((l, i) => `${String(firstLine + i).padStart(width)}| ${l}`).join('\n');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}
