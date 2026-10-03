import { LocalHttpClient } from './http';
import { LlamaCppProvider } from './llamacpp';
import { OllamaProvider } from './ollama';
import { OpenAiCompatibleProvider } from './openaiCompatible';
import { DEFAULT_ENDPOINTS, type ModelProvider, type ProviderKind } from './types';

/** Creates (and reuses) one provider instance per server kind + endpoint. */
export class ProviderRegistry {
  private readonly cache = new Map<string, ModelProvider>();

  constructor(private readonly http: LocalHttpClient) {}

  get(kind: ProviderKind, endpoint?: string): ModelProvider {
    const baseUrl = (endpoint && endpoint.trim()) || DEFAULT_ENDPOINTS[kind];
    const key = `${kind}|${baseUrl}`;
    let provider = this.cache.get(key);
    if (!provider) {
      provider = createProvider(kind, baseUrl, this.http);
      this.cache.set(key, provider);
    }
    return provider;
  }

  clear(): void {
    this.cache.clear();
  }
}

export function createProvider(kind: ProviderKind, baseUrl: string, http: LocalHttpClient): ModelProvider {
  switch (kind) {
    case 'ollama':
      return new OllamaProvider(baseUrl, http);
    case 'llamacpp':
      return new LlamaCppProvider(baseUrl, http);
    case 'lmstudio':
    case 'openai-compatible':
      return new OpenAiCompatibleProvider(kind, baseUrl, http);
  }
}
