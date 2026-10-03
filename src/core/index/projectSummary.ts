// What kind of project is this? Languages, frameworks and the test framework to
// use when generating tests. Pure: the caller passes file paths and manifests.

export interface ProjectSummary {
  languages: { id: string; files: number }[];
  frameworks: string[];
  testFrameworks: string[];
  topDirectories: string[];
}

export interface Manifest {
  path: string;
  text: string;
}

const MANIFEST_NAMES = [
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'setup.py',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'ProjectSettings/ProjectVersion.txt',
  'Packages/manifest.json',
  'project.godot',
  'composer.json',
  'Gemfile',
];

export function isManifestPath(path: string): boolean {
  return MANIFEST_NAMES.some((n) => path === n || path.endsWith(`/${n}`)) || /\.(csproj|fsproj|asmdef)$/.test(path);
}

export function detectFrameworks(manifests: Manifest[]): { frameworks: string[]; testFrameworks: string[] } {
  const frameworks = new Set<string>();
  const tests = new Set<string>();
  for (const { path, text } of manifests) {
    const name = path.split('/').pop() ?? path;
    if (path.endsWith('ProjectSettings/ProjectVersion.txt')) {
      const v = /m_EditorVersion:\s*(\S+)/.exec(text)?.[1];
      frameworks.add(v ? `Unity ${v}` : 'Unity');
    }
    if (name === 'manifest.json' && text.includes('com.unity.test-framework')) tests.add('Unity Test Framework (NUnit)');
    if (name.endsWith('.asmdef') && /UnityEngine\.TestRunner|nunit\.framework/i.test(text)) tests.add('Unity Test Framework (NUnit)');
    if (name === 'project.godot') frameworks.add('Godot');
    if (name === 'package.json') {
      let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
      try {
        pkg = JSON.parse(text);
      } catch {
        /* ignore malformed */
      }
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const has = (d: string) => Object.prototype.hasOwnProperty.call(deps, d);
      for (const [dep, label] of [
        ['react', 'React'],
        ['next', 'Next.js'],
        ['vue', 'Vue'],
        ['svelte', 'Svelte'],
        ['@angular/core', 'Angular'],
        ['express', 'Express'],
        ['fastify', 'Fastify'],
        ['@nestjs/core', 'NestJS'],
        ['electron', 'Electron'],
        ['@types/vscode', 'VS Code extension'],
        ['astro', 'Astro'],
      ] as const) {
        if (has(dep)) frameworks.add(label);
      }
      for (const [dep, label] of [
        ['vitest', 'Vitest'],
        ['jest', 'Jest'],
        ['mocha', 'Mocha'],
        ['@playwright/test', 'Playwright'],
        ['cypress', 'Cypress'],
      ] as const) {
        if (has(dep)) tests.add(label);
      }
    }
    if (name === 'requirements.txt' || name === 'pyproject.toml' || name === 'setup.py') {
      const lower = text.toLowerCase();
      if (/\bdjango\b/.test(lower)) frameworks.add('Django');
      if (/\bflask\b/.test(lower)) frameworks.add('Flask');
      if (/\bfastapi\b/.test(lower)) frameworks.add('FastAPI');
      if (/\bpytest\b/.test(lower)) tests.add('pytest');
    }
    if (/\.(cs|fs)proj$/.test(name)) {
      if (/xunit/i.test(text)) tests.add('xUnit');
      if (/nunit/i.test(text)) tests.add('NUnit');
      if (/MSTest/i.test(text)) tests.add('MSTest');
      if (/Microsoft\.AspNetCore|Sdk="Microsoft\.NET\.Sdk\.Web"/.test(text)) frameworks.add('ASP.NET Core');
    }
    if (name === 'go.mod') tests.add('go test');
    if (name === 'Cargo.toml') tests.add('cargo test');
    if (name === 'pom.xml' || name.startsWith('build.gradle')) {
      if (/junit-jupiter|junit5|org\.junit\.jupiter/i.test(text)) tests.add('JUnit 5');
      else if (/junit/i.test(text)) tests.add('JUnit');
      if (/spring-boot/i.test(text)) frameworks.add('Spring Boot');
    }
    if (name === 'composer.json' && /phpunit/i.test(text)) tests.add('PHPUnit');
    if (name === 'Gemfile' && /rspec/i.test(text)) tests.add('RSpec');
  }
  return { frameworks: [...frameworks], testFrameworks: [...tests] };
}

/** Test framework to target for a file in `languageId`, given what the project uses. */
export function testFrameworkFor(languageId: string, summary: Pick<ProjectSummary, 'frameworks' | 'testFrameworks'>): string {
  const t = summary.testFrameworks;
  const pick = (...names: string[]) => names.find((n) => t.includes(n));
  switch (languageId) {
    case 'csharp':
      if (summary.frameworks.some((f) => f.startsWith('Unity'))) return 'Unity Test Framework (NUnit, [Test] / [UnityTest])';
      return pick('xUnit', 'NUnit', 'MSTest') ?? 'xUnit';
    case 'python':
      return pick('pytest') ?? 'pytest';
    case 'typescript':
    case 'typescriptreact':
    case 'javascript':
    case 'javascriptreact':
      return pick('Vitest', 'Jest', 'Mocha') ?? 'Vitest';
    case 'java':
    case 'kotlin':
      return pick('JUnit 5', 'JUnit') ?? 'JUnit 5';
    case 'go':
      return 'Go testing package (table-driven tests)';
    case 'rust':
      return 'Rust #[cfg(test)] module with #[test] functions';
    case 'php':
      return 'PHPUnit';
    case 'ruby':
      return pick('RSpec') ?? 'Minitest';
    default:
      return t[0] ?? 'the project’s usual test framework';
  }
}
