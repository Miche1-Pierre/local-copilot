// Providers against in-process mock servers bound to 127.0.0.1.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtinTemplate } from '../../src/core/fim/templates';
import { LocalOnlyPolicy } from '../../src/core/policy/localOnly';
import { LocalHttpClient } from '../../src/core/providers/http';
import { LlamaCppProvider } from '../../src/core/providers/llamacpp';
import { OllamaProvider } from '../../src/core/providers/ollama';
import { OpenAiCompatibleProvider } from '../../src/core/providers/openaiCompatible';
import { ProviderError, type FimInput } from '../../src/core/providers/types';

type Handler = (req: IncomingMessage, body: any, res: ServerResponse) => void;

let server: Server;
let base = '';
const routes = new Map<string, Handler>();
const received: { path: string; body: any }[] = [];
let lastClosedEarly = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      received.push({ path: req.url ?? '', body });
      const handler = routes.get(`${req.method} ${req.url}`);
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `model '${body?.model ?? '?'}' not found` }));
        return;
      }
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const http = () => new LocalHttpClient(new LocalOnlyPolicy());
const fimInput: FimInput = { prefix: 'def f():\n    ', suffix: '\n', path: 'a.py', languageId: 'python', repoName: 'r', contextFiles: [] };

function ndjson(res: ServerResponse, lines: object[], delayMs = 0): void {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  let i = 0;
  const next = () => {
    if (res.destroyed) {
      lastClosedEarly = true;
      return;
    }
    if (i >= lines.length) {
      res.end();
      return;
    }
    res.write(`${JSON.stringify(lines[i++])}\n`);
    setTimeout(next, delayMs);
  };
  res.on('close', () => {
    if (i < lines.length) lastClosedEarly = true;
  });
  next();
}

describe('OllamaProvider', () => {
  it('sends raw FIM prompts with the template and options', async () => {
    routes.set('POST /api/generate', (_req, _body, res) =>
      ndjson(res, [{ response: 'return ' }, { response: '42' }, { done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 2, eval_duration: 20e6, load_duration: 1e6, prompt_eval_duration: 5e6 }]),
    );
    const p = new OllamaProvider(base, http());
    const r = await p.fim({ model: 'qwen2.5-coder:3b-base', input: fimInput, template: builtinTemplate('qwen'), options: { maxTokens: 32, contextLength: 4096, keepAlive: '30m', stop: ['\n'] } });
    expect(r.text).toBe('return 42');
    expect(r.stats.outputTokens).toBe(2);
    expect(r.stats.tokensPerSecond).toBeCloseTo(100);
    const sent = received.at(-1)!.body;
    expect(sent.raw).toBe(true);
    expect(sent.prompt).toContain('<|fim_prefix|>def f():');
    expect(sent.options).toMatchObject({ num_predict: 32, num_ctx: 4096 });
    expect(sent.options.stop).toEqual(expect.arrayContaining(['<|endoftext|>', '\n']));
    expect(sent.keep_alive).toBe('30m');
  });

  it('uses the native suffix field in native mode', async () => {
    const p = new OllamaProvider(base, http());
    await p.fim({ model: 'm', input: fimInput, template: builtinTemplate('native'), options: { maxTokens: 8 } });
    const sent = received.at(-1)!.body;
    expect(sent.raw).toBeUndefined();
    expect(sent.suffix).toBe('\n');
  });

  it('stops generation early and closes the connection', async () => {
    lastClosedEarly = false;
    routes.set('POST /api/generate', (_req, _body, res) => ndjson(res, Array.from({ length: 50 }, () => ({ response: 'x\n' })), 10));
    const p = new OllamaProvider(base, http());
    const r = await p.fim({ model: 'm', input: fimInput, template: builtinTemplate('qwen'), options: { maxTokens: 64 }, onDelta: (_d, acc) => (acc.length >= 6 ? 'stop' : undefined) });
    expect(r.text).toBe('x\nx\nx\n');
    expect(r.stats.stoppedEarly).toBe(true);
    await new Promise((res) => setTimeout(res, 100));
    expect(lastClosedEarly).toBe(true);
  });

  it('streams chat content and thinking, forwards think and format', async () => {
    routes.set('POST /api/chat', (_req, _body, res) =>
      ndjson(res, [{ message: { thinking: 'hmm' } }, { message: { content: 'Hello' } }, { message: { content: ' world' } }, { done: true, eval_count: 2, eval_duration: 10e6 }]),
    );
    const deltas: string[] = [];
    const p = new OllamaProvider(base, http());
    const r = await p.chat({ model: 'qwen3.5:9b', messages: [{ role: 'user', content: 'hi' }], think: false, jsonSchema: { type: 'object' }, options: { maxTokens: 10 }, onDelta: (d) => void deltas.push(d.text ?? `[${d.thinking}]`) });
    expect(r.text).toBe('Hello world');
    expect(r.thinking).toBe('hmm');
    expect(deltas).toEqual(['[hmm]', 'Hello', ' world']);
    const sent = received.at(-1)!.body;
    expect(sent.think).toBe(false);
    expect(sent.format).toEqual({ type: 'object' });
  });

  it('lists models and flags remote ones', async () => {
    routes.set('GET /api/tags', (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:3b-base', size: 1, capabilities: ['completion', 'insert'] }, { name: 'gpt-oss:120b-cloud', remote_host: 'https://ollama.com:443' }] }));
    });
    const models = await new OllamaProvider(base, http()).listModels();
    expect(models.map((m) => [m.name, m.remote])).toEqual([
      ['qwen2.5-coder:3b-base', false],
      ['gpt-oss:120b-cloud', true],
    ]);
  });

  it('maps a missing model to model_not_found', async () => {
    const err = await new OllamaProvider(base, http()).chat({ model: 'nope', messages: [], options: { maxTokens: 1 } }).catch((e) => e);
    routes.delete('POST /api/chat');
    const err2 = await new OllamaProvider(base, http()).chat({ model: 'nope', messages: [], options: { maxTokens: 1 } }).catch((e) => e);
    expect(err).toBeDefined();
    expect(err2).toBeInstanceOf(ProviderError);
    expect((err2 as ProviderError).code).toBe('model_not_found');
  });

  it('embeds a batch', async () => {
    routes.set('POST /api/embed', (_req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ embeddings: body.input.map((_: string, i: number) => [i, 1]) }));
    });
    expect(await new OllamaProvider(base, http()).embed({ model: 'e', inputs: ['a', 'b'] })).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });
});

