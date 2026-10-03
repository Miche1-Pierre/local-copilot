// Import extraction and best-effort resolution to workspace files.

import { toPosixPath } from '../util/text';
import { familyOf } from './languages';
import { maskCode } from './scanner';

export interface ImportRef {
  /** Module specifier as written (path, dotted name, namespace…). */
  module: string;
  line: number;
  /** Relative imports are resolved against the importing file. */
  relative: boolean;
}

const PATTERNS: Record<string, RegExp[]> = {
  ts: [
    /^\s*import\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/,
    /^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+['"]([^'"]+)['"]/,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/,
  ],
  python: [/^\s*from\s+(\.*[\w.]*)\s+import\s+/, /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/],
  csharp: [/^\s*(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/],
  java: [/^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;/],
  kotlin: [/^\s*import\s+([\w.]+)/],
  go: [/^\s*import\s+(?:\w+\s+)?"([^"]+)"/, /^\s*(?:\w+\s+)?"([^"]+)"\s*$/],
  rust: [/^\s*(?:pub\s+)?use\s+([\w:]+)/, /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/],
  c: [/^\s*#\s*include\s+"([^"]+)"/],
  php: [/^\s*use\s+([\w\\]+)/, /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/],
  ruby: [/^\s*require_relative\s+['"]([^'"]+)['"]/, /^\s*require\s+['"]([^'"]+)['"]/],
  lua: [/\brequire\s*\(?\s*['"]([^'"]+)['"]/],
  gdscript: [/\b(?:preload|load)\(\s*"res:\/\/([^"]+)"\s*\)/, /^\s*extends\s+"res:\/\/([^"]+)"/],
};

function patternKey(languageId: string): string | undefined {
  if (['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'vue', 'svelte', 'astro'].includes(languageId)) return 'ts';
  if (languageId === 'c' || languageId === 'cpp' || languageId === 'objective-c' || languageId === 'objective-cpp' || languageId === 'hlsl' || languageId === 'shaderlab' || languageId === 'glsl') return 'c';
  return PATTERNS[languageId] ? languageId : undefined;
}

export function extractImports(text: string, languageId: string): ImportRef[] {
  const key = patternKey(languageId);
  if (!key) return [];
  // Imports live in code, but their specifiers are strings: match on the original
  // line, and only for lines whose first non-blank char is code (not a comment).
  const { masked } = maskCode(text, languageId);
  const lines = text.split('\n');
  const maskedLines = masked.split('\n');
  const out: ImportRef[] = [];
  let inGoBlock = false;
  for (let i = 0; i < lines.length; i++) {
    if (!maskedLines[i].trim()) continue;
    const line = lines[i];
    if (key === 'go') {
      if (/^\s*import\s*\(/.test(maskedLines[i])) {
        inGoBlock = true;
        continue;
      }
      if (inGoBlock && /^\s*\)/.test(maskedLines[i])) {
        inGoBlock = false;
        continue;
      }
    }
    for (const re of PATTERNS[key]) {
      if (key === 'go' && re === PATTERNS.go[1] && !inGoBlock) continue;
      const m = re.exec(line);
      if (!m) continue;
      for (const spec of key === 'python' && !line.trimStart().startsWith('from') ? m[1].split(/\s*,\s*/) : [m[1]]) {
        out.push({ module: spec.trim(), line: i, relative: isRelative(spec.trim(), key) });
      }
      break;
    }
  }
  return out;
}

function isRelative(spec: string, key: string): boolean {
  if (key === 'python') return spec.startsWith('.');
  if (key === 'c' || key === 'ruby' || key === 'gdscript') return true;
  if (key === 'php') return spec.includes('/') || spec.endsWith('.php');
  return spec.startsWith('./') || spec.startsWith('../');
}

const TS_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Resolves an import to workspace files. `files` holds every indexed
 * workspace-relative POSIX path. Namespace-style imports (C#, Java) resolve
 * through `namespaceIndex` (namespace → files declaring it) when provided.
 */
export function resolveImport(
  ref: ImportRef,
  fromPath: string,
  languageId: string,
  files: ReadonlySet<string>,
  namespaceIndex?: ReadonlyMap<string, string[]>,
): string[] {
  const from = toPosixPath(fromPath);
  const dir = dirname(from);
  const key = patternKey(languageId);
  const exists = (p: string) => files.has(p);
  const firstExisting = (candidates: string[]) => candidates.map(normalize).filter(exists).slice(0, 1);

  switch (key) {
    case 'ts': {
      if (!ref.relative) return [];
      const base = normalize(`${dir}/${ref.module}`);
      const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
      return firstExisting([base, ...TS_EXTS.map((e) => stripped + e), ...TS_EXTS.map((e) => `${base}/index${e}`)]);
    }
    case 'python': {
      const dots = /^\.*/.exec(ref.module)?.[0].length ?? 0;
      const rest = ref.module.slice(dots).replace(/\./g, '/');
      let baseDir = dir;
      for (let k = 1; k < dots; k++) baseDir = dirname(baseDir);
      const roots = dots > 0 ? [baseDir] : ['', 'src', dir];
      const out: string[] = [];
      for (const root of roots) {
        const base = root ? `${root}/${rest}` : rest;
        out.push(...firstExisting([`${base}.py`, `${base}/__init__.py`]));
        if (out.length) break;
      }
      return out;
    }
    case 'c':
      return firstExisting([`${dir}/${ref.module}`, ref.module, `include/${ref.module}`, `src/${ref.module}`]);
    case 'ruby':
      return firstExisting([`${dir}/${ref.module}.rb`, `${dir}/${ref.module}`, `lib/${ref.module}.rb`]);
    case 'php':
      return ref.relative ? firstExisting([`${dir}/${ref.module}`, ref.module]) : [];
    case 'gdscript':
      return firstExisting([ref.module]);
    case 'lua':
      return firstExisting([`${ref.module.replace(/\./g, '/')}.lua`, `${dir}/${ref.module.replace(/\./g, '/')}.lua`]);
    case 'rust': {
      const segs = ref.module.split('::').filter((s) => s && s !== 'crate' && s !== 'self' && s !== 'super');
      if (segs.length === 0) return [];
      const candidates: string[] = [];
      for (let n = segs.length; n >= 1; n--) {
        const p = segs.slice(0, n).join('/');
        candidates.push(`${dir}/${p}.rs`, `${dir}/${p}/mod.rs`, `src/${p}.rs`, `src/${p}/mod.rs`);
      }
      return firstExisting(candidates);
    }
    case 'java':
    case 'kotlin': {
      const suffix = `/${ref.module.replace(/\./g, '/')}`;
      const ext = key === 'java' ? '.java' : '.kt';
      for (const f of files) if (f.endsWith(suffix + ext)) return [f];
      return namespaceIndex?.get(ref.module)?.slice(0, 3) ?? [];
    }
    case 'csharp':
      return namespaceIndex?.get(ref.module)?.slice(0, 5) ?? [];
    case 'go': {
      const last = ref.module.split('/').pop() ?? '';
      const out: string[] = [];
      for (const f of files) if (f.endsWith('.go') && dirname(f).endsWith(`/${last}`)) out.push(f);
      return out.slice(0, 5);
    }
    default:
      return [];
  }
}

/** Namespace / package declared by a file (C#, Java, Kotlin, PHP, Go). */
export function declaredNamespace(text: string, languageId: string): string | undefined {
  const head = text.slice(0, 4000);
  const family = familyOf(languageId);
  if (family !== 'c-like') return undefined;
  const m =
    /^\s*namespace\s+([\w.\\]+)/m.exec(head) ??
    /^\s*package\s+([\w.]+)\s*;?/m.exec(head);
  return m?.[1];
}
