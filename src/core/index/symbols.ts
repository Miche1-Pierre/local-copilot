// Structural symbol extraction without a parser: declarations are recognised on
// the masked text (no strings/comments) and their extent comes from brace depth
// (C-like languages), indentation (Python, GDScript) or aligned `end` keywords.
// Precise enough for retrieval, outlines and "enclosing function" lookups.

import { collapseWhitespace, indentWidth, truncate } from '../util/text';
import { familyOf } from './languages';
import { CharKind, maskCode, stripCommentMarkers } from './scanner';

export type SymbolKind =
  | 'namespace'
  | 'module'
  | 'class'
  | 'struct'
  | 'interface'
  | 'enum'
  | 'record'
  | 'trait'
  | 'impl'
  | 'type'
  | 'function'
  | 'method'
  | 'constructor'
  | 'property'
  | 'field'
  | 'variable'
  | 'section';

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  /** First line, including attributes/decorators and the doc comment (0-based). */
  startLine: number;
  /** Line holding the declaration keyword/name. */
  declLine: number;
  endLine: number;
  container?: string;
  signature: string;
  doc?: string;
}

export const CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set(['function', 'method', 'constructor']);
export const TYPE_KINDS: ReadonlySet<SymbolKind> = new Set(['class', 'struct', 'interface', 'enum', 'record', 'trait', 'impl', 'type', 'namespace', 'module']);

export function extractSymbols(text: string, languageId: string): SymbolInfo[] {
  const family = familyOf(languageId);
  if (family === 'markdown') return extractMarkdownSections(text);
  if (family === 'python') return extractIndentSymbols(text, languageId);
  if (languageId === 'powershell' || family === 'c-like') {
    if (languageId === 'css' || languageId === 'scss' || languageId === 'less') return [];
    return extractBraceSymbols(text, languageId);
  }
  if (family === 'ruby' || family === 'lua' || family === 'shell') return extractEndSymbols(text, languageId);
  return [];
}

