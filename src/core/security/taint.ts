// Intra-function taint heuristic: which variables of a function may carry
// external data? Sources are the function's parameters and well-known request /
// input APIs; taint flows through simple assignments. No real data-flow
// analysis: just enough to rank a sink "fed by user input" above a constant.

import { escapeRegExp } from '../util/text';

export type TaintSource = 'parameter' | 'user-input';

export interface FunctionTaint {
  functionName?: string;
  tainted: Map<string, TaintSource>;
}

const USER_INPUT: Record<string, RegExp> = {
  python: /\brequest\.(?:args|form|values|json|get_json|data|cookies|headers|files|GET|POST|body|query_params|path_params)\b|(?<![\w.])input\s*\(|\bsys\.argv\b/,
  js: /\breq\.(?:query|body|params|headers|cookies|files)\b|\brequest\.(?:query|body|params|headers)\b|\bprocess\.argv\b|\blocation\.(?:search|hash|href|pathname)\b|\bdocument\.(?:cookie|URL|referrer)\b|\bwindow\.name\b|\bURLSearchParams\b|\bevent\.data\b|\bctx\.(?:query|params|request\.body)\b/,
  csharp: /\bRequest\.(?:Query|Form|Headers|Cookies|QueryString|Body|RouteValues)\b|\bHttpContext\.Request\b|\bConsole\.ReadLine\s*\(|\[From(?:Query|Body|Form|Route|Header)\]/,
  java: /\.getParameter(?:Values|Map)?\s*\(|\.getHeader\s*\(|\.getQueryString\s*\(|\.getCookies\s*\(|\.getInputStream\s*\(|@(?:RequestParam|PathVariable|RequestBody|RequestHeader)\b/,
  php: /\$_(?:GET|POST|REQUEST|COOKIE|SERVER|FILES)\b/,
  go: /\br\.URL\.Query\s*\(|\br\.(?:FormValue|PostFormValue)\s*\(|\br\.(?:Body|Form|PostForm|Header)\b|\bc\.(?:Query|Param|PostForm|DefaultQuery)\s*\(/,
  ruby: /\bparams\s*\[|\brequest\.(?:params|body|query_string)\b|\bcookies\s*\[/,
};

function inputKey(languageId: string): keyof typeof USER_INPUT | undefined {
  if (['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'vue', 'svelte', 'astro'].includes(languageId)) return 'js';
  if (['java', 'kotlin', 'scala', 'groovy'].includes(languageId)) return 'java';
  return languageId in USER_INPUT ? (languageId as keyof typeof USER_INPUT) : undefined;
}

export function userInputPattern(languageId: string): RegExp | undefined {
  const key = inputKey(languageId);
  return key ? USER_INPUT[key] : undefined;
}

/** Text between the parentheses of the parameter list (balanced), or undefined. */
function parameterList(signature: string, languageId: string): string | undefined {
  let start = signature.indexOf('(');
  if (languageId === 'go') {
    // func (r *Recv) Name[T any](params) → skip the receiver.
    const m = /^\s*func\s*(?:\([^)]*\)\s*)?[A-Za-z_]\w*\s*(?:\[[^\]]*\]\s*)?\(/.exec(signature);
    if (m) start = m[0].length - 1;
  }
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < signature.length; i++) {
    const c = signature[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return signature.slice(start + 1, i);
    }
  }
  return signature.slice(start + 1);
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of list) {
    if ('([{<'.includes(c)) depth++;
    else if (')]}>'.includes(c)) depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += c;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const IDENT = /[A-Za-z_$][\w$]*/g;

/** Index of the bracket closing the one at position 0. */
function matchingBracket(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if ('{['.includes(text[i])) depth++;
    else if ('}]'.includes(text[i]) && --depth === 0) return i;
  }
  return text.length;
}
const SKIP = new Set(['self', 'cls', 'this', 'mut', 'ref', 'out', 'in', 'params', 'final', 'const', 'readonly', 'public', 'private', 'protected', 'var', 'val']);

/** Parameter names of a function signature, for the common languages. */
export function parseParameters(signature: string, languageId: string): string[] {
  const list = parameterList(signature, languageId);
  if (!list) return [];
  const names: string[] = [];
  for (let raw of splitTopLevel(list)) {
    raw = raw
      .replace(/\[[^\]]*\]\s*/g, '') // C# attributes
      .replace(/@\w+(?:\([^)]*\))?\s*/g, '') // Java/Kotlin/TS annotations & decorators
      .replace(/^\s*(?:\*\*?|\.\.\.|&)\s*/, '')
      .trim();
    if (!raw) continue;
    if (languageId === 'php') {
      const m = /\$([A-Za-z_]\w*)/.exec(raw);
      if (m) names.push(m[1]);
      continue;
    }
    if (/^[{[]/.test(raw)) {
      // Destructuring: every identifier bound inside the pattern is tainted (its type annotation is not).
      const close = matchingBracket(raw);
      for (const id of raw.slice(1, close).match(IDENT) ?? []) if (!SKIP.has(id)) names.push(id);
      continue;
    }
    const noDefault = raw.split(/\s*=(?!>)/)[0];
    const colon = noDefault.indexOf(':');
    let candidate: string | undefined;
    if (colon > 0 && !['csharp', 'java', 'c', 'cpp', 'dart', 'groovy', 'go'].includes(languageId)) {
      // name: Type (Python, TS, Kotlin, Swift, Rust, Scala)
      candidate = noDefault.slice(0, colon).match(IDENT)?.filter((w) => !SKIP.has(w)).pop();
    } else if (languageId === 'go') {
      candidate = noDefault.match(IDENT)?.[0];
    } else {
      // Type name (C#, Java, C, C++, Dart): the last identifier.
      candidate = noDefault.replace(/<[^>]*>/g, ' ').match(IDENT)?.filter((w) => !SKIP.has(w)).pop();
    }
    if (candidate && !SKIP.has(candidate)) names.push(candidate);
  }
  return names;
}

const ASSIGN = /^\s*(?:(?:var|let|const|val|auto|final|my|local)\s+)?(?:[A-Za-z_][\w<>[\],.?]*\s+)?\$?([A-Za-z_]\w*)\s*(?::=|(?<![=!<>+\-*/%&|^])=(?![=>]))\s*(.+)$/;

const wordCache = new Map<string, RegExp>();
function word(name: string): RegExp {
  let re = wordCache.get(name);
  if (!re) {
    re = new RegExp(`(?<![\\w$])\\$?${escapeRegExp(name)}(?![\\w$])`);
    if (wordCache.size > 2000) wordCache.clear();
    wordCache.set(name, re);
  }
  return re;
}

/** Taint of every variable of the function spanning [startLine, endLine] (0-based, inclusive). */
export function computeFunctionTaint(text: string, languageId: string, startLine: number, endLine: number, signature: string, functionName?: string): FunctionTaint {
  const tainted = new Map<string, TaintSource>();
  for (const p of parseParameters(signature, languageId)) tainted.set(p, 'parameter');
  const userRe = userInputPattern(languageId);
  const lines = text.split('\n').slice(startLine, endLine + 1);
  for (let pass = 0; pass < 2; pass++) {
    for (const line of lines) {
      const m = ASSIGN.exec(line);
      if (!m) continue;
      const [, lhs, rhs] = m;
      let source: TaintSource | undefined;
      if (userRe?.test(rhs)) source = 'user-input';
      else {
        for (const [name, s] of tainted) {
          if (name === lhs || !word(name).test(rhs)) continue;
          source = s;
          if (s === 'user-input') break;
        }
      }
      if (source && tainted.get(lhs) !== 'user-input') tainted.set(lhs, source);
    }
  }
  return { functionName, tainted };
}

/** The most dangerous tainted value used on `line`, if any. */
export function findTaintedVariable(line: string, taint: FunctionTaint, languageId?: string): { variable: string; source: TaintSource } | undefined {
  const userRe = languageId ? userInputPattern(languageId) : undefined;
  const direct = userRe?.exec(line);
  if (direct) return { variable: direct[0].replace(/\s*\($/, ''), source: 'user-input' };
  let fallback: { variable: string; source: TaintSource } | undefined;
  for (const [name, source] of taint.tainted) {
    if (!word(name).test(line)) continue;
    if (source === 'user-input') return { variable: name, source };
    fallback ??= { variable: name, source };
  }
  return fallback;
}
