// Language table: extensions, structural family and comment syntax.
// Ids match VS Code language identifiers so editor documents map directly.

export type LanguageFamily = 'c-like' | 'python' | 'ruby' | 'lua' | 'shell' | 'sql' | 'markup' | 'markdown' | 'data' | 'other';

interface LanguageSpec {
  id: string;
  extensions: string[];
  family: LanguageFamily;
  line?: string;
  block?: [string, string];
}

const C_COMMENTS = { line: '//', block: ['/*', '*/'] as [string, string] };

const SPECS: LanguageSpec[] = [
  { id: 'typescript', extensions: ['.ts', '.mts', '.cts'], family: 'c-like', ...C_COMMENTS },
  { id: 'typescriptreact', extensions: ['.tsx'], family: 'c-like', ...C_COMMENTS },
  { id: 'javascript', extensions: ['.js', '.mjs', '.cjs'], family: 'c-like', ...C_COMMENTS },
  { id: 'javascriptreact', extensions: ['.jsx'], family: 'c-like', ...C_COMMENTS },
  { id: 'csharp', extensions: ['.cs'], family: 'c-like', ...C_COMMENTS },
  { id: 'java', extensions: ['.java'], family: 'c-like', ...C_COMMENTS },
  { id: 'kotlin', extensions: ['.kt', '.kts'], family: 'c-like', ...C_COMMENTS },
  { id: 'scala', extensions: ['.scala', '.sc'], family: 'c-like', ...C_COMMENTS },
  { id: 'groovy', extensions: ['.groovy', '.gradle'], family: 'c-like', ...C_COMMENTS },
  { id: 'go', extensions: ['.go'], family: 'c-like', ...C_COMMENTS },
  { id: 'rust', extensions: ['.rs'], family: 'c-like', ...C_COMMENTS },
  { id: 'c', extensions: ['.c', '.h'], family: 'c-like', ...C_COMMENTS },
  { id: 'cpp', extensions: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.inl', '.ipp'], family: 'c-like', ...C_COMMENTS },
  { id: 'objective-c', extensions: ['.m'], family: 'c-like', ...C_COMMENTS },
  { id: 'objective-cpp', extensions: ['.mm'], family: 'c-like', ...C_COMMENTS },
  { id: 'swift', extensions: ['.swift'], family: 'c-like', ...C_COMMENTS },
  { id: 'dart', extensions: ['.dart'], family: 'c-like', ...C_COMMENTS },
  { id: 'php', extensions: ['.php'], family: 'c-like', ...C_COMMENTS },
  { id: 'zig', extensions: ['.zig'], family: 'c-like', line: '//' },
  { id: 'proto3', extensions: ['.proto'], family: 'c-like', ...C_COMMENTS },
  { id: 'hlsl', extensions: ['.hlsl', '.cginc', '.compute', '.fx', '.hlsli'], family: 'c-like', ...C_COMMENTS },
  { id: 'shaderlab', extensions: ['.shader'], family: 'c-like', ...C_COMMENTS },
  { id: 'glsl', extensions: ['.glsl', '.vert', '.frag', '.comp', '.geom'], family: 'c-like', ...C_COMMENTS },
  { id: 'fsharp', extensions: ['.fs', '.fsx', '.fsi'], family: 'c-like', line: '//', block: ['(*', '*)'] },
  { id: 'python', extensions: ['.py', '.pyw', '.pyi'], family: 'python', line: '#' },
  { id: 'gdscript', extensions: ['.gd'], family: 'python', line: '#' },
  { id: 'ruby', extensions: ['.rb', '.rake', '.gemspec'], family: 'ruby', line: '#' },
  { id: 'elixir', extensions: ['.ex', '.exs'], family: 'ruby', line: '#' },
  { id: 'lua', extensions: ['.lua'], family: 'lua', line: '--', block: ['--[[', ']]'] },
  { id: 'shellscript', extensions: ['.sh', '.bash', '.zsh'], family: 'shell', line: '#' },
  { id: 'powershell', extensions: ['.ps1', '.psm1', '.psd1'], family: 'shell', line: '#', block: ['<#', '#>'] },
  { id: 'perl', extensions: ['.pl', '.pm'], family: 'shell', line: '#' },
  { id: 'r', extensions: ['.r'], family: 'shell', line: '#' },
  { id: 'julia', extensions: ['.jl'], family: 'shell', line: '#' },
  { id: 'nim', extensions: ['.nim'], family: 'shell', line: '#' },
  { id: 'sql', extensions: ['.sql'], family: 'sql', line: '--', block: ['/*', '*/'] },
  { id: 'haskell', extensions: ['.hs'], family: 'other', line: '--', block: ['{-', '-}'] },
  { id: 'ocaml', extensions: ['.ml', '.mli'], family: 'other', block: ['(*', '*)'] },
  { id: 'vb', extensions: ['.vb'], family: 'other', line: "'" },
  { id: 'html', extensions: ['.html', '.htm'], family: 'markup', block: ['<!--', '-->'] },
  { id: 'xml', extensions: ['.xml', '.xaml', '.uxml', '.csproj', '.props', '.targets', '.svg'], family: 'markup', block: ['<!--', '-->'] },
  { id: 'vue', extensions: ['.vue'], family: 'markup', block: ['<!--', '-->'] },
  { id: 'svelte', extensions: ['.svelte'], family: 'markup', block: ['<!--', '-->'] },
  { id: 'astro', extensions: ['.astro'], family: 'markup', block: ['<!--', '-->'] },
  { id: 'css', extensions: ['.css', '.uss'], family: 'c-like', block: ['/*', '*/'] },
  { id: 'scss', extensions: ['.scss'], family: 'c-like', ...C_COMMENTS },
  { id: 'less', extensions: ['.less'], family: 'c-like', ...C_COMMENTS },
  { id: 'markdown', extensions: ['.md', '.markdown', '.mdx'], family: 'markdown', block: ['<!--', '-->'] },
  { id: 'json', extensions: ['.json', '.asmdef', '.asmref'], family: 'data' },
  { id: 'jsonc', extensions: ['.jsonc'], family: 'data', ...C_COMMENTS },
  { id: 'yaml', extensions: ['.yaml', '.yml'], family: 'data', line: '#' },
  { id: 'toml', extensions: ['.toml'], family: 'data', line: '#' },
  { id: 'ini', extensions: ['.ini', '.cfg'], family: 'data', line: ';' },
  { id: 'terraform', extensions: ['.tf', '.tfvars'], family: 'c-like', line: '#', block: ['/*', '*/'] },
  { id: 'graphql', extensions: ['.graphql', '.gql'], family: 'data', line: '#' },
  { id: 'dockerfile', extensions: [], family: 'shell', line: '#' },
  { id: 'makefile', extensions: [], family: 'shell', line: '#' },
  { id: 'bat', extensions: ['.bat', '.cmd'], family: 'other', line: 'REM' },
];

const BY_ID = new Map(SPECS.map((s) => [s.id, s]));
const BY_EXT = new Map<string, LanguageSpec>();
for (const s of SPECS) for (const e of s.extensions) BY_EXT.set(e, s);

const FILENAMES: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile' };

export function languageIdForPath(path: string): string | undefined {
  const base = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (FILENAMES[base]) return FILENAMES[base];
  const dot = base.lastIndexOf('.');
  if (dot < 0) return undefined;
  return BY_EXT.get(base.slice(dot))?.id;
}

export function familyOf(languageId: string): LanguageFamily {
  return BY_ID.get(languageId)?.family ?? 'other';
}

export interface CommentSyntax {
  line?: string;
  blockStart?: string;
  blockEnd?: string;
}

export function commentSyntaxFor(languageId: string): CommentSyntax {
  const spec = BY_ID.get(languageId);
  if (!spec) return { line: '//', blockStart: '/*', blockEnd: '*/' };
  return { line: spec.line, blockStart: spec.block?.[0], blockEnd: spec.block?.[1] };
}

/** Extensions indexed by default (code + docs + small config). */
export const INDEXABLE_EXTENSIONS: string[] = SPECS.flatMap((s) => s.extensions).filter((e) => !['.svg', '.json', '.xml', '.csproj', '.props', '.targets'].includes(e));

/** Families whose files hold code (as opposed to prose or data). */
export function isCodeFamily(family: LanguageFamily): boolean {
  return family !== 'markdown' && family !== 'data' && family !== 'other';
}