function sse(res: ServerResponse, events: object[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.end('data: [DONE]\n\n');
}

describe('OpenAI-compatible and llama.cpp providers', () => {
  it('streams completions and chat over SSE', async () => {
    routes.set('POST /v1/completions', (_req, _body, res) => sse(res, [{ choices: [{ text: 'a' }] }, { choices: [{ text: 'b', finish_reason: 'stop' }] }]));
    routes.set('POST /v1/chat/completions', (_req, _body, res) => sse(res, [{ choices: [{ delta: { reasoning_content: 'r' } }] }, { choices: [{ delta: { content: 'ok' } }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }]));
    const p = new OpenAiCompatibleProvider('lmstudio', base, http());
    const fim = await p.fim({ model: 'm', input: fimInput, template: builtinTemplate('qwen'), options: { maxTokens: 8 } });
    expect(fim.text).toBe('ab');
    expect(received.at(-1)!.body.prompt).toContain('<|fim_middle|>');
    const chat = await p.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], think: false, jsonSchema: { type: 'object' }, options: { maxTokens: 8 } });
    expect(chat.text).toBe('ok');
    expect(chat.thinking).toBe('r');
    expect(chat.stats.outputTokens).toBe(1);
    expect(received.at(-1)!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(received.at(-1)!.body.response_format.type).toBe('json_schema');
  });

  it('refuses native FIM on non-Ollama servers', async () => {
    const p = new OpenAiCompatibleProvider('openai-compatible', base, http());
    await expect(p.fim({ model: 'm', input: fimInput, template: builtinTemplate('native'), options: { maxTokens: 8 } })).rejects.toBeInstanceOf(ProviderError);
  });

  it('uses llama.cpp /infill with repository context', async () => {
    routes.set('POST /infill', (_req, _body, res) => sse(res, [{ content: 'pass' }, { content: '', stop: true, timings: { predicted_n: 1, predicted_per_second: 120 } }]));
    const p = new LlamaCppProvider(base, http());
    const r = await p.fim({ model: 'm', input: { ...fimInput, contextFiles: [{ path: 'b.py', content: 'x = 1' }] }, template: builtinTemplate('qwen'), options: { maxTokens: 8 } });
    expect(r.text).toBe('pass');
    expect(r.stats.tokensPerSecond).toBe(120);
    expect(received.at(-1)!.body.input_extra).toEqual([{ filename: 'b.py', text: 'x = 1' }]);
  });
});
