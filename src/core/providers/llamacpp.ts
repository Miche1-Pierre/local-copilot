import { LocalHttpClient, joinUrl } from './http';
import { OpenAiCompatibleProvider } from './openaiCompatible';
import type { FimRequest, GenerationResult, ServerInfo } from './types';
import { ProviderError } from './types';

/**
 * llama.cpp `llama-server`. Uses the native /infill endpoint, which applies the
 * model's own FIM tokens and accepts repository context (input_extra) — the
 * fastest completion path, with server-side prompt caching.
 */
export class LlamaCppProvider extends OpenAiCompatibleProvider {
  private infillUnsupported = false;

  constructor(baseUrl: string, http: LocalHttpClient) {
    super('llamacpp', baseUrl, http);
  }

  override async serverInfo(signal?: AbortSignal): Promise<ServerInfo> {
    const props = await this.http.json<{ build_info?: string }>(joinUrl(this.origin, '/props'), { signal, timeoutMs: 5_000 }).catch(() => undefined);
    if (!props) await this.http.json(joinUrl(this.origin, '/health'), { signal, timeoutMs: 5_000 });
    return { kind: this.kind, baseUrl: this.baseUrl, version: props?.build_info };
  }

  override async fim(req: FimRequest): Promise<GenerationResult> {
    if (req.template.id === 'custom' || this.infillUnsupported) return super.fim(req);
    const stop = Array.from(new Set([...req.template.stop, ...(req.options.stop ?? [])]));
    const body = {
      input_prefix: req.input.prefix,
      input_suffix: req.input.suffix,
      input_extra: req.input.contextFiles.map((f) => ({ filename: f.path, text: f.content })),
      prompt: '',
      n_predict: req.options.maxTokens,
      temperature: req.options.temperature,
      top_p: req.options.topP,
      stop: stop.length > 0 ? stop : undefined,
      seed: req.options.seed,
      cache_prompt: true,
      stream: true,
    };
    try {
      return await this.streamSse(joinUrl(this.origin, '/infill'), body, req.model, req.signal, req.onDelta, 60_000, (c) => ({ text: c.content }));
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'http' && (err.status === 400 || err.status === 501)) {
        // Model without FIM tokens: fall back to a raw prompt on /v1/completions.
        this.infillUnsupported = true;
        return super.fim(req);
      }
      throw err;
    }
  }
}
