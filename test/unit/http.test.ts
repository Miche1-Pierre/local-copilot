import { describe, expect, it } from 'vitest';
import { LocalOnlyPolicy, LocalOnlyViolation } from '../../src/core/policy/localOnly';
import { LocalHttpClient, readNdjson, readSse } from '../../src/core/providers/http';
import { ProviderError } from '../../src/core/providers/types';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe('readNdjson', () => {
  it('reassembles lines split across chunks', async () => {
    const items = await collect(readNdjson<{ response: string }>(streamOf(['{"respo', 'nse":"a"}\n{"response":', '"b"}\n', '{"response":"c"}'])));
    expect(items.map((i) => i.response)).toEqual(['a', 'b', 'c']);
  });

  it('surfaces server errors', async () => {
    await expect(collect(readNdjson(streamOf(['{"error":"model \\"x\\" not found"}\n'])))).rejects.toBeInstanceOf(ProviderError);
  });

  it('handles multi-byte characters split between chunks', async () => {
    const bytes = new TextEncoder().encode('{"response":"é€"}\n');
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 14));
        c.enqueue(bytes.slice(14));
        c.close();
      },
    });
    const [item] = await collect(readNdjson<{ response: string }>(stream));
    expect(item.response).toBe('é€');
  });
});

describe('readSse', () => {
  it('parses data events and stops at [DONE]', async () => {
    const items = await collect(readSse<{ choices: { text: string }[] }>(streamOf(['data: {"choices":[{"text":"x"}]}\n\n', ': keep-alive\n\n', 'data: {"choices":[{"text":"y"}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"text":"z"}]}\n\n'])));
    expect(items.map((i) => i.choices[0].text)).toEqual(['x', 'y']);
  });
});

describe('LocalHttpClient', () => {
  it('never calls fetch for a non-loopback URL', async () => {
    let calls = 0;
    const client = new LocalHttpClient(new LocalOnlyPolicy(), async () => {
      calls++;
      return new Response('{}');
    });
    await expect(client.request('http://8.8.8.8/api/tags')).rejects.toBeInstanceOf(LocalOnlyViolation);
    expect(calls).toBe(0);
  });

  it('refuses redirects and maps HTTP errors', async () => {
    let seen: RequestInit | undefined;
    const client = new LocalHttpClient(new LocalOnlyPolicy(), async (_url, init) => {
      seen = init;
      return new Response(JSON.stringify({ error: "model 'nope' not found" }), { status: 404 });
    });
    const err = await client.request('http://127.0.0.1:11434/api/generate', { body: { model: 'nope' } }).catch((e) => e);
    expect(seen?.redirect).toBe('error');
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('model_not_found');
  });

  it('reports a refused connection as unreachable', async () => {
    const client = new LocalHttpClient(new LocalOnlyPolicy(), async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    const err = (await client.request('http://127.0.0.1:1/').catch((e) => e)) as ProviderError;
    expect(err.code).toBe('unreachable');
    expect(err.message).toMatch(/refused/);
  });
});
