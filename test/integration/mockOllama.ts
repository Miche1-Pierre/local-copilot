// A tiny Ollama look-alike for integration tests: deterministic answers, bound to 127.0.0.1.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockOllama {
  url: string;
  requests: { path: string; body: any }[];
  close(): Promise<void>;
}

const MODELS = [
  { name: 'qwen2.5-coder:3b-base', size: 1_900_000_000, capabilities: ['completion', 'insert'], details: { parameter_size: '3.1B', quantization_level: 'Q4_K_M', family: 'qwen2' } },
  { name: 'qwen3.5:9b', size: 6_600_000_000, capabilities: ['completion', 'thinking', 'tools'], details: { parameter_size: '9B', quantization_level: 'Q4_K_M', family: 'qwen35' } },
  { name: 'qwen3-embedding:0.6b', size: 640_000_000, capabilities: ['embedding'], details: { parameter_size: '0.6B', quantization_level: 'Q8_0', family: 'qwen3' } },
  { name: 'gpt-oss:120b-cloud', remote_host: 'https://ollama.com:443', capabilities: ['completion'] },
];

function chatAnswer(body: any): string {
  const user: string = body.messages?.[body.messages.length - 1]?.content ?? '';
  const schema = body.format?.properties ?? {};
  if (schema.staticVerdicts) {
    return JSON.stringify({
      summary: 'The query is built with an f-string from a request parameter.',
      staticVerdicts: [{ id: 'S1', verdict: 'confirmed', reason: 'name comes from request.args without parameterisation' }],
      findings: [{ line: 10, severity: 'medium', cwe: 'CWE-404', title: 'Connection never closed', explanation: 'conn is not closed.', suggestion: 'Use a with block.', excerpt: 'conn = sqlite3.connect("users.db")', confidence: 'medium' }],
    });
  }
  if (schema.findings) {
    return JSON.stringify({ summary: 'One real problem.', findings: [{ line: 10, severity: 'error', category: 'bug', title: 'Division by zero on empty input', explanation: 'values.length can be 0.', suggestion: 'Return 0 for an empty array.', excerpt: 'return total / values.length;' }] });
  }
  if (user.includes('Refactor the code under analysis')) {
    return 'Here is the refactor:\n```ts\nexport function average(values: number[]): number {\n  if (values.length === 0) return 0;\n  return values.reduce((sum, v) => sum + v, 0) / values.length;\n}\n```\nUses reduce.';
  }
  if (user.includes('Write unit tests')) return '```ts\n// test/math.test.ts\nimport { clamp } from "../src/math";\n```';
  if (user.includes('documentation comment')) return '```ts\n/** Clamps a value between min and max. */\n```';
  if (user.includes('<CURSOR>')) return '```csharp\npublic void Heal(int amount)\n{\n    currentHealth = Mathf.Min(currentHealth + amount, maxHealth);\n}\n```';
  if (user.includes('## Question')) return 'Users are looked up in `src/auth.py:9-13` by `find_user`.';
  return 'This function clamps a value between `min` and `max` (L1-L3).';
}

export async function startMockOllama(): Promise<MockOllama> {
  const requests: { path: string; body: any }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ path: req.url ?? '', body });
      const json = (data: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const stream = (pieces: object[]) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for (const p of pieces) res.write(`${JSON.stringify(p)}\n`);
        res.end();
      };
      switch (req.url) {
        case '/api/version':
          return json({ version: '0.35.1-mock' });
        case '/api/tags':
          return json({ models: MODELS });
        case '/api/ps':
          return json({ models: [{ name: 'qwen2.5-coder:3b-base', size: 2e9, size_vram: 2e9, context_length: 4096 }] });
        case '/api/show':
          return json({ capabilities: MODELS.find((m) => m.name === body?.model)?.capabilities ?? [] });
        case '/api/generate':
          if (!body?.prompt) return json({ done: true, done_reason: 'load' });
          return stream([{ response: 'return a' }, { response: ' + b;' }, { done: true, done_reason: 'stop', eval_count: 4, eval_duration: 40e6, prompt_eval_count: 50 }]);
        case '/api/chat': {
          const answer = chatAnswer(body);
          const pieces: object[] = [];
          if (body?.think === true) pieces.push({ message: { thinking: 'Let me think about it.' } });
          for (let i = 0; i < answer.length; i += 24) pieces.push({ message: { content: answer.slice(i, i + 24) } });
          pieces.push({ done: true, done_reason: 'stop', eval_count: Math.ceil(answer.length / 4), eval_duration: 100e6, prompt_eval_count: 200 });
          return stream(pieces);
        }
        case '/api/embed': {
          const vec = (s: string) => Array.from({ length: 8 }, (_, i) => ((s.charCodeAt(i % s.length) || 1) % 13) + i);
          return json({ embeddings: (body.input as string[]).map(vec) });
        }
        default:
          return json({ error: 'not found' }, 404);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
