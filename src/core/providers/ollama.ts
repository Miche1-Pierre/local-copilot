import { contextAsComments } from '../fim/templates';
import { anySignal, isCancellation } from '../util/async';
import { LocalHttpClient, joinUrl, readNdjson } from './http';
import type {
  ChatRequest,
  Delta,
  DeltaHandler,
  EmbedRequest,
  FimRequest,
  GenerationResult,
  LoadedModel,
  ModelCapability,
  ModelInfo,
  ModelProvider,
  PullProgress,
  SamplingOptions,
  ServerInfo,
} from './types';
import { ProviderError } from './types';

interface OllamaTag {
  name: string;
  size?: number;
  details?: { family?: string; parameter_size?: string; quantization_level?: string; context_length?: number };
  capabilities?: string[];
  remote_host?: string;
  remote_model?: string;
}

interface OllamaChunk {
  response?: string;
  thinking?: string;
  message?: { content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

const FIM_HEADERS_TIMEOUT_MS = 60_000;
const CHAT_HEADERS_TIMEOUT_MS = 300_000;
const NS_PER_MS = 1e6;

function toOptions(o: SamplingOptions): Record<string, unknown> {
  return {
    num_predict: o.maxTokens,
    temperature: o.temperature,
    top_p: o.topP,
    top_k: o.topK,
    repeat_penalty: o.repeatPenalty,
    stop: o.stop && o.stop.length > 0 ? o.stop : undefined,
    num_ctx: o.contextLength,
    num_gpu: o.gpuLayers,
    seed: o.seed,
  };
}

export class OllamaProvider implements ModelProvider {
  readonly kind = 'ollama' as const;
  private readonly capabilityCache = new Map<string, ModelCapability[]>();

  constructor(
    readonly baseUrl: string,
    private readonly http: LocalHttpClient,
  ) {}

  async serverInfo(signal?: AbortSignal): Promise<ServerInfo> {
    const v = await this.http.json<{ version?: string }>(joinUrl(this.baseUrl, '/api/version'), { signal, timeoutMs: 5_000 });
    return { kind: this.kind, baseUrl: this.baseUrl, version: v.version };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await this.http.json<{ models?: OllamaTag[] }>(joinUrl(this.baseUrl, '/api/tags'), { signal, timeoutMs: 10_000 });
    const models = (res.models ?? []).map((m) => ({
      name: m.name,
      sizeBytes: m.size,
      family: m.details?.family,
      parameterSize: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
      contextLength: m.details?.context_length,
      capabilities: m.capabilities as ModelCapability[] | undefined,
      remote: Boolean(m.remote_host || m.remote_model),
    }));
    for (const m of models) if (m.capabilities) this.capabilityCache.set(m.name, m.capabilities);
    return models;
  }

  /** Capabilities from /api/tags (Ollama ≥ 0.12) or /api/show for older servers. */
  async capabilities(model: string, signal?: AbortSignal): Promise<ModelCapability[]> {
    const cached = this.capabilityCache.get(model);
    if (cached) return cached;
    try {
      const show = await this.http.json<{ capabilities?: string[] }>(joinUrl(this.baseUrl, '/api/show'), { body: { model }, signal, timeoutMs: 10_000 });
      const caps = (show.capabilities ?? []) as ModelCapability[];
      this.capabilityCache.set(model, caps);
      return caps;
    } catch {
      return [];
    }
  }

  /** Number of transformer blocks, from the model metadata (for GPU layer planning). */
  async blockCount(model: string, signal?: AbortSignal): Promise<number | undefined> {
    try {
      const show = await this.http.json<{ model_info?: Record<string, unknown> }>(joinUrl(this.baseUrl, '/api/show'), { body: { model }, signal, timeoutMs: 10_000 });
      const entry = Object.entries(show.model_info ?? {}).find(([k, v]) => /\.block_count$/.test(k) && !/vision/.test(k) && typeof v === 'number');
      return entry ? (entry[1] as number) : undefined;
    } catch {
      return undefined;
    }
  }

  async loadedModels(signal?: AbortSignal): Promise<LoadedModel[]> {
    const res = await this.http.json<{ models?: { name: string; size: number; size_vram: number; context_length?: number; expires_at?: string }[] }>(
      joinUrl(this.baseUrl, '/api/ps'),
      { signal, timeoutMs: 5_000 },
    );
    return (res.models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size, vramBytes: m.size_vram, contextLength: m.context_length, expiresAt: m.expires_at }));
  }

