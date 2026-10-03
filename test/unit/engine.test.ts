import { describe, expect, it } from 'vitest';
import { CompletionCache } from '../../src/core/completion/cache';
import { InlineCompletionEngine, type InlineRequest, type InlineSettings } from '../../src/core/completion/engine';
import { builtinTemplate } from '../../src/core/fim/templates';
import { MetricsStore } from '../../src/core/metrics/metrics';
import type { FimRequest, GenerationResult, ModelProvider } from '../../src/core/providers/types';
import { CancelledError } from '../../src/core/util/async';

const SETTINGS: InlineSettings = {
  model: 'qwen2.5-coder:3b-base',
  debounceMs: 20,
  multiline: 'auto',
  maxTokens: 48,
  maxTokensMultiline: 256,
  maxLines: 30,
  temperature: 0.1,
  contextLength: 4096,
  prefixTokens: 1600,
  suffixTokens: 400,
  repoContextTokens: 0,
  keepAlive: '30m',
};

class FakeProvider implements ModelProvider {
  readonly kind = 'ollama' as const;
  readonly baseUrl = 'http://127.0.0.1:11434';
  calls: FimRequest[] = [];
  constructor(
    private readonly answer: string,
    private readonly delayMs = 0,
  ) {}
  async serverInfo() {
    return { kind: this.kind, baseUrl: this.baseUrl };
  }
  async listModels() {
    return [];
  }
  async fim(req: FimRequest): Promise<GenerationResult> {
    this.calls.push(req);
    let acc = '';
    for (const ch of this.answer.match(/[\s\S]{1,4}/g) ?? []) {
      if (req.signal?.aborted) throw new CancelledError();
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      acc += ch;
      if (req.onDelta?.({ text: ch }, acc) === 'stop') break;
    }
    if (req.signal?.aborted) throw new CancelledError();
    return { text: acc, stats: { model: req.model, totalMs: 1, outputTokens: 5, tokensPerSecond: 100 } };
  }
  async chat(): Promise<GenerationResult> {
    throw new Error('not used');
  }
  async embed(): Promise<number[][]> {
    return [];
  }
}

function request(over: Partial<InlineRequest> = {}): InlineRequest {
  const prefix = over.prefix ?? 'function clamp(value, min, max) {\n  return ';
  return {
    docKey: 'file:///a.ts',
    offset: prefix.length,
    prefix,
    suffix: '\n}\n',
    line: { linePrefix: '  return ', lineSuffix: '', previousLines: ['function clamp(value, min, max) {'], nextLines: ['}'], languageId: 'typescript' },
    path: 'a.ts',
    languageId: 'typescript',
    repoName: 'demo',
    explicit: false,
    ...over,
  };
}

function engineWith(provider: FakeProvider, settings: Partial<InlineSettings> = {}) {
  const metrics = new MetricsStore();
  const engine = new InlineCompletionEngine({
    provider: () => provider,
    settings: () => ({ ...SETTINGS, ...settings }),
    template: async () => builtinTemplate('qwen'),
    metrics,
  });
  return { engine, metrics };
}

describe('InlineCompletionEngine', () => {
  it('completes a line and records metrics', async () => {
    const provider = new FakeProvider('Math.min(Math.max(value, min), max);\n}');
    const { engine, metrics } = engineWith(provider);
    const r = await engine.complete(request(), new AbortController().signal);
    expect(r?.text).toBe('Math.min(Math.max(value, min), max);');
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].options.stop).toEqual(['\n']);
    expect(provider.calls[0].input.path).toBe('a.ts');
    expect(metrics.summary().inline.requests).toBe(1);
  });

  it('debounces: a cancelled request never reaches the model', async () => {
    const provider = new FakeProvider('x;');
    const { engine } = engineWith(provider, { debounceMs: 50 });
    const ctrl = new AbortController();
    const pending = engine.complete(request(), ctrl.signal);
    ctrl.abort();
    expect(await pending).toBeUndefined();
    expect(provider.calls).toHaveLength(0);
  });

  it('serves type-ahead from the cache without a new request', async () => {
    const provider = new FakeProvider('Math.min(Math.max(value, min), max);');
    const { engine } = engineWith(provider);
    await engine.complete(request(), new AbortController().signal);
    const typed = 'Math.m';
    const next = request({ prefix: `function clamp(value, min, max) {\n  return ${typed}`, line: { linePrefix: `  return ${typed}`, lineSuffix: '', previousLines: [], nextLines: ['}'], languageId: 'typescript' } });
    const r = await engine.complete(next, new AbortController().signal);
    expect(r?.fromCache).toBe(true);
    expect(r?.text).toBe('in(Math.max(value, min), max);');
    expect(provider.calls).toHaveLength(1);
  });

  it('supersedes an in-flight request (single flight)', async () => {
    const provider = new FakeProvider('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;', 5);
    const { engine } = engineWith(provider, { debounceMs: 0 });
    const first = engine.complete(request(), new AbortController().signal);
    await new Promise((r) => setTimeout(r, 15));
    const second = engine.complete(request({ docKey: 'file:///b.ts' }), new AbortController().signal);
    expect(await first).toBeUndefined();
    expect((await second)?.text).toContain('aaaa');
  });

  it('stops streaming once a block is complete', async () => {
    const provider = new FakeProvider('\n    return a + b\n\ndef other():\n    pass\n    pass\n    pass\n');
    const { engine } = engineWith(provider);
    const r = await engine.complete(
      request({ languageId: 'python', prefix: 'def add(a, b):', suffix: '\n', line: { linePrefix: 'def add(a, b):', lineSuffix: '', previousLines: [], nextLines: [], languageId: 'python' } }),
      new AbortController().signal,
    );
    expect(r?.text).toBe('\n    return a + b');
    expect(r?.mode).toBe('multi');
  });

  it('skips the middle of a line unless explicitly invoked', async () => {
    const provider = new FakeProvider('x');
    const { engine } = engineWith(provider);
    const mid = request({ line: { linePrefix: 'const a = ', lineSuffix: 'b + c;', previousLines: [], nextLines: [], languageId: 'typescript' } });
    expect(await engine.complete(mid, new AbortController().signal)).toBeUndefined();
    expect(provider.calls).toHaveLength(0);
  });
});

describe('CompletionCache', () => {
  it('only serves type-ahead when the typed text matches the suggestion', () => {
    const cache = new CompletionCache();
    cache.store('doc', 10, '0123456789', 'S', 'm', { text: 'hello()', replaceLineSuffix: false });
    expect(cache.lookup('doc', 10, '0123456789', 'S', 'm')?.text).toBe('hello()');
    expect(cache.lookup('doc', 12, '0123456789he', 'S', 'm')?.text).toBe('llo()');
    expect(cache.lookup('doc', 12, '0123456789xx', 'S', 'm')).toBeUndefined();
    expect(cache.lookup('doc', 12, '0123456789he', 'OTHER', 'm')).toBeUndefined();
    expect(cache.lookup('doc', 12, '0123456789he', 'S', 'other-model')).toBeUndefined();
    expect(cache.lookup('doc', 17, '0123456789hello()', 'S', 'm')).toBeUndefined();
  });
});
