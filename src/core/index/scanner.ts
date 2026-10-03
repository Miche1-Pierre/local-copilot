// A small multi-language lexer that classifies every character as code, comment
// or string. Structural scanners (symbols, imports, security rules) run on the
// "masked" text so braces, keywords or quotes inside strings and comments never
// fool them.

export const CharKind = { Code: 0, Comment: 1, StringContent: 2, StringDelimiter: 3 } as const;
export type CharKind = (typeof CharKind)[keyof typeof CharKind];

export interface MaskResult {
  /** Same length as the input. Comments and string contents become spaces; newlines and quote characters are kept. */
  masked: string;
  kinds: Uint8Array;
}

interface LexConfig {
  line: string[];
  block: [string, string][];
  nestedBlock?: boolean;
  quotes: string[];
  /** How a single quote is treated when it is not a string quote. */
  apostrophe?: 'char' | 'rust' | 'code';
  triple?: boolean;
  template?: boolean;
  rawBacktick?: boolean;
  verbatim?: boolean;
  rustRaw?: boolean;
  luaLong?: boolean;
  regex?: boolean;
  /** '#' starts a comment only at line start or after whitespace (shell). */
  hashNeedsSpace?: boolean;
  /** Plain quoted strings may contain raw newlines. */
  multilineStrings?: boolean;
}

const C_BLOCK: [string, string][] = [['/*', '*/']];

function configFor(languageId: string): LexConfig {
  switch (languageId) {
    case 'typescript':
    case 'typescriptreact':
    case 'javascript':
    case 'javascriptreact':
    case 'vue':
    case 'svelte':
    case 'astro':
      return { line: ['//'], block: C_BLOCK, quotes: ['"', "'"], template: true, regex: true };
    case 'csharp':
      return { line: ['//'], block: C_BLOCK, quotes: ['"'], apostrophe: 'char', verbatim: true, triple: true };
    case 'java':
    case 'kotlin':
    case 'scala':
      return { line: ['//'], block: C_BLOCK, quotes: ['"'], apostrophe: 'char', triple: true, nestedBlock: languageId !== 'java' };
    case 'swift':
      return { line: ['//'], block: C_BLOCK, quotes: ['"'], apostrophe: 'code', triple: true, nestedBlock: true };
    case 'dart':
    case 'groovy':
      return { line: ['//'], block: C_BLOCK, quotes: ['"', "'"], triple: true };
    case 'go':
      return { line: ['//'], block: C_BLOCK, quotes: ['"'], apostrophe: 'char', rawBacktick: true };
    case 'rust':
      return { line: ['//'], block: C_BLOCK, quotes: ['"'], apostrophe: 'rust', rustRaw: true, nestedBlock: true, multilineStrings: true };
    case 'c':
    case 'cpp':
    case 'objective-c':
    case 'objective-cpp':
    case 'hlsl':
    case 'shaderlab':
    case 'glsl':
    case 'proto3':
    case 'zig':
      return { line: ['//'], block: C_BLOCK, quotes: ['"'], apostrophe: 'char' };
    case 'php':
      return { line: ['//', '#'], block: C_BLOCK, quotes: ['"', "'"], multilineStrings: true };
    case 'python':
    case 'gdscript':
      return { line: ['#'], block: [], quotes: ['"', "'"], triple: true };
    case 'ruby':
    case 'elixir':
      return { line: ['#'], block: [], quotes: ['"', "'"], triple: languageId === 'elixir', multilineStrings: true };
    case 'lua':
      return { line: ['--'], block: [['--[[', ']]']], quotes: ['"', "'"], luaLong: true };
    case 'shellscript':
    case 'perl':
    case 'r':
    case 'julia':
    case 'nim':
    case 'dockerfile':
    case 'makefile':
      return { line: ['#'], block: [], quotes: ['"', "'"], hashNeedsSpace: languageId === 'shellscript', multilineStrings: true };
    case 'powershell':
      return { line: ['#'], block: [['<#', '#>']], quotes: ['"', "'"], multilineStrings: true };
    case 'sql':
      return { line: ['--'], block: C_BLOCK, quotes: ["'", '"'], multilineStrings: true };
    case 'css':
      return { line: [], block: C_BLOCK, quotes: ['"', "'"] };
    case 'scss':
    case 'less':
      return { line: ['//'], block: C_BLOCK, quotes: ['"', "'"] };
    case 'haskell':
      return { line: ['--'], block: [['{-', '-}']], quotes: ['"'], nestedBlock: true, apostrophe: 'code' };
    case 'ocaml':
      return { line: [], block: [['(*', '*)']], quotes: ['"'], nestedBlock: true, apostrophe: 'code' };
    case 'fsharp':
      return { line: ['//'], block: [['(*', '*)']], quotes: ['"'], triple: true, apostrophe: 'code' };
    case 'vb':
      return { line: ["'"], block: [], quotes: ['"'] };
    case 'html':
    case 'xml':
    case 'markdown':
      return { line: [], block: [['<!--', '-->']], quotes: [] };
    case 'yaml':
    case 'toml':
    case 'graphql':
      return { line: ['#'], block: [], quotes: ['"', "'"], hashNeedsSpace: true };
    case 'ini':
      return { line: [';', '#'], block: [], quotes: ['"'] };
    case 'json':
      return { line: [], block: [], quotes: ['"'] };
    case 'jsonc':
      return { line: ['//'], block: C_BLOCK, quotes: ['"'] };
    default:
      return { line: ['//', '#'], block: C_BLOCK, quotes: ['"', "'"] };
  }
}