  async fim(req: FimRequest): Promise<GenerationResult> {
    const { input, template } = req;
    const stop = Array.from(new Set([...template.stop, ...(req.options.stop ?? [])]));
    const body: Record<string, unknown> = {
      model: req.model,
      stream: true,
      keep_alive: req.options.keepAlive,
      options: toOptions({ ...req.options, stop }),
    };
    if (template.build) {
      body.prompt = template.build(input);
      body.raw = true;
    } else {
      // Native mode: Ollama inserts the model's own FIM tokens around prompt/suffix.
      body.prompt = contextAsComments(input.contextFiles, input.languageId) + input.prefix;
      body.suffix = input.suffix;
    }
    return this.stream('/api/generate', body, req.model, req.signal, req.onDelta, FIM_HEADERS_TIMEOUT_MS, 60_000, (c) => ({ text: c.response, thinking: c.thinking }));
  }

  async chat(req: ChatRequest): Promise<GenerationResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      keep_alive: req.options.keepAlive,
      options: toOptions(req.options),
    };
    if (req.think !== undefined) body.think = req.think;
    if (req.jsonSchema) body.format = req.jsonSchema;
    return this.stream('/api/chat', body, req.model, req.signal, req.onDelta, CHAT_HEADERS_TIMEOUT_MS, 180_000, (c) => ({
      text: c.message?.content,
      thinking: c.message?.thinking,
    }));
  }

  async embed(req: EmbedRequest): Promise<number[][]> {
    const res = await this.http.json<{ embeddings?: number[][] }>(joinUrl(this.baseUrl, '/api/embed'), {
      body: { model: req.model, input: req.inputs, keep_alive: req.keepAlive, truncate: true },
      signal: req.signal,
      timeoutMs: 120_000,
    });
    if (!res.embeddings || res.embeddings.length !== req.inputs.length) {
      throw new ProviderError(`Embedding response size mismatch (${res.embeddings?.length ?? 0}/${req.inputs.length})`, 'bad_response');
    }
    return res.embeddings;
  }

  async warmup(model: string, keepAlive: string, contextLength?: number, signal?: AbortSignal): Promise<void> {
    // An empty prompt makes Ollama load the model and return immediately.
    await this.http.json(joinUrl(this.baseUrl, '/api/generate'), {
      body: { model, keep_alive: keepAlive, stream: false, options: contextLength ? { num_ctx: contextLength } : undefined },
      signal,
      timeoutMs: CHAT_HEADERS_TIMEOUT_MS,
    });
  }

  async pull(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    const res = await this.http.request(joinUrl(this.baseUrl, '/api/pull'), { body: { model, stream: true }, signal, timeoutMs: 60_000 });
    for await (const p of readNdjson<{ status?: string; total?: number; completed?: number }>(res.body, 300_000)) {
      onProgress({ status: p.status ?? '', total: p.total, completed: p.completed });
    }
  }

  private async stream(
    path: string,
    body: Record<string, unknown>,
    model: string,
    userSignal: AbortSignal | undefined,
    onDelta: DeltaHandler | undefined,
    headersTimeoutMs: number,
    idleTimeoutMs: number,
    pick: (c: OllamaChunk) => Delta,
  ): Promise<GenerationResult> {
    const t0 = performance.now();
    const local = new AbortController();
    const signal = anySignal([userSignal, local.signal]);
    const res = await this.http.request(joinUrl(this.baseUrl, path), { body, signal, timeoutMs: headersTimeoutMs });
    let text = '';
    let thinking = '';
    let firstTokenMs: number | undefined;
    let final: OllamaChunk | undefined;
    let stoppedEarly = false;
    try {
      for await (const chunk of readNdjson<OllamaChunk>(res.body, idleTimeoutMs)) {
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
        if (chunk.done) {
          final = chunk;
          break;
        }
      }
    } catch (err) {
      if (!(stoppedEarly && isCancellation(err))) throw err;
    }
    const evalMs = final?.eval_duration !== undefined ? final.eval_duration / NS_PER_MS : undefined;
    return {
      text,
      thinking: thinking || undefined,
      stats: {
        model,
        promptTokens: final?.prompt_eval_count,
        outputTokens: final?.eval_count,
        firstTokenMs,
        totalMs: performance.now() - t0,
        loadMs: final?.load_duration !== undefined ? final.load_duration / NS_PER_MS : undefined,
        promptEvalMs: final?.prompt_eval_duration !== undefined ? final.prompt_eval_duration / NS_PER_MS : undefined,
        evalMs,
        tokensPerSecond: final?.eval_count && evalMs ? final.eval_count / (evalMs / 1000) : undefined,
        doneReason: stoppedEarly ? 'client_stop' : final?.done_reason,
        stoppedEarly,
      },
    };
  }
}