/** Innermost symbol whose range contains `line` (optionally restricted to some kinds). */
export function symbolAt(symbols: SymbolInfo[], line: number, kinds?: ReadonlySet<SymbolKind>): SymbolInfo | undefined {
  let best: SymbolInfo | undefined;
  for (const s of symbols) {
    if (line < s.startLine || line > s.endLine) continue;
    if (kinds && !kinds.has(s.kind)) continue;
    if (!best || s.endLine - s.startLine <= best.endLine - best.startLine) best = s;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Brace languages

interface Decl {
  name: string;
  kind: SymbolKind;
  container?: string;
}

interface MatchContext {
  /** Innermost open type symbol, when the current line is directly in its body. */
  typeBody?: SymbolInfo;
  /** Innermost open type symbol (direct or not). */
  enclosingType?: SymbolInfo;
  topLevel: boolean;
}

const CONTROL_WORDS = new Set([
  'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'catch', 'try', 'finally', 'using', 'lock', 'return', 'new', 'throw',
  'await', 'yield', 'goto', 'typeof', 'sizeof', 'nameof', 'default', 'checked', 'unchecked', 'fixed', 'when', 'base', 'this', 'super',
  'function', 'delete', 'void', 'in', 'of', 'is', 'as', 'with', 'echo', 'print', 'match', 'loop', 'defer', 'go', 'select', 'synchronized',
  'assert', 'static_assert', 'elif', 'until', 'unless', 'then', 'not', 'and', 'or', 'var', 'let', 'const', 'import', 'export', 'from',
  'package', 'operator', 'sealed', 'record', 'with', 'get', 'set', 'init', 'value', 'where',
]);

const CS_ATTRS = String.raw`(?:\[[^\]]*\]\s*)*`;
const CS_MODS = String.raw`(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new|partial|readonly|required|volatile|file|const|event)\s+)*`;
const TYPE_EXPR = String.raw`([\w<>\[\],.?()*&:\s]*?[\w>\]?)*&])`;

const RE = {
  csType: new RegExp(String.raw`^\s*${CS_ATTRS}${CS_MODS}(class|struct|interface|enum|record(?:\s+(?:struct|class))?)\s+([A-Za-z_]\w*)`),
  csNamespace: /^\s*namespace\s+([\w.]+)/,
  csDelegate: new RegExp(String.raw`^\s*${CS_ATTRS}${CS_MODS}delegate\s+${TYPE_EXPR}\s+([A-Za-z_]\w*)`),
  csMethod: new RegExp(String.raw`^\s*${CS_ATTRS}${CS_MODS}${TYPE_EXPR}\s+([A-Za-z_]\w*)\s*(?:<[^<>()]*>)?\s*\(`),
  csCtor: new RegExp(String.raw`^\s*${CS_ATTRS}(?:(?:public|private|protected|internal|static|extern|unsafe)\s+)+~?([A-Za-z_]\w*)\s*\(`),
  csProperty: new RegExp(String.raw`^\s*${CS_ATTRS}${CS_MODS}${TYPE_EXPR}\s+([A-Za-z_]\w*)\s*(\{|=>|$)`),
  csField: new RegExp(String.raw`^\s*${CS_ATTRS}${CS_MODS}${TYPE_EXPR}\s+([A-Za-z_]\w*)\s*(=(?!>)|;|,)`),

  javaType: /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record|@interface)\s+([A-Za-z_]\w*)/,
  javaMethod: new RegExp(String.raw`^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]+>\s+)?${TYPE_EXPR}\s+([A-Za-z_]\w*)\s*\(`),
  javaCtor: /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected)\s+)+([A-Z]\w*)\s*\(/,
  javaField: new RegExp(String.raw`^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|static|final|transient|volatile)\s+)*${TYPE_EXPR}\s+([A-Za-z_]\w*)\s*(=|;)`),

  ktFun: /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|open|override|abstract|suspend|inline|operator|infix|tailrec|external|final|actual|expect)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.<>?]+\.)?([A-Za-z_]\w*)\s*\(/,
  ktType: /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|open|abstract|sealed|data|enum|inner|value|annotation|final|companion|actual|expect)\s+)*(class|interface|object)\s+([A-Za-z_]\w*)/,
  ktProp: /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|open|override|abstract|lateinit|const|final)\s+)*(?:val|var)\s+([A-Za-z_]\w*)/,

  tsFunction: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/,
  tsClass: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  tsInterface: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  tsType: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/,
  tsEnum: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
  tsNamespace: /^\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([\w$.]+)\s*\{/,
  tsArrow: /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)?\s*(?::[^=]+)?=>|\(|[A-Za-z_$][\w$]*\s*=>)/,
  tsExportConst: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  tsMethod: /^\s*(?:(?:public|private|protected|static|readonly|async|abstract|override|declare|get|set|accessor)\s+)*(#?[A-Za-z_$][\w$]*)\s*[?!]?\s*(?:<[^>]*>)?\s*\(/,
  tsMember: /^\s*(?:(?:public|private|protected|static|readonly|abstract|override|declare|accessor)\s+)*(#?[A-Za-z_$][\w$]*)\s*[?!]?\s*[:=]/,

  goFunc: /^func\s+(?:\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)[^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]/,
  goType: /^type\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?(struct|interface)?/,
  goVar: /^(?:var|const)\s+([A-Za-z_]\w*)/,
  goField: /^\s+([A-Za-z_]\w*)\s+[\w*[\]{}.]+/,

  rsFn: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/,
  rsType: /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|union|type|mod)\s+([A-Za-z_]\w*)/,
  rsImpl: /^\s*impl(?:\s*<[^{]*?>)?\s+(?:([\w:]+(?:<[^{]*?>)?)\s+for\s+)?([\w:]+)/,
  rsMacro: /^\s*macro_rules!\s*([A-Za-z_]\w*)/,

  cType: /^\s*(?:template\s*<[^>]*>\s*)?(?:typedef\s+)?(class|struct|union|enum(?:\s+class)?|namespace)\s+([A-Za-z_]\w*)\s*(?:final\s*)?(?::[^;{]*)?(?:\{|$)/,
  cFunc: new RegExp(String.raw`^\s*(?:template\s*<[^>]*>\s*)?(?:(?:static|inline|extern|virtual|constexpr|explicit|friend|__declspec\([^)]*\))\s+)*${TYPE_EXPR}\s+\**&?\s*((?:[A-Za-z_]\w*::)*~?[A-Za-z_]\w*)\s*\(`),

  swiftFunc: /^\s*(?:@\w+\s+)*(?:(?:public|private|fileprivate|internal|open|static|class|override|final|mutating|nonmutating|async)\s+)*(?:func\s+([A-Za-z_]\w*)|(init)\s*[?!]?\s*\()/,
  swiftType: /^\s*(?:@\w+\s+)*(?:(?:public|private|fileprivate|internal|open|final|indirect)\s+)*(class|struct|enum|protocol|extension|actor)\s+([A-Za-z_][\w.]*)/,
  swiftProp: /^\s*(?:@\w+\s+)*(?:(?:public|private|fileprivate|internal|open|static|class|override|final|lazy|weak)\s+)*(?:var|let)\s+([A-Za-z_]\w*)/,

  phpFunc: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?([A-Za-z_]\w*)\s*\(/,
  phpType: /^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/,
  phpNamespace: /^\s*namespace\s+([\w\\]+)/,

  scalaDef: /^\s*(?:(?:override|private|protected|final|implicit|inline)\s+)*def\s+([A-Za-z_]\w*)/,
  scalaType: /^\s*(?:(?:case|abstract|sealed|final|implicit|private|protected)\s+)*(class|object|trait|enum)\s+([A-Za-z_]\w*)/,

  dartType: /^\s*(?:abstract\s+|base\s+|final\s+|sealed\s+|interface\s+)*(class|mixin|extension|enum)\s+([A-Za-z_]\w*)/,

  protoType: /^\s*(message|service|enum)\s+([A-Za-z_]\w*)/,
  protoRpc: /^\s*rpc\s+([A-Za-z_]\w*)\s*\(/,

  psFunc: /^\s*(?:function|filter)\s+([\w-]+)/i,
  zigFn: /^\s*(?:pub\s+)?(?:export\s+)?(?:inline\s+)?fn\s+([A-Za-z_]\w*)\s*\(/,
  zigType: /^\s*(?:pub\s+)?const\s+([A-Za-z_]\w*)\s*=\s*(?:packed\s+|extern\s+)?(struct|enum|union)/,
};

function isPlausibleCall(typeExpr: string, name: string): boolean {
  if (CONTROL_WORDS.has(name)) return false;
  const words = typeExpr.trim().split(/[\s<>[\](),.?*&:]+/).filter(Boolean);
  return !words.some((w) => CONTROL_WORDS.has(w) && w !== 'void');
}

function matchCSharp(line: string, ctx: MatchContext): Decl | undefined {
  let m = RE.csNamespace.exec(line);
  if (m) return { name: m[1], kind: 'namespace' };
  m = RE.csType.exec(line);
  if (m) {
    const k = m[1].startsWith('record') ? 'record' : (m[1] as SymbolKind);
    return { name: m[2], kind: k };
  }
  m = RE.csDelegate.exec(line);
  if (m) return { name: m[2], kind: 'type' };
  if (!ctx.enclosingType && !ctx.topLevel) return undefined;
  m = RE.csCtor.exec(line);
  if (m && ctx.typeBody && m[1] === ctx.typeBody.name) return { name: m[1], kind: 'constructor' };
  m = RE.csMethod.exec(line);
  if (m && isPlausibleCall(m[1], m[2])) return { name: m[2], kind: ctx.enclosingType ? 'method' : 'function' };
  if (ctx.typeBody) {
    m = RE.csField.exec(line);
    if (m && isPlausibleCall(m[1], m[2])) return { name: m[2], kind: 'field' };
    m = RE.csProperty.exec(line);
    if (m && isPlausibleCall(m[1], m[2]) && !/^\s*$/.test(m[1])) return { name: m[2], kind: 'property' };
  }
  return undefined;
}

function matchJava(line: string, ctx: MatchContext): Decl | undefined {
  let m = RE.javaType.exec(line);
  if (m) return { name: m[2], kind: m[1] === 'record' ? 'record' : m[1] === 'enum' ? 'enum' : m[1] === 'class' ? 'class' : 'interface' };
  if (!ctx.enclosingType) return undefined;
  m = RE.javaCtor.exec(line);
  if (m && ctx.typeBody && m[1] === ctx.typeBody.name) return { name: m[1], kind: 'constructor' };
  m = RE.javaMethod.exec(line);
  if (m && isPlausibleCall(m[1], m[2])) return { name: m[2], kind: 'method' };
  if (ctx.typeBody) {
    m = RE.javaField.exec(line);
    if (m && isPlausibleCall(m[1], m[2])) return { name: m[2], kind: 'field' };
  }
  return undefined;
}

function matchKotlin(line: string, ctx: MatchContext): Decl | undefined {
  let m = RE.ktType.exec(line);
  if (m) return { name: m[2], kind: m[1] === 'interface' ? 'interface' : 'class' };
  m = RE.ktFun.exec(line);
  if (m) return { name: m[1], kind: ctx.enclosingType ? 'method' : 'function' };
  if (ctx.typeBody || ctx.topLevel) {
    m = RE.ktProp.exec(line);
    if (m) return { name: m[1], kind: ctx.typeBody ? 'property' : 'variable' };
  }
  return undefined;
}

function matchTs(line: string, ctx: MatchContext): Decl | undefined {
  let m = RE.tsClass.exec(line);
  if (m) return { name: m[1], kind: 'class' };
  m = RE.tsInterface.exec(line);
  if (m) return { name: m[1], kind: 'interface' };
  m = RE.tsEnum.exec(line);
  if (m) return { name: m[1], kind: 'enum' };
  m = RE.tsNamespace.exec(line);
  if (m) return { name: m[1], kind: 'namespace' };
  m = RE.tsType.exec(line);
  if (m) return { name: m[1], kind: 'type' };
  m = RE.tsFunction.exec(line);
  if (m) return { name: m[1], kind: 'function' };
  if (ctx.typeBody) {
    m = RE.tsMethod.exec(line);
    if (m && !CONTROL_WORDS.has(m[1])) return { name: m[1], kind: m[1] === 'constructor' ? 'constructor' : 'method' };
    m = RE.tsMember.exec(line);
    if (m && !CONTROL_WORDS.has(m[1])) return { name: m[1], kind: 'property' };
    return undefined;
  }
  m = RE.tsArrow.exec(line);
  if (m) return { name: m[1], kind: 'function' };
  if (ctx.topLevel) {
    m = RE.tsExportConst.exec(line);
    if (m) return { name: m[1], kind: 'variable' };
  }
  return undefined;
}

function matchGo(line: string, ctx: MatchContext): Decl | undefined {
  let m = RE.goFunc.exec(line);
  if (m) return m[1] ? { name: m[2], kind: 'method', container: m[1] } : { name: m[2], kind: 'function' };
  m = RE.goType.exec(line);
  if (m) return { name: m[1], kind: m[2] === 'interface' ? 'interface' : m[2] === 'struct' ? 'struct' : 'type' };
  if (ctx.topLevel) {
    m = RE.goVar.exec(line);
    if (m) return { name: m[1], kind: 'variable' };
  }
  if (ctx.typeBody && ctx.typeBody.kind === 'struct') {
    m = RE.goField.exec(line);
    if (m) return { name: m[1], kind: 'field' };
  }
  return undefined;
}

function matchRust(line: string, ctx: MatchContext): Decl | undefined {
  let m = RE.rsImpl.exec(line);
  if (m) return { name: m[2].replace(/<.*$/, ''), kind: 'impl' };
  m = RE.rsType.exec(line);
  if (m) {
    const kinds: Record<string, SymbolKind> = { struct: 'struct', enum: 'enum', trait: 'trait', union: 'struct', type: 'type', mod: 'module' };
    return { name: m[2], kind: kinds[m[1]] };
  }
  m = RE.rsFn.exec(line);
  if (m) return { name: m[1], kind: ctx.enclosingType ? 'method' : 'function' };
  m = RE.rsMacro.exec(line);
  if (m) return { name: m[1], kind: 'function' };
  return undefined;
}

function matchC(line: string, ctx: MatchContext): Decl | undefined {
  if (/^\s*#/.test(line)) return undefined;
  let m = RE.cType.exec(line);
  if (m) {
    const k = m[1].startsWith('enum') ? 'enum' : m[1] === 'namespace' ? 'namespace' : m[1] === 'class' ? 'class' : 'struct';
    return { name: m[2], kind: k };
  }
  m = RE.cFunc.exec(line);
  if (m && isPlausibleCall(m[1], m[2].split('::').pop() ?? m[2])) {
    const parts = m[2].split('::');
    const name = parts.pop() ?? m[2];
    const container = parts.pop() ?? ctx.enclosingType?.name;
    return { name, kind: container ? 'method' : 'function', container };
  }
  return undefined;
}

function matchSwift(line: string, ctx: MatchContext): Decl | undefined {
  let m = RE.swiftType.exec(line);
  if (m) return { name: m[2], kind: m[1] === 'protocol' ? 'interface' : m[1] === 'extension' ? 'impl' : m[1] === 'enum' ? 'enum' : m[1] === 'struct' ? 'struct' : 'class' };
  m = RE.swiftFunc.exec(line);
  if (m) return m[2] ? { name: 'init', kind: 'constructor' } : { name: m[1], kind: ctx.enclosingType ? 'method' : 'function' };
  if (ctx.typeBody) {
    m = RE.swiftProp.exec(line);
    if (m) return { name: m[1], kind: 'property' };
  }
  return undefined;
}

function matchPhp(line: string, ctx: MatchContext): Decl | undefined {
  let m = RE.phpNamespace.exec(line);
  if (m) return { name: m[1], kind: 'namespace' };
  m = RE.phpType.exec(line);
  if (m) return { name: m[2], kind: m[1] === 'trait' ? 'trait' : m[1] === 'enum' ? 'enum' : m[1] === 'interface' ? 'interface' : 'class' };
  m = RE.phpFunc.exec(line);
  if (m) return { name: m[1], kind: ctx.enclosingType ? (m[1] === '__construct' ? 'constructor' : 'method') : 'function' };
  return undefined;
}

function matchScala(line: string, ctx: MatchContext): Decl | undefined {
  let m = RE.scalaType.exec(line);
  if (m) return { name: m[2], kind: m[1] === 'trait' ? 'trait' : m[1] === 'enum' ? 'enum' : 'class' };
  m = RE.scalaDef.exec(line);
  if (m) return { name: m[1], kind: ctx.enclosingType ? 'method' : 'function' };
  return undefined;
}

function matchDart(line: string, ctx: MatchContext): Decl | undefined {
  const m = RE.dartType.exec(line);
  if (m) return { name: m[2], kind: m[1] === 'enum' ? 'enum' : m[1] === 'extension' ? 'impl' : 'class' };
  return matchJava(line, { ...ctx, enclosingType: ctx.enclosingType ?? (ctx.topLevel ? ({ name: '' } as SymbolInfo) : undefined) }) ?? undefined;
}

function matcherFor(languageId: string): (line: string, ctx: MatchContext) => Decl | undefined {
  switch (languageId) {
    case 'csharp':
      return matchCSharp;
    case 'java':
    case 'groovy':
      return matchJava;
    case 'kotlin':
      return matchKotlin;
    case 'typescript':
    case 'typescriptreact':
    case 'javascript':
    case 'javascriptreact':
    case 'vue':
    case 'svelte':
    case 'astro':
      return matchTs;
    case 'go':
      return matchGo;
    case 'rust':
      return matchRust;
    case 'swift':
      return matchSwift;
    case 'php':
      return matchPhp;
    case 'scala':
      return matchScala;
    case 'dart':
      return matchDart;
    case 'proto3':
      return (line) => {
        const t = RE.protoType.exec(line);
        if (t) return { name: t[2], kind: t[1] === 'enum' ? 'enum' : t[1] === 'service' ? 'interface' : 'struct' };
        const r = RE.protoRpc.exec(line);
        return r ? { name: r[1], kind: 'method' } : undefined;
      };
    case 'powershell':
      return (line) => {
        const f = RE.psFunc.exec(line);
        return f ? { name: f[1], kind: 'function' } : undefined;
      };
    case 'zig':
      return (line, ctx) => {
        const t = RE.zigType.exec(line);
        if (t) return { name: t[1], kind: t[2] === 'enum' ? 'enum' : 'struct' };
        const f = RE.zigFn.exec(line);
        return f ? { name: f[1], kind: ctx.enclosingType ? 'method' : 'function' } : undefined;
      };
    default:
      return matchC;
  }
}

interface OpenBlock {
  sym?: SymbolInfo;
}

const MAYBE_BODYLESS: ReadonlySet<SymbolKind> = new Set(['field', 'variable', 'property', 'type']);

function extractBraceSymbols(text: string, languageId: string): SymbolInfo[] {
  const { masked } = maskCode(text, languageId);
  const lines = masked.split('\n');
  const orig = text.split('\n');
  const match = matcherFor(languageId);
  const symbols: SymbolInfo[] = [];
  const stack: OpenBlock[] = [];
  let pending: { sym: SymbolInfo; line: number } | undefined;

  const innermostType = (): SymbolInfo | undefined => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const s = stack[k].sym;
      if (s && TYPE_KINDS.has(s.kind)) return s;
    }
    return undefined;
  };
  const insideCallable = (): boolean => stack.some((b) => b.sym && (CALLABLE_KINDS.has(b.sym.kind) || b.sym.kind === 'property' || b.sym.kind === 'field'));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!pending && line.trim() && !insideCallable()) {
      const top = stack[stack.length - 1];
      const typeBody = top?.sym && TYPE_KINDS.has(top.sym.kind) ? top.sym : undefined;
      const enclosingType = innermostType();
      const decl = match(line, { typeBody, enclosingType, topLevel: stack.length === 0 });
      if (decl) {
        const { startLine, doc } = expandUpwards(orig, lines, i);
        const sym: SymbolInfo = {
          name: decl.name,
          kind: decl.kind,
          startLine,
          declLine: i,
          endLine: i,
          container: decl.container ?? enclosingType?.name,
          signature: '',
          doc,
        };
        symbols.push(sym);
        // Fields, properties and aliases end on their line unless a body or a continuation follows.
        const continues = /(=|,|\(|=>|\+|\|\||&&|\?|:)\s*$/.test(line.trimEnd());
        if (!MAYBE_BODYLESS.has(decl.kind) || line.includes('{') || continues) pending = { sym, line: i };
      }
    }

    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '{') {
        if (pending) {
          stack.push({ sym: pending.sym });
          pending = undefined;
        } else {
          stack.push({});
        }
      } else if (ch === '}') {
        if (pending) {
          // The enclosing block ends before any body showed up.
          pending.sym.endLine = pending.line;
          pending = undefined;
        }
        const block = stack.pop();
        if (block?.sym) block.sym.endLine = i;
      } else if (ch === ';' && pending) {
        // Declaration without a body: field, prototype, expression-bodied member.
        pending.sym.endLine = i;
        pending = undefined;
      }
    }
    if (pending && i - pending.line >= 6) {
      // Never saw a body: single-line declaration (e.g. a Go type alias, a field without ';').
      pending.sym.endLine = pending.line;
      pending = undefined;
    }
  }
  for (const block of stack) if (block.sym) block.sym.endLine = lines.length - 1;
  if (pending) pending.sym.endLine = pending.line;

  for (const s of symbols) s.signature = signatureOf(orig, s, '{');
  // File-scoped namespaces (C# `namespace X;`) cover the rest of the file.
  for (const s of symbols) if (s.kind === 'namespace' && s.endLine === s.declLine && /;\s*$/.test(lines[s.declLine])) s.endLine = lines.length - 1;
  return symbols;
}

/** Moves the start of a declaration up over attributes/annotations and its doc comment. */
function expandUpwards(orig: string[], masked: string[], declLine: number): { startLine: number; doc?: string } {
  let startLine = declLine;
  const docLines: string[] = [];
  for (let j = declLine - 1; j >= 0 && declLine - j <= 40; j--) {
    const o = orig[j].trim();
    const m = masked[j].trim();
    if (o === '') break;
    if (m === '') {
      docLines.unshift(stripCommentMarkers(o));
      startLine = j;
      continue;
    }
    if (/^\[[^\]]*\]$/.test(m) || /^@[\w.]+(\(.*\))?$/.test(m) || /^#\[.*\]$/.test(m)) {
      startLine = j;
      continue;
    }
    break;
  }
  return { startLine, doc: cleanDoc(docLines) };
}

function cleanDoc(lines: string[]): string | undefined {
  const text = lines
    .map((l) => l.replace(/<\/?(summary|remarks|returns|value|para|c|code|see[^>]*|param[^>]*|typeparam[^>]*)>/g, ' ').replace(/^[*\s]+/, '').trim())
    .filter((l) => l && !/^[-=*/]+$/.test(l))
    .join(' ');
  return text ? truncate(collapseWhitespace(text), 300) : undefined;
}

function signatureOf(orig: string[], s: SymbolInfo, bodyOpener: string): string {
  const parts: string[] = [];
  for (let j = s.declLine; j <= Math.min(s.endLine, s.declLine + 5); j++) {
    const line = orig[j];
    const cut = line.indexOf(bodyOpener);
    if (cut >= 0 && s.kind !== 'field' && s.kind !== 'variable') {
      parts.push(line.slice(0, cut));
      break;
    }
    parts.push(line);
    if (/[;{]\s*$/.test(line)) break;
  }
  return truncate(collapseWhitespace(parts.join(' ').replace(/;\s*$/, '')), 240);
}

// ---------------------------------------------------------------------------
// Indentation languages (Python, GDScript)

function extractIndentSymbols(text: string, languageId: string): SymbolInfo[] {
  const { masked, kinds } = maskCode(text, languageId);
  const lines = masked.split('\n');
  const orig = text.split('\n');
  const gd = languageId === 'gdscript';
  const symbols: SymbolInfo[] = [];
  const stack: { indent: number; sym: SymbolInfo }[] = [];
  let lastNonBlank = -1;

  const close = (upToIndent: number) => {
    while (stack.length > 0 && upToIndent <= stack[stack.length - 1].indent) {
      const top = stack.pop()!;
      top.sym.endLine = Math.max(top.sym.declLine, lastNonBlank);
    }
  };

  let lineStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Lines that begin inside a multi-line string say nothing about indentation.
    const insideString = lineStart > 0 && kinds[lineStart - 1] === CharKind.StringContent;
    lineStart += line.length + 1;
    if (!line.trim() || insideString) continue;
    const indent = indentWidth(line);
    if (stack.length > 0 && indent <= stack[stack.length - 1].indent) close(indent);

    const parent = stack[stack.length - 1]?.sym;
    const inClassBody = parent && parent.kind === 'class';
    let decl: Decl | undefined;
    let opensBody = false;
    let m: RegExpExecArray | null;
    if ((m = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*[([]/.exec(line))) {
      decl = { name: m[1], kind: inClassBody ? (m[1] === '__init__' ? 'constructor' : 'method') : 'function' };
      opensBody = true;
    } else if ((m = /^\s*class\s+([A-Za-z_]\w*)/.exec(line))) {
      decl = { name: m[1], kind: 'class' };
      opensBody = true;
    } else if (gd && (m = /^\s*(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(/.exec(line))) {
      decl = { name: m[1], kind: indent > 0 && inClassBody ? 'method' : 'function' };
      opensBody = true;
    } else if (gd && indent === 0 && (m = /^class_name\s+([A-Za-z_]\w*)/.exec(line))) {
      decl = { name: m[1], kind: 'class' };
    } else if (gd && indent === 0 && (m = /^signal\s+([A-Za-z_]\w*)/.exec(line))) {
      decl = { name: m[1], kind: 'field' };
    } else if (gd && indent === 0 && (m = /^(?:@\w+(?:\([^)]*\))?\s+)*(?:var|const)\s+([A-Za-z_]\w*)/.exec(line))) {
      decl = { name: m[1], kind: 'field' };
    } else if (!gd && indent === 0 && (m = /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/.exec(line))) {
      decl = { name: m[1], kind: 'variable' };
    } else if (!gd && inClassBody && indent > stack[stack.length - 1].indent && (m = /^\s+([A-Za-z_]\w*)\s*(?::\s*[^=]+)?=/.exec(line) ?? /^\s+([A-Za-z_]\w*)\s*:\s*\S/.exec(line))) {
      decl = { name: m[1], kind: 'field' };
    }

    if (decl) {
      let startLine = i;
      for (let j = i - 1; j >= 0 && /^\s*@/.test(lines[j]) && indentWidth(lines[j]) === indent; j--) startLine = j;
      const sym: SymbolInfo = {
        name: decl.name,
        kind: decl.kind,
        startLine,
        declLine: i,
        endLine: i,
        container: parent?.name,
        signature: pythonSignature(orig, lines, i),
        doc: opensBody ? pythonDocstring(orig, lines, i) : undefined,
      };
      symbols.push(sym);
      if (opensBody) stack.push({ indent, sym });
    }
    lastNonBlank = i;
  }
  close(-1);
  return symbols;
}

function pythonSignature(orig: string[], masked: string[], declLine: number): string {
  const parts: string[] = [];
  for (let j = declLine; j < Math.min(orig.length, declLine + 8); j++) {
    parts.push(orig[j]);
    if (/:\s*$/.test(masked[j]) || /:\s*(#.*)?$/.test(masked[j].trimEnd())) break;
  }
  return truncate(collapseWhitespace(parts.join(' ').replace(/:\s*$/, '')), 240);
}

function pythonDocstring(orig: string[], masked: string[], declLine: number): string | undefined {
  let j = declLine;
  while (j < masked.length && !/:\s*$/.test(masked[j].trimEnd())) j++;
  j++;
  while (j < orig.length && !orig[j].trim()) j++;
  const first = orig[j]?.trim() ?? '';
  const m = /^[rRbBuU]?("""|''')(.*)$/.exec(first);
  if (!m) return undefined;
  const parts = [m[2]];
  if (!m[2].includes(m[1])) {
    for (let k = j + 1; k < Math.min(orig.length, j + 6); k++) {
      if (orig[k].includes(m[1])) {
        parts.push(orig[k].slice(0, orig[k].indexOf(m[1])));
        break;
      }
      parts.push(orig[k]);
    }
  }
  const text = collapseWhitespace(parts.join(' ').replace(/("""|''')/g, ''));
  return text ? truncate(text, 300) : undefined;
}

// ---------------------------------------------------------------------------
// `end`-delimited and shell languages: the body ends at the first line with the
// same indentation as the declaration that closes it (`end`, `}`).

function extractEndSymbols(text: string, languageId: string): SymbolInfo[] {
  const { masked } = maskCode(text, languageId);
  const lines = masked.split('\n');
  const orig = text.split('\n');
  const patterns: { re: RegExp; kind: SymbolKind }[] =
    languageId === 'lua'
      ? [
          { re: /^\s*(?:local\s+)?function\s+([\w.:]+)\s*\(/, kind: 'function' },
          { re: /^\s*(?:local\s+)?([\w.]+)\s*=\s*function\s*\(/, kind: 'function' },
        ]
      : languageId === 'ruby'
        ? [
            { re: /^\s*def\s+(?:self\.)?([\w?!=]+)/, kind: 'method' },
            { re: /^\s*class\s+([\w:]+)/, kind: 'class' },
            { re: /^\s*module\s+([\w:]+)/, kind: 'module' },
          ]
        : languageId === 'elixir'
          ? [
              { re: /^\s*defp?\s+([\w?!]+)/, kind: 'function' },
              { re: /^\s*defmodule\s+([\w.]+)/, kind: 'module' },
            ]
          : [{ re: /^\s*(?:function\s+)?([\w-]+)\s*\(\)\s*\{?/, kind: 'function' }];
  const closer = languageId === 'lua' || languageId === 'ruby' || languageId === 'elixir' ? /^\s*end\b/ : /^\s*\}/;
  const symbols: SymbolInfo[] = [];
  const containers: SymbolInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const p of patterns) {
      const m = p.re.exec(lines[i]);
      if (!m) continue;
      const indent = indentWidth(lines[i]);
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() && indentWidth(lines[j]) === indent && closer.test(lines[j])) {
          end = j;
          break;
        }
        if (lines[j].trim() && indentWidth(lines[j]) < indent) {
          end = j - 1;
          break;
        }
        end = j;
      }
      const container = containers.filter((c) => c.startLine < i && c.endLine >= end).pop();
      const sym: SymbolInfo = {
        name: m[1],
        kind: p.kind,
        startLine: i,
        declLine: i,
        endLine: end,
        container: container?.name,
        signature: truncate(collapseWhitespace(orig[i]), 240),
      };
      symbols.push(sym);
      if (p.kind === 'class' || p.kind === 'module') containers.push(sym);
      break;
    }
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// Markdown: headings become sections, so docs are retrievable by topic.

function extractMarkdownSections(text: string): SymbolInfo[] {
  const lines = text.split('\n');
  const heads: { level: number; title: string; line: number }[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (m) heads.push({ level: m[1].length, title: m[2], line: i });
  }
  return heads.map((h, idx) => {
    let end = lines.length - 1;
    for (let k = idx + 1; k < heads.length; k++) {
      if (heads[k].level <= h.level) {
        end = heads[k].line - 1;
        break;
      }
    }
    const parent = heads.slice(0, idx).reverse().find((p) => p.level < h.level);
    return { name: h.title, kind: 'section' as const, startLine: h.line, declLine: h.line, endLine: end, container: parent?.title, signature: `${'#'.repeat(h.level)} ${h.title}` };
  });
}

/** A compact outline (signatures only, members indented) used as repository context. */
export function outlineOf(symbols: SymbolInfo[], maxLines = 40): string {
  const lines: string[] = [];
  for (const s of symbols) {
    if (s.kind === 'section' || s.kind === 'namespace') continue;
    lines.push(`${s.container && !TYPE_KINDS.has(s.kind) ? '    ' : ''}${s.signature}`);
    if (lines.length >= maxLines) {
      lines.push('    …');
      break;
    }
  }
  return lines.join('\n');
}