const REGEX_PRECEDERS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

function isIdentChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_$]/.test(ch);
}

export function maskCode(text: string, languageId: string): MaskResult {
  const cfg = configFor(languageId);
  const n = text.length;
  const kinds = new Uint8Array(n);
  const templateStack: number[] = [];
  let braceDepth = 0;
  let i = 0;

  const mark = (from: number, to: number, kind: CharKind) => kinds.fill(kind, from, Math.min(to, n));

  const scanQuoted = (start: number, quote: string, escapes: boolean, singleLine: boolean): number => {
    kinds[start] = CharKind.StringDelimiter;
    let j = start + 1;
    while (j < n) {
      const c = text[j];
      if (escapes && c === '\\') {
        mark(j, j + 2, CharKind.StringContent);
        j += 2;
        continue;
      }
      if (c === quote) {
        kinds[j] = CharKind.StringDelimiter;
        return j + 1;
      }
      if (c === '\n' && singleLine) return j; // unterminated: stop at end of line
      kinds[j] = CharKind.StringContent;
      j++;
    }
    return n;
  };

  const scanUntilDelimiter = (start: number, openLen: number, close: string, escapes: boolean): number => {
    mark(start, start + openLen, CharKind.StringDelimiter);
    let j = start + openLen;
    while (j < n) {
      if (escapes && text[j] === '\\') {
        mark(j, j + 2, CharKind.StringContent);
        j += 2;
        continue;
      }
      if (text.startsWith(close, j)) {
        mark(j, j + close.length, CharKind.StringDelimiter);
        return j + close.length;
      }
      kinds[j] = CharKind.StringContent;
      j++;
    }
    return n;
  };

  const scanVerbatim = (start: number): number => {
    // @"...", $@"...", @$"..." : "" is an escaped quote, no backslash escapes.
    let j = start;
    while (text[j] !== '"') kinds[j++] = CharKind.StringDelimiter;
    kinds[j++] = CharKind.StringDelimiter;
    while (j < n) {
      if (text[j] === '"') {
        if (text[j + 1] === '"') {
          mark(j, j + 2, CharKind.StringContent);
          j += 2;
          continue;
        }
        kinds[j] = CharKind.StringDelimiter;
        return j + 1;
      }
      kinds[j++] = CharKind.StringContent;
    }
    return n;
  };

  const scanTemplate = (start: number): number => {
    let j = start;
    while (j < n) {
      const c = text[j];
      if (c === '\\') {
        mark(j, j + 2, CharKind.StringContent);
        j += 2;
        continue;
      }
      if (c === '`') {
        kinds[j] = CharKind.StringDelimiter;
        return j + 1;
      }
      if (c === '$' && text[j + 1] === '{') {
        mark(j, j + 2, CharKind.StringDelimiter);
        templateStack.push(braceDepth);
        return j + 2;
      }
      kinds[j++] = CharKind.StringContent;
    }
    return n;
  };

  const scanBlockComment = (start: number, open: string, close: string): number => {
    let depth = 1;
    let j = start + open.length;
    while (j < n && depth > 0) {
      if (cfg.nestedBlock && text.startsWith(open, j)) {
        depth++;
        j += open.length;
      } else if (text.startsWith(close, j)) {
        depth--;
        j += close.length;
      } else j++;
    }
    mark(start, j, CharKind.Comment);
    return j;
  };

  const looksLikeRegex = (start: number): boolean => {
    const next = text[start + 1];
    if (next === '/' || next === '*' || next === undefined) return false;
    let p = start - 1;
    while (p >= 0 && (text[p] === ' ' || text[p] === '\t' || text[p] === '\r' || text[p] === '\n')) p--;
    if (p < 0) return true;
    if (kinds[p] !== CharKind.Code) return false;
    if (REGEX_PRECEDERS.has(text[p])) return true;
    if (isIdentChar(text[p])) {
      let s = p;
      while (s > 0 && isIdentChar(text[s - 1])) s--;
      return REGEX_KEYWORDS.has(text.slice(s, p + 1));
    }
    return false;
  };

  const scanRegex = (start: number): number => {
    let j = start + 1;
    let inClass = false;
    while (j < n) {
      const c = text[j];
      if (c === '\n') return -1;
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      j++;
    }
    if (j >= n) return -1;
    kinds[start] = CharKind.StringDelimiter;
    mark(start + 1, j, CharKind.StringContent);
    kinds[j] = CharKind.StringDelimiter;
    return j + 1;
  };

  while (i < n) {
    const ch = text[i];

    if (cfg.template && templateStack.length > 0 && ch === '}' && braceDepth === templateStack[templateStack.length - 1]) {
      templateStack.pop();
      kinds[i] = CharKind.StringDelimiter;
      i = scanTemplate(i + 1);
      continue;
    }

    const block = cfg.block.find(([open]) => text.startsWith(open, i));
    if (block) {
      i = scanBlockComment(i, block[0], block[1]);
      continue;
    }

    const line = cfg.line.find((s) => text.startsWith(s, i));
    if (line && !(cfg.hashNeedsSpace && line === '#' && i > 0 && !/\s/.test(text[i - 1]))) {
      const end = text.indexOf('\n', i);
      const e = end < 0 ? n : end;
      mark(i, e, CharKind.Comment);
      i = e;
      continue;
    }

    if (cfg.triple && (text.startsWith('"""', i) || (cfg.quotes.includes("'") && text.startsWith("'''", i)))) {
      const delim = text.slice(i, i + 3);
      i = scanUntilDelimiter(i, 3, delim, languageId === 'python' || languageId === 'gdscript' || languageId === 'elixir');
      continue;
    }

    if (cfg.verbatim && (ch === '@' || ch === '$') && /^(@\$?|\$@)"/.test(text.slice(i, i + 3))) {
      i = scanVerbatim(i);
      continue;
    }

    if (cfg.rustRaw && (ch === 'r' || ch === 'b') && !isIdentChar(text[i - 1])) {
      const m = /^b?r(#*)"/.exec(text.slice(i, i + 64));
      if (m) {
        i = scanUntilDelimiter(i, m[0].length, `"${m[1]}`, false);
        continue;
      }
    }

    if (cfg.luaLong && ch === '[') {
      const m = /^\[(=*)\[/.exec(text.slice(i, i + 16));
      if (m) {
        i = scanUntilDelimiter(i, m[0].length, `]${m[1]}]`, false);
        continue;
      }
    }

    if (cfg.template && ch === '`') {
      kinds[i] = CharKind.StringDelimiter;
      i = scanTemplate(i + 1);
      continue;
    }

    if (cfg.rawBacktick && ch === '`') {
      i = scanUntilDelimiter(i, 1, '`', false);
      continue;
    }

    if (cfg.quotes.includes(ch)) {
      // An unterminated quote ends at the end of the line unless the language allows
      // multi-line strings, so one stray quote never masks the rest of the file.
      i = scanQuoted(i, ch, true, !cfg.multilineStrings);
      continue;
    }

    if (ch === "'" && (cfg.apostrophe === 'char' || cfg.apostrophe === 'rust')) {
      // Char literal: short and closed on the same line. Otherwise a Rust lifetime,
      // a C++14 digit separator (1'000) or stray text: leave as code.
      const m = /^'(?:\\(?:x[0-9a-fA-F]{1,4}|u\{?[0-9a-fA-F]{1,6}\}?|.)|[^\\'\n]{1,2})'/.exec(text.slice(i, i + 14));
      if (m && !(/\d/.test(text[i - 1] ?? '') && cfg.apostrophe === 'char')) {
        kinds[i] = CharKind.StringDelimiter;
        mark(i + 1, i + m[0].length - 1, CharKind.StringContent);
        kinds[i + m[0].length - 1] = CharKind.StringDelimiter;
        i += m[0].length;
        continue;
      }
      i++;
      continue;
    }

    if (cfg.regex && ch === '/' && looksLikeRegex(i)) {
      const end = scanRegex(i);
      if (end > 0) {
        i = end;
        continue;
      }
    }

    if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth--;
    i++;
  }

  return { masked: buildMasked(text, kinds), kinds };
}

function buildMasked(text: string, kinds: Uint8Array): string {
  const parts: string[] = [];
  let runStart = 0;
  const flush = (end: number, kind: number) => {
    if (end <= runStart) return;
    const slice = text.slice(runStart, end);
    parts.push(kind === CharKind.Code || kind === CharKind.StringDelimiter ? slice : slice.replace(/[^\n]/g, ' '));
  };
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || kinds[i] !== kinds[runStart]) {
      flush(i, kinds[runStart]);
      runStart = i;
    }
  }
  return parts.join('');
}

