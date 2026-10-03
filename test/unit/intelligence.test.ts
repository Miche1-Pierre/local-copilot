import { describe, expect, it } from 'vitest';
import { recommendModels, usableVramGB, type HardwareProfile } from '../../src/core/hardware/recommend';
import { classifyComment, directiveAt, findDirectives, looksLikeGenerationInstruction } from '../../src/core/intelligence/directives';
import { extractCodeBlocks, locateExcerpt, parseJsonLoose, primaryCode, stripThinkTags } from '../../src/core/intelligence/parse';
import { codebasePrompt, explainPrompt, reviewPrompt, securityPrompt } from '../../src/core/intelligence/prompts';
import { MetricsStore, percentile } from '../../src/core/metrics/metrics';

describe('parse', () => {
  it('extracts code blocks, preferring the file language', () => {
    const text = 'Here:\n```python\nprint(1)\n```\nand\n```csharp\nvar x = 1;\nvar y = 2;\n```\n';
    expect(extractCodeBlocks(text)).toHaveLength(2);
    expect(primaryCode(text, 'python')).toBe('print(1)');
    expect(primaryCode(text, 'csharp')).toBe('var x = 1;\nvar y = 2;');
    expect(primaryCode('```ts\nconst a = 1;', 'typescript')).toBe('const a = 1;');
    expect(primaryCode('plain code;')).toBe('plain code;');
  });

  it('parses JSON wrapped in prose, fences or with trailing commas', () => {
    expect(parseJsonLoose<{ a: number }>('{"a": 1}')?.a).toBe(1);
    expect(parseJsonLoose<{ a: number }>('Sure!\n```json\n{"a": 2,}\n```')?.a).toBe(2);
    expect(parseJsonLoose<{ a: number }>('<think>hmm {"a": 9}</think>\nResult: {"a": 3}')?.a).toBe(3);
    expect(parseJsonLoose('nothing here')).toBeUndefined();
  });

  it('strips reasoning tags, even unterminated', () => {
    expect(stripThinkTags('<think>x</think>answer')).toBe('answer');
    expect(stripThinkTags('<think>still thinking')).toBe('');
  });

  it('corrects model line numbers using the quoted excerpt', () => {
    const lines = ['a', 'b', 'cursor.execute("SELECT * FROM t WHERE id=" + uid)', 'd', 'e'];
    expect(locateExcerpt(lines, '  3| cursor.execute("SELECT * FROM t WHERE id=" + uid)', 0)).toBe(2);
    expect(locateExcerpt(lines, undefined, 4)).toBe(4);
    expect(locateExcerpt(lines, 'not present anywhere', 1)).toBe(1);
  });
});

describe('directives', () => {
  it('classifies analysis requests in English and French', () => {
    expect(classifyComment('Review the function below for security issues')).toBe('security');
    expect(classifyComment('Vérifie la sécurité de la fonction ci-dessous')).toBe('security');
    expect(classifyComment('Review this code')).toBe('review');
    expect(classifyComment('Explain this function')).toBe('explain');
    expect(classifyComment('Explique ce code')).toBe('explain');
    expect(classifyComment('Write unit tests for this class')).toBe('tests');
    expect(classifyComment('Écris des tests pour cette méthode')).toBe('tests');
    expect(classifyComment('Refactor this to use async/await')).toBe('refactor');
    expect(classifyComment('Add docstring')).toBe('document');
    expect(classifyComment('Fix the off-by-one error')).toBe('fix');
    expect(classifyComment('@local make it faster')).toBe('generate');
    expect(classifyComment('Increment the counter when the door opens')).toBeUndefined();
  });

  it('recognises generation instructions', () => {
    expect(looksLikeGenerationInstruction('Create a function that validates a French SIRET number')).toBe(true);
    expect(looksLikeGenerationInstruction('Implement a binary search over the sorted array')).toBe(true);
    expect(looksLikeGenerationInstruction('the player')).toBe(false);
  });

  it('finds directives worth a CodeLens', () => {
    const src = [
      '// Review the function below for security issues',
      'function auth(t) { return db.q("x" + t); }',
      '',
      '// Load the save file', // ordinary comment above code: no lens
      'const save = load();',
      '',
      '// Create a function that validates a French SIRET number',
      '',
    ].join('\n');
    const d = findDirectives(src, 'javascript');
    expect(d.map((x) => [x.kind, x.startLine])).toEqual([
      ['security', 0],
      ['generate', 6],
    ]);
  });

  it('finds the directive at or right above the cursor', () => {
    const src = '# Implement a binary search over the sorted array\n\nprint(1)\n';
    expect(directiveAt(src, 'python', 0)?.kind).toBe('generate');
    expect(directiveAt(src, 'python', 1)?.text).toBe('Implement a binary search over the sorted array');
    expect(directiveAt(src, 'python', 2)).toBeUndefined();
  });
});

