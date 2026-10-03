// Bundles the extension host code (Node, CJS) and the two webview scripts (browser, IIFE).
// Usage: node esbuild.mjs [--production] [--watch] [--tests]
import { rmSync } from 'node:fs';
import * as esbuild from 'esbuild';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');
const withTests = args.has('--tests');

// A production build starts clean so no stale source map ends up in the package.
if (production) rmSync('dist', { recursive: true, force: true });

const common = {
  bundle: true,
  sourcemap: production ? false : 'linked',
  minify: production,
  legalComments: 'none',
  logLevel: 'info',
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: { panel: 'src/webview/panel.ts', dashboard: 'src/webview/dashboard.ts' },
    outdir: 'dist/webview',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

if (withTests) {
  builds.push({
    ...common,
    sourcemap: 'inline',
    entryPoints: {
      runTests: 'test/integration/runTests.ts',
      'suite/index': 'test/integration/suite/index.ts',
    },
    outdir: 'out/test/integration',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', 'mocha', '@vscode/test-electron'],
  });
}

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[esbuild] watching…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
