import { LocalOnlyPolicy } from '../policy/localOnly';
import { anySignal, isCancellation } from '../util/async';
import { ProviderError } from './types';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Max time to receive response headers (includes model load for streaming endpoints). */
  timeoutMs?: number;
}

/**
 * The only HTTP entry point of the extension. Every request is checked against
 * the local-only policy, redirects are refused (a local server cannot bounce us
 * to a remote host), and errors are normalised into ProviderError.
 */
export class LocalHttpClient {
  constructor(
    private readonly policy: LocalOnlyPolicy,
    private readonly fetchImpl: FetchFn = (input, init) => fetch(input, init),
  ) {}

  async request(url: string, opts: RequestOptions = {}): Promise<Response> {
    this.policy.assertAllowed(url);
    const timeout = new AbortController();
    const timer = opts.timeoutMs ? setTimeout(() => timeout.abort(new Error('timeout')), opts.timeoutMs) : undefined;
    const signal = anySignal([opts.signal, timeout.signal]);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
        headers: opts.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal,
        redirect: 'error',
      });
    } catch (err) {
      if (timeout.signal.aborted && !opts.signal?.aborted) {
        throw new ProviderError(`No response from ${new URL(url).host} within ${Math.round((opts.timeoutMs ?? 0) / 1000)}s.`, 'timeout');
      }
      if (isCancellation(err) || opts.signal?.aborted) throw err;
      throw new ProviderError(`Cannot reach ${new URL(url).origin}: ${describeNetworkError(err)}`, 'unreachable');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const message = extractErrorMessage(text) || `${res.status} ${res.statusText}`;
      const notFound = res.status === 404 && /model|not found/i.test(message);
      throw new ProviderError(message, notFound ? 'model_not_found' : 'http', res.status);
    }
    return res;
  }

  async json<T>(url: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(url, opts);
    try {
      return (await res.json()) as T;
    } catch {
      throw new ProviderError(`Invalid JSON from ${url}`, 'bad_response');
    }
  }
}

function describeNetworkError(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code === 'ECONNREFUSED') return 'connection refused (is the server running?)';
  return cause?.message ?? (err as Error).message ?? String(err);
}

function extractErrorMessage(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { error?: string | { message?: string }; message?: string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 300);
}

/**
 * Yields text lines of a streamed body. Aborts the stream when no byte arrives
 * for `idleTimeoutMs` (a stuck server must not hang the editor forever).
 */
export async function* readLines(body: ReadableStream<Uint8Array> | null, idleTimeoutMs = 120_000): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderError(`Stream stalled for ${idleTimeoutMs / 1000}s`, 'timeout')), idleTimeoutMs);
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer.replace(/\r$/, '');
  } finally {
    reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Newline-delimited JSON (Ollama streaming). */
export async function* readNdjson<T>(body: ReadableStream<Uint8Array> | null, idleTimeoutMs?: number): AsyncGenerator<T> {
  for await (const line of readLines(body, idleTimeoutMs)) {
    if (!line.trim()) continue;
    let parsed: T & { error?: string };
    try {
      parsed = JSON.parse(line) as T & { error?: string };
    } catch {
      throw new ProviderError(`Malformed stream line: ${line.slice(0, 120)}`, 'bad_response');
    }
    if (typeof parsed.error === 'string') throw new ProviderError(parsed.error, /not found/i.test(parsed.error) ? 'model_not_found' : 'http');
    yield parsed as T;
  }
}

/** Server-sent events with JSON payloads (OpenAI-compatible streaming). Stops at [DONE]. */
export async function* readSse<T>(body: ReadableStream<Uint8Array> | null, idleTimeoutMs?: number): AsyncGenerator<T> {
  let data: string[] = [];
  for await (const line of readLines(body, idleTimeoutMs)) {
    if (line.startsWith(':')) continue;
    if (line === '') {
      if (data.length === 0) continue;
      const payload = data.join('\n');
      data = [];
      if (payload.trim() === '[DONE]') return;
      yield parseSsePayload<T>(payload);
      continue;
    }
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length > 0) {
    const payload = data.join('\n');
    if (payload.trim() !== '[DONE]') yield parseSsePayload<T>(payload);
  }
}

function parseSsePayload<T>(payload: string): T {
  let parsed: T & { error?: string | { message?: string } };
  try {
    parsed = JSON.parse(payload) as T & { error?: string | { message?: string } };
  } catch {
    throw new ProviderError(`Malformed event: ${payload.slice(0, 120)}`, 'bad_response');
  }
  if (parsed.error) throw new ProviderError(typeof parsed.error === 'string' ? parsed.error : (parsed.error.message ?? 'server error'), 'http');
  return parsed;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