export interface CommentLine {
  /** 0-based line number. */
  line: number;
  /** Comment text without markers (//, #, /*, *, --, <!--). */
  text: string;
  /** True when the line holds nothing but the comment. */
  fullLine: boolean;
}

/** Lines that contain comments, with markers stripped. */
export function commentLines(text: string, languageId: string, mask?: MaskResult): CommentLine[] {
  const { kinds } = mask ?? maskCode(text, languageId);
  const out: CommentLine[] = [];
  let offset = 0;
  const lines = text.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    const lineText = lines[ln];
    let commentStart = -1;
    let hasCode = false;
    for (let c = 0; c < lineText.length; c++) {
      const k = kinds[offset + c];
      if (k === CharKind.Comment) {
        if (commentStart < 0) commentStart = c;
      } else if (lineText[c] !== ' ' && lineText[c] !== '\t' && lineText[c] !== '\r' && commentStart < 0) {
        hasCode = true;
      }
    }
    if (commentStart >= 0) {
      const raw = lineText.slice(commentStart);
      out.push({ line: ln, text: stripCommentMarkers(raw), fullLine: !hasCode });
    }
    offset += lineText.length + 1;
  }
  return out;
}

export function stripCommentMarkers(raw: string): string {
  return raw
    .replace(/^\s*(\/\/\/?|\/\*+|\*\/|\*|#+|--+(\[\[)?|<!--|<#|REM\b|'|;+|\(\*)\s?/, '')
    .replace(/\s*(\*\/|-->|#>|\]\]|\*\))\s*$/, '')
    .trimEnd();
}
