import { describe, expect, it } from 'vitest';
import { Bm25Index, reciprocalRankFusion, splitIdentifier, tokenizeCode } from '../../src/core/index/bm25';
import { chunkFile } from '../../src/core/index/chunker';
import { CodebaseIndex } from '../../src/core/index/codebaseIndex';
import { IgnoreMatcher } from '../../src/core/index/gitignore';
import { extractImports, resolveImport } from '../../src/core/index/imports';
import { detectFrameworks, testFrameworkFor } from '../../src/core/index/projectSummary';
import { extractSymbols } from '../../src/core/index/symbols';
import { embeddingPrefixes, VectorStore } from '../../src/core/index/vectors';
import { jaccard, similarityTokens, WindowIndex } from '../../src/core/context/similarity';

describe('imports', () => {
  it('extracts imports per language', () => {
    expect(extractImports("import { a } from './a';\nimport type B from '../b/index.js';\nconst c = require('c');", 'typescript').map((i) => i.module)).toEqual(['./a', '../b/index.js', 'c']);
    expect(extractImports('from .models import User\nimport os, sys\n# import nope', 'python').map((i) => i.module)).toEqual(['.models', 'os', 'sys']);
    expect(extractImports('using UnityEngine;\nusing static System.Math;\nusing Alias = Game.Core;', 'csharp').map((i) => i.module)).toEqual(['UnityEngine', 'System.Math', 'Game.Core']);
    expect(extractImports('import (\n\t"fmt"\n\tsrv "example.com/app/server"\n)', 'go').map((i) => i.module)).toEqual(['fmt', 'example.com/app/server']);
    expect(extractImports('#include "player.h"\n#include <vector>', 'cpp').map((i) => i.module)).toEqual(['player.h']);
  });

  it('resolves relative imports to workspace files', () => {
    const files = new Set(['src/a.ts', 'src/b/index.ts', 'app/models.py', 'app/views.py', 'src/player.h']);
    const ts = extractImports("import { a } from './a';\nimport b from './b';", 'typescript');
    expect(resolveImport(ts[0], 'src/main.ts', 'typescript', files)).toEqual(['src/a.ts']);
    expect(resolveImport(ts[1], 'src/main.ts', 'typescript', files)).toEqual(['src/b/index.ts']);
    const py = extractImports('from .models import User', 'python');
    expect(resolveImport(py[0], 'app/views.py', 'python', files)).toEqual(['app/models.py']);
  });

  it('resolves C# usings through declared namespaces', () => {
    const ns = new Map([['Game.Core', ['Assets/Core/A.cs', 'Assets/Core/B.cs']]]);
    const [ref] = extractImports('using Game.Core;', 'csharp');
    expect(resolveImport(ref, 'Assets/Player.cs', 'csharp', new Set(), ns)).toEqual(['Assets/Core/A.cs', 'Assets/Core/B.cs']);
  });
});

