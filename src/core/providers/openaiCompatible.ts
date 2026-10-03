import { anySignal, isCancellation } from '../util/async';
import { LocalHttpClient, joinUrl, readSse } from './http';
import type {
  ChatRequest,
  Delta,
  DeltaHandler,
  EmbedRequest,
  FimRequest,
  GenerationResult,
  ModelCapability,
  ModelInfo,
  ModelProvider,
  ProviderKind,
  ServerInfo,
} from './types';
import { ProviderError } from './types';

interface CompletionChunk {
  choices?: { text?: string; delta?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  timings?: { prompt_n?: number; prompt_ms?: number; predicted_n?: number; predicted_ms?: number; predicted_per_second?: number };
}

/**
 * Any local server exposing the OpenAI REST shape (LM Studio, vLLM, LocalAI,
 * llama.cpp). FIM goes through /v1/completions with a raw template-built prompt.
 */
export class OpenAiCompatibleProvider implements ModelProvider {
  constructor(
    readonly kind: ProviderKind,
    readonly baseUrl: string,
    protected readonly http: LocalHttpClient,
  ) {}

  protected v1(path: string): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    return base.endsWith('/v1') ? joinUrl(base, path) : joinUrl(base, `/v1/${path}`);
  }

  protected get origin(): string {
    return this.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  }

  async serverInfo(signal?: AbortSignal): Promise<ServerInfo> {
    await this.http.json(this.v1('models'), { signal, timeoutMs: 5_000 });
    return { kind: this.kind, baseUrl: this.baseUrl };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    if (this.kind === 'lmstudio') {
      // LM Studio's native listing knows model types and context sizes.
      try {
        const res = await this.http.json<{ data?: { id: string; type?: string; quantization?: string; max_context_length?: number }[] }>(
          joinUrl(this.origin, '/api/v0/models'),
          { signal, timeoutMs: 5_000 },
        );
        return (res.data ?? []).map((m) => ({
          name: m.id,
          quantization: m.quantization,
          contextLength: m.max_context_length,
          capabilities: (m.type === 'embeddings' ? ['embedding'] : m.type === 'vlm' ? ['completion', 'vision'] : ['completion']) as ModelCapability[],
        }));
      } catch {
        /* fall back to the OpenAI listing */
      }
    }
    const res = await this.http.json<{ data?: { id: string }[] }>(this.v1('models'), { signal, timeoutMs: 10_000 });
    return (res.data ?? []).map((m) => ({ name: m.id }));
  }

  async fim(req: FimRequest): Promise<GenerationResult> {
    if (!req.template.build) {
      throw new ProviderError('The "native" FIM template needs Ollama. Pick an explicit template (e.g. qwen) for this server.', 'unsupported');
    }
    const stop = Array.from(new Set([...req.template.stop, ...(req.options.stop ?? [])]));
    const body = {
      model: req.model,
      prompt: req.template.build(req.input),
      max_tokens: req.options.maxTokens,
      temperature: req.options.temperature,
      top_p: req.options.topP,
      stop: stop.length > 0 ? stop : undefined,
      seed: req.options.seed,
      stream: true,
      stream_options: { include_usage: true },
    };
    return this.streamSse(this.v1('completions'), body, req.model, req.signal, req.onDelta, 60_000, (c) => ({ text: c.choices?.[0]?.text }));
  }

  async chat(req: ChatRequest): Promise<GenerationResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.options.maxTokens,
      temperature: req.options.temperature,
      top_p: req.options.topP,
      stop: req.options.stop && req.options.stop.length > 0 ? req.options.stop : undefined,
      seed: req.options.seed,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.jsonSchema) body.response_format = { type: 'json_schema', json_schema: { name: 'result', schema: req.jsonSchema, strict: false } };
    if (typeof req.think === 'boolean') body.chat_template_kwargs = { enable_thinking: req.think };
    return this.streamSse(this.v1('chat/completions'), body, req.model, req.signal, req.onDelta, 300_000, (c) => {
      const d = c.choices?.[0]?.delta;
      return { text: d?.content, thinking: d?.reasoning_content ?? d?.reasoning };
    });
  }

  async embed(req: EmbedRequest): Promise<number[][]> {
    const res = await this.http.json<{ data?: { embedding: number[]; index: number }[] }>(this.v1('embeddings'), {
      body: { model: req.model, input: req.inputs },
      signal: req.signal,
      timeoutMs: 120_000,
    });
    const data = (res.data ?? []).slice().sort((a, b) => a.index - b.index);
    if (data.length !== req.inputs.length) throw new ProviderError('Embedding response size mismatch', 'bad_response');
    return data.map((d) => d.embedding);
  }

  protected async streamSse(
    url: string,
    body: unknown,
    model: string,
    userSignal: AbortSignal | undefined,
    onDelta: DeltaHandler | undefined,
    headersTimeoutMs: number,
    pick: (c: CompletionChunk & { content?: string; stop?: boolean }) => Delta,
  ): Promise<GenerationResult> {
    const t0 = performance.now();
    const local = new AbortController();
    const res = await this.http.request(url, { body, signal: anySignal([userSignal, local.signal]), timeoutMs: headersTimeoutMs });
    let text = '';
    let thinking = '';
    let firstTokenMs: number | undefined;
    let usage: CompletionChunk['usage'];
    let timings: CompletionChunk['timings'];
    let doneReason: string | undefined;
    let stoppedEarly = false;
    try {
      for await (const chunk of readSse<CompletionChunk & { content?: string; stop?: boolean }>(res.body, 180_000)) {
        if (chunk.usage) usage = chunk.usage;
        if (chunk.timings) timings = chunk.timings;
        const finish = chunk.choices?.[0]?.finish_reason;
        if (finish) doneReason = finish;
        const delta = pick(chunk);
        if (delta.text || delta.thinking) {
          firstTokenMs ??= performance.now() - t0;
          if (delta.text) text += delta.text;
          if (delta.thinking) thinking += delta.thinking;
          if (onDelta?.(delta, text) === 'stop') {
            stoppedEarly = true;
            local.abort();
            break;
          }
        }
        if (chunk.stop === true) break;
      }
    } catch (err) {
      if (!(stoppedEarly && isCancellation(err))) throw err;
    }
    const totalMs = performance.now() - t0;
    const outputTokens = usage?.completion_tokens ?? timings?.predicted_n;
    return {
      text,
      thinking: thinking || undefined,
      stats: {
        model,
        promptTokens: usage?.prompt_tokens ?? timings?.prompt_n,
        outputTokens,
        firstTokenMs,
        totalMs,
        promptEvalMs: timings?.prompt_ms,
        evalMs: timings?.predicted_ms,
        tokensPerSecond: timings?.predicted_per_second ?? (outputTokens && firstTokenMs ? outputTokens / ((totalMs - firstTokenMs) / 1000) : undefined),
        doneReason: stoppedEarly ? 'client_stop' : doneReason,
        stoppedEarly,
      },
    };
  }
}