describe('prompts', () => {
  const target = { path: 'src/auth.py', languageId: 'python', startLine: 10, code: 'def login(u):\n    return db.q(u)' };
  const env = { language: 'French', projectSummary: 'Frameworks: Flask', related: [{ path: 'src/db.py', startLine: 1, endLine: 3, label: 'defines q', languageId: 'python', text: 'def q(sql): ...' }] };

  it('numbers lines from the real start line and includes related code', () => {
    const [sys, user] = explainPrompt(target, env);
    expect(sys.content).toContain('Write explanations in French');
    expect(user.content).toContain('10| def login(u):');
    expect(user.content).toContain('11|     return db.q(u)');
    expect(user.content).toContain('### src/db.py:1-3 — defines q');
  });

  it('asks for JSON in review and security prompts and lists static findings', () => {
    expect(reviewPrompt(target, env, '@@ -1 +1 @@')[1].content).toContain('git diff');
    const sec = securityPrompt(target, env, '[S1] line 11 · CWE-89 · SQL injection');
    expect(sec[1].content).toContain('[S1] line 11');
    expect(sec[1].content).toContain('"staticVerdicts"');
  });

  it('cites excerpts with paths and lines in codebase questions', () => {
    const msgs = codebasePrompt('where is login?', [{ path: 'src/auth.py', startLine: 10, endLine: 11, languageId: 'python', text: 'def login' }], env);
    expect(msgs[1].content).toContain('### [1] src/auth.py:10-11');
  });
});

describe('hardware recommendations', () => {
  const laptop: HardwareProfile = { gpus: [{ name: 'Intel(R) Graphics', vramMB: 512, vendor: 'intel' }, { name: 'NVIDIA GeForce RTX 5070 Laptop GPU', vramMB: 8151, vendor: 'nvidia' }], totalRamMB: 32_000, platform: 'win32' };

  it('picks the benchmarked pair for an 8 GB GPU', () => {
    const r = recommendModels(laptop);
    expect(usableVramGB(laptop)).toBe(8);
    expect(r.autocomplete.model).toBe('qwen2.5-coder:3b-base');
    expect(r.chat.model).toBe('qwen3.5:9b');
    expect(r.embeddings.model).toBe('qwen3-embedding:0.6b');
    expect(r.notes.join(' ')).toContain('both stay loaded');
  });

  it('scales down and up', () => {
    expect(recommendModels({ gpus: [], totalRamMB: 16_000, platform: 'linux' }).autocomplete.model).toBe('qwen2.5-coder:1.5b-base');
    expect(recommendModels({ gpus: [{ name: 'RTX 4090', vramMB: 24_564, vendor: 'nvidia' }], totalRamMB: 64_000, platform: 'linux' }).chat.model).toBe('qwen3.6:27b');
    const mac = recommendModels({ gpus: [], totalRamMB: 32_768, platform: 'darwin', appleSilicon: true });
    expect(mac.tier).toBe('16-24 GB GPU');
  });
});

describe('metrics', () => {
  it('computes percentiles and acceptance', () => {
    expect(percentile([1, 2, 3, 4, 100], 0.5)).toBe(3);
    expect(percentile([], 0.5)).toBeUndefined();
    const m = new MetricsStore();
    for (const ms of [100, 200, 300]) m.record({ ts: 1, kind: 'inline', model: 'x', ms, outcome: 'ok', tps: 100 });
    m.record({ ts: 1, kind: 'inline', model: 'x', ms: 5, outcome: 'cached' });
    m.markShown();
    m.markShown();
    m.markAccepted();
    const s = m.summary();
    expect(s.inline.p50Ms).toBe(200);
    expect(s.inline.cacheHits).toBe(1);
    expect(s.inline.acceptanceRate).toBe(0.5);
    const copy = new MetricsStore();
    copy.load(JSON.parse(JSON.stringify(m.toJSON())));
    expect(copy.summary().inline.requests).toBe(4);
  });
});