describe('chunker', () => {
  it('aligns chunks on methods and covers top-level code', () => {
    const src = 'import x\n\nCONFIG = 1\nOTHER = 2\nTHIRD = 3\n\ndef a():\n    return 1\n\ndef b():\n    return 2\n';
    const chunks = chunkFile('m.py', src, extractSymbols(src, 'python'));
    expect(chunks.map((c) => c.symbol ?? '-')).toEqual(['-', 'a', 'b']);
    expect(chunks[0].startLine).toBe(0);
  });

  it('splits very long functions into overlapping windows', () => {
    const body = Array.from({ length: 200 }, (_, i) => `    x${i} = ${i}`).join('\n');
    const src = `def big():\n${body}\n`;
    const chunks = chunkFile('b.py', src, extractSymbols(src, 'python'), { maxLines: 80, windowLines: 50, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[1].startLine).toBe(40);
  });
});

describe('BM25 + fusion', () => {
  it('splits identifiers', () => {
    expect(splitIdentifier('takeDamageNow')).toEqual(['take', 'damage', 'now']);
    expect(splitIdentifier('HTTPServer_config')).toEqual(['http', 'server', 'config']);
    expect(tokenizeCode('PlayerHealth.TakeDamage(amount)')).toEqual(expect.arrayContaining(['playerhealth', 'player', 'health', 'takedamage', 'damage', 'amount']));
  });

  it('ranks the relevant chunk first', () => {
    const idx = new Bm25Index();
    idx.add('auth', tokenizeCode('function authenticateUser(token) { verifyJwt(token); }'));
    idx.add('ui', tokenizeCode('function renderButton(label) { return <button>{label}</button>; }'));
    idx.add('db', tokenizeCode('function saveUser(user) { db.insert(user); }'));
    expect(idx.search(tokenizeCode('where is the jwt token verified for authentication'), 3)[0].id).toBe('auth');
    idx.remove('auth');
    expect(idx.search(tokenizeCode('jwt'), 3)).toHaveLength(0);
  });

  it('fuses rankings', () => {
    const fused = reciprocalRankFusion([[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]]);
    expect(fused[0].id).toBe('b');
  });
});

describe('VectorStore', () => {
  it('searches by cosine similarity and round-trips through serialisation', () => {
    const store = new VectorStore('m');
    store.set('x', 'h1', [1, 0, 0]);
    store.set('y', 'h2', [0, 1, 0]);
    store.set('z', 'h3', [0.7, 0.7, 0]);
    expect(store.search([1, 0.1, 0], 2).map((r) => r.id)).toEqual(['x', 'z']);
    const copy = VectorStore.deserialize(store.serialize());
    expect(copy.model).toBe('m');
    expect(copy.has('y', 'h2')).toBe(true);
    expect(copy.has('y', 'other')).toBe(false);
    expect(copy.search([0, 1, 0], 1)[0].id).toBe('y');
  });

  it('knows the prefixes of common embedding models', () => {
    expect(embeddingPrefixes('nomic-embed-text').query).toBe('search_query: ');
    expect(embeddingPrefixes('qwen3-embedding:0.6b').query).toContain('Query: ');
    expect(embeddingPrefixes('bge-m3').query).toBe('');
  });
});

describe('IgnoreMatcher', () => {
  it('implements the common .gitignore rules', () => {
    const m = new IgnoreMatcher();
    m.add('', '# comment\nbuild/\n*.log\n/secret.txt\n!keep.log\ndocs/**/draft-*.md\n');
    m.add('UnityProject', 'Library/\n');
    expect(m.ignores('build/out.js')).toBe(true);
    expect(m.ignores('src/build/out.js')).toBe(true);
    expect(m.ignores('build', false)).toBe(false);
    expect(m.ignores('app.log')).toBe(true);
    expect(m.ignores('keep.log')).toBe(false);
    expect(m.ignores('secret.txt')).toBe(true);
    expect(m.ignores('sub/secret.txt')).toBe(false);
    expect(m.ignores('docs/a/b/draft-1.md')).toBe(true);
    expect(m.ignores('UnityProject/Library/x.asset')).toBe(true);
    expect(m.ignores('Library/x.asset')).toBe(false);
  });
});

describe('CodebaseIndex', () => {
  const files: Record<string, string> = {
    'Assets/Player/PlayerHealth.cs': 'namespace Game.Player {\npublic class PlayerHealth : MonoBehaviour {\n  public void TakeDamage(int amount) { bar.SetValue(amount); }\n  private HealthBar bar;\n}\n}\n',
    'Assets/UI/HealthBar.cs': 'namespace Game.UI {\npublic class HealthBar : MonoBehaviour {\n  public void SetValue(float normalized) { }\n}\n}\n',
    'Assets/AI/Guard.cs': 'using Game.Player;\nnamespace Game.AI {\npublic class Guard {\n  void Start() { }\n  void Chase(PlayerHealth target) { }\n}\n}\n',
    'Assets/AI/Other.cs': 'public class Other {\n  void Start() { }\n}\n',
    'Assets/AI/Third.cs': 'public class Third {\n  void Start() { }\n}\n',
    'Assets/AI/Fourth.cs': 'public class Fourth {\n  void Start() { }\n}\n',
    'docs/design.md': '# Design\n## Guard AI\nThe guard chases intruders when noise is high.\n',
  };
  const index = new CodebaseIndex(async (p) => files[p]);
  for (const [p, t] of Object.entries(files)) index.upsert(p, t, p.endsWith('.md') ? 'markdown' : 'csharp', { size: t.length, mtime: 0 });

  it('builds a symbol table and ignores names defined everywhere', () => {
    expect(index.definitionsOf('HealthBar')[0].path).toBe('Assets/UI/HealthBar.cs');
    expect(index.meaningfulDefinitionsOf('Start')).toHaveLength(0);
  });

  it('relates files through usings and type references', () => {
    const related = index.relatedFiles('Assets/AI/Guard.cs').map((r) => r.path);
    expect(related[0]).toBe('Assets/Player/PlayerHealth.cs');
    const forPlayer = index.relatedFiles('Assets/Player/PlayerHealth.cs').map((r) => r.path);
    expect(forPlayer).toContain('Assets/UI/HealthBar.cs');
    expect(forPlayer).toContain('Assets/AI/Guard.cs');
  });

  it('finds code and docs for a natural question', async () => {
    const hits = index.search('how does the guard chase the player?', { limit: 5 });
    const paths = hits.map((h) => h.chunk.path);
    expect(paths).toContain('Assets/AI/Guard.cs');
    expect(paths).toContain('docs/design.md');
    expect(await index.chunkText(hits[0].chunk)).toBeTruthy();
    const exact = index.search('TakeDamage', { limit: 1 });
    expect(exact[0].reasons).toContain('symbol');
  });

  it('tracks chunks to embed and removes files cleanly', () => {
    expect(index.chunksToEmbed('m').length).toBe(index.stats().chunks);
    index.remove('Assets/AI/Fourth.cs');
    expect(index.definitionsOf('Fourth')).toHaveLength(0);
    expect(index.stats().files).toBe(6);
  });
});

describe('project summary', () => {
  it('detects Unity, Node and Python stacks and their test frameworks', () => {
    const r = detectFrameworks([
      { path: 'UnityProject/ProjectSettings/ProjectVersion.txt', text: 'm_EditorVersion: 6000.6.0f1\n' },
      { path: 'UnityProject/Packages/manifest.json', text: '{"dependencies":{"com.unity.test-framework":"1.4.5"}}' },
      { path: 'web/package.json', text: '{"dependencies":{"react":"19"},"devDependencies":{"vitest":"5"}}' },
      { path: 'api/requirements.txt', text: 'fastapi==0.1\npytest\n' },
    ]);
    expect(r.frameworks).toEqual(expect.arrayContaining(['Unity 6000.6.0f1', 'React', 'FastAPI']));
    expect(r.testFrameworks).toEqual(expect.arrayContaining(['Unity Test Framework (NUnit)', 'Vitest', 'pytest']));
    expect(testFrameworkFor('csharp', { frameworks: r.frameworks, testFrameworks: r.testFrameworks })).toMatch(/Unity Test Framework/);
    expect(testFrameworkFor('python', { frameworks: [], testFrameworks: [] })).toBe('pytest');
  });
});

describe('similarity', () => {
  it('finds the most similar window', () => {
    const lines = ['function a() {', '  return 1;', '}', ...Array.from({ length: 40 }, () => 'noop();'), 'function chaseIntruder(guard, intruder) {', '  guard.target = intruder;', '  guard.speed = runSpeed;', '}'];
    const win = new WindowIndex(lines, 10, 5);
    const best = win.best(similarityTokens('guard.target = nearestIntruder; guard.speed = runSpeed'))!;
    expect(best.startLine).toBeGreaterThanOrEqual(35);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
  });
});
