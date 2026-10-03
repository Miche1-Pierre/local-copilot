// Resolves servers and models per role, enforces the local-only policy (loopback
// endpoints, no cloud models), and wraps chat / embedding calls with metrics.

import { lookup } from 'node:dns/promises';
import * as vscode from 'vscode';
import { builtinTemplate, customTemplate, detectFimTemplate, type FimTemplate } from '../core/fim/templates';
import { planChatGpuLayers } from '../core/hardware/gpuPlan';
import { DEEP_TASKS } from '../core/intelligence/prompts';
import { embeddingPrefixes } from '../core/index/vectors';
import type { MetricsStore } from '../core/metrics/metrics';
import { isRemoteModel, LocalOnlyPolicy, LocalOnlyViolation } from '../core/policy/localOnly';
import { LocalHttpClient } from '../core/providers/http';
import { OllamaProvider } from '../core/providers/ollama';
import { ProviderRegistry } from '../core/providers/registry';
import type {
  ChatMessage,
  GenerationResult,
  LoadedModel,
  ModelCapability,
  ModelInfo,
  ModelProvider,
  ProviderKind,
  PullProgress,
  ThinkSetting,
} from '../core/providers/types';
import { isCancellation } from '../core/util/async';
import type { TaskKind } from '../webview/protocol';
import { nvidiaMemoryMB } from './hardware';
import type { Logger } from './logger';
import { connectionFor, settings, type RoleName } from './settings';

export interface HealthStatus {
  kind: ProviderKind;
  endpoint: string;
  reachable: boolean;
  version?: string;
  error?: string;
  localOnly: { ok: boolean; detail: string };
}

export interface ChatCallOptions {
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onDelta?: (delta: { text?: string; thinking?: string }) => void;
  /** Force reasoning on/off for this call; default follows the setting. */
  reasoning?: boolean;
  maxTokens?: number;
}

export interface ChatCallResult extends GenerationResult {
  model: string;
  reasoningUsed: boolean;
  reasoningAvailable: boolean;
}

function normalizeName(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}

export class ModelManager implements vscode.Disposable {
  readonly policy = new LocalOnlyPolicy(async (host) => (await lookup(host, { all: true })).map((a) => a.address));
  readonly http = new LocalHttpClient(this.policy);
  private readonly registry = new ProviderRegistry(this.http);
  private readonly blocked = new Map<string, string>();
  private readonly templates = new Map<string, FimTemplate>();
  private readonly capabilities = new Map<string, ModelCapability[]>();
  private readonly gpuPlans = new Map<string, number | undefined>();
  private modelList?: { at: number; key: string; models: ModelInfo[] };
  private autocompleteMaybeEvicted = false;
  private activeChats = 0;
  private health?: HealthStatus;
  private readonly healthEmitter = new vscode.EventEmitter<HealthStatus>();
  readonly onDidChangeHealth = this.healthEmitter.event;
  private readonly activityEmitter = new vscode.EventEmitter<number>();
  /** Fires with the number of analyses in flight. */
  readonly onDidChangeActivity = this.activityEmitter.event;

  constructor(
    private readonly log: Logger,
    private readonly metrics: MetricsStore,
  ) {}

  dispose(): void {
    this.healthEmitter.dispose();
    this.activityEmitter.dispose();
  }

  /** Forget cached state after a configuration change. */
  reset(): void {
    this.registry.clear();
    this.blocked.clear();
    this.templates.clear();
    this.capabilities.clear();
    this.gpuPlans.clear();
    this.modelList = undefined;
  }

  get lastHealth(): HealthStatus | undefined {
    return this.health;
  }

  get busyWithChat(): boolean {
    return this.activeChats > 0;
  }

  /** Synchronous provider access for the hot path. The HTTP client re-checks every URL anyway. */
  providerSync(role: RoleName): ModelProvider {
    const conn = connectionFor(role);
    const provider = this.registry.get(conn.kind, conn.endpoint);
    const reason = this.blocked.get(provider.baseUrl);
    if (reason) throw new LocalOnlyViolation(reason);
    this.policy.assertAllowed(provider.baseUrl);
    return provider;
  }

  async provider(role: RoleName): Promise<ModelProvider> {
    const provider = this.providerSync(role);
    const verdict = await this.policy.verifyEndpoint(provider.baseUrl);
    if (!verdict.ok) {
      this.blocked.set(provider.baseUrl, verdict.reason);
      throw new LocalOnlyViolation(verdict.reason);
    }
    return provider;
  }

  /** Refuses cloud-backed models, by tag and by what the server reports. */
  assertModelAllowed(model: string): void {
    const listed = this.modelList?.models.find((m) => normalizeName(m.name) === normalizeName(model));
    if (isRemoteModel({ name: model, remote: listed?.remote })) {
      throw new LocalOnlyViolation(`"${model}" runs on a remote (cloud) backend. Local Copilot only uses models executed on this machine.`);
    }
  }

  async checkHealth(): Promise<HealthStatus> {
    const conn = connectionFor('chat');
    const provider = this.registry.get(conn.kind, conn.endpoint);
    const verdict = await this.policy.verifyEndpoint(provider.baseUrl);
    let status: HealthStatus;
    if (!verdict.ok) {
      this.blocked.set(provider.baseUrl, verdict.reason);
      status = { kind: provider.kind, endpoint: provider.baseUrl, reachable: false, error: verdict.reason, localOnly: { ok: false, detail: verdict.reason } };
    } else {
      this.blocked.delete(provider.baseUrl);
      const detail = `Loopback only: ${provider.baseUrl} → ${(verdict.addresses ?? []).join(', ')}`;
      try {
        const info = await provider.serverInfo();
        status = { kind: provider.kind, endpoint: provider.baseUrl, reachable: true, version: info.version, localOnly: { ok: true, detail } };
      } catch (err) {
        status = { kind: provider.kind, endpoint: provider.baseUrl, reachable: false, error: (err as Error).message, localOnly: { ok: true, detail } };
      }
    }
    this.health = status;
    this.healthEmitter.fire(status);
    return status;
  }

  async listModels(force = false): Promise<ModelInfo[]> {
    const provider = await this.provider('chat');
    const key = provider.baseUrl;
    if (!force && this.modelList && this.modelList.key === key && Date.now() - this.modelList.at < 20_000) return this.modelList.models;
    const models = await provider.listModels();
    this.modelList = { at: Date.now(), key, models };
    for (const m of models) if (m.capabilities) this.capabilities.set(normalizeName(m.name), m.capabilities);
    return models;
  }

  async isInstalled(model: string): Promise<boolean> {
    try {
      const models = await this.listModels();
      return models.some((m) => normalizeName(m.name) === normalizeName(model));
    } catch {
      return false;
    }
  }

  async capabilitiesOf(model: string, provider?: ModelProvider): Promise<ModelCapability[] | undefined> {
    const key = normalizeName(model);
    const known = this.capabilities.get(key);
    if (known) return known;
    if (provider instanceof OllamaProvider) {
      const caps = await provider.capabilities(model);
      this.capabilities.set(key, caps);
      return caps;
    }
    return undefined;
  }

  async loadedModels(): Promise<LoadedModel[]> {
    const provider = await this.provider('chat');
    return provider.loadedModels ? provider.loadedModels() : [];
  }

  async fimTemplate(model: string, signal?: AbortSignal): Promise<FimTemplate> {
    this.assertModelAllowed(model);
    const choice = settings.fimTemplate();
    if (choice === 'custom') return customTemplate(settings.customTemplate(), settings.customStop());
    if (choice !== 'auto') return builtinTemplate(choice);
    const cached = this.templates.get(model);
    if (cached) return cached;
    const provider = this.providerSync('autocomplete');
    const caps = signal?.aborted ? undefined : await this.capabilitiesOf(model, provider).catch(() => undefined);
    let id = detectFimTemplate(model, caps);
    if (id === 'native' && provider.kind !== 'ollama') id = 'qwen';
    const template = builtinTemplate(id);
    this.templates.set(model, template);
    this.log.info(`FIM template for ${model}: ${id}`);
    return template;
  }

  async chat(task: TaskKind, messages: ChatMessage[], opts: ChatCallOptions = {}): Promise<ChatCallResult> {
    const model = settings.taskModel(task);
    this.assertModelAllowed(model);
    const provider = await this.provider('chat');
    const caps = await this.capabilitiesOf(model, provider).catch(() => undefined);
    const reasoningAvailable = caps?.includes('thinking') ?? false;
    const mode = settings.reasoning();
    const wantReasoning = opts.reasoning ?? (mode === 'always' || (mode === 'deep' && DEEP_TASKS.has(task)));
    let think: ThinkSetting | undefined;
    if (reasoningAvailable) think = /gpt-oss/i.test(model) ? (wantReasoning ? 'medium' : 'low') : wantReasoning;

    this.activeChats++;
    this.activityEmitter.fire(this.activeChats);
    const t0 = performance.now();
    try {
      const gpuLayers = await this.chatGpuLayers(model, provider).catch(() => undefined);
      const result = await provider.chat({
        model,
        messages,
        think,
        jsonSchema: opts.jsonSchema,
        signal: opts.signal,
        onDelta: opts.onDelta ? (d) => opts.onDelta!(d) : undefined,
        options: {
          maxTokens: opts.maxTokens ?? settings.chatMaxOutputTokens(),
          temperature: settings.chatTemperature(),
          contextLength: settings.chatContextLength(),
          gpuLayers,
          keepAlive: settings.chatKeepAlive(),
        },
      });
      this.metrics.record({
        ts: Date.now(),
        kind: 'chat',
        task,
        model,
        ms: performance.now() - t0,
        firstTokenMs: result.stats.firstTokenMs,
        promptTokens: result.stats.promptTokens,
        outputTokens: result.stats.outputTokens,
        tps: result.stats.tokensPerSecond,
        outcome: 'ok',
      });
      return { ...result, model, reasoningUsed: think === true || typeof think === 'string', reasoningAvailable };
    } catch (err) {
      this.metrics.record({ ts: Date.now(), kind: 'chat', task, model, ms: performance.now() - t0, outcome: isCancellation(err) ? 'cancelled' : 'error' });
      throw err;
    } finally {
      this.activeChats--;
      this.activityEmitter.fire(this.activeChats);
      if (normalizeName(model) !== normalizeName(settings.autocompleteModel())) this.autocompleteMaybeEvicted = true;
    }
  }

  /**
   * GPU layers for the intelligence model. On a GPU too small for both models,
   * cap it so the completion model stays resident (see core/hardware/gpuPlan).
   * The plan is kept while the model stays loaded: changing num_gpu reloads it.
   */
  private async chatGpuLayers(model: string, provider: ModelProvider): Promise<number | undefined> {
    const setting = settings.chatGpuLayers();
    if (setting >= 999) return undefined;
    if (setting >= 0) return setting;
    if (!(provider instanceof OllamaProvider) || normalizeName(model) === normalizeName(settings.autocompleteModel())) return undefined;
    const loaded = await provider.loadedModels();
    const key = normalizeName(model);
    if (loaded.some((m) => normalizeName(m.name) === key) && this.gpuPlans.has(key)) return this.gpuPlans.get(key);
    const memory = await nvidiaMemoryMB();
    if (!memory) return undefined;
    const models = await this.listModels();
    const sizeMB = (name: string) => (models.find((m) => normalizeName(m.name) === normalizeName(name))?.sizeBytes ?? 0) / 2 ** 20;
    const completionLoaded = loaded.find((m) => normalizeName(m.name) === normalizeName(settings.autocompleteModel()));
    const blocks = await provider.blockCount(model);
    const plan = planChatGpuLayers({
      totalMB: memory.totalMB,
      usedMB: memory.usedMB,
      serverLoadedMB: loaded.reduce((n, m) => n + m.vramBytes / 2 ** 20, 0),
      completionMB: settings.autocompleteEnabled() ? (completionLoaded ? completionLoaded.vramBytes / 2 ** 20 : sizeMB(settings.autocompleteModel())) : 0,
      embeddingMB: settings.embeddingsEnabled() ? sizeMB(settings.embeddingModel()) * 1.3 : 0,
      chatModelMB: sizeMB(model),
      blocks: blocks ?? 0,
    });
    this.gpuPlans.set(key, plan);
    this.log.info(plan === undefined ? `${model}: fits in VRAM next to the completion model` : `${model}: ${plan}/${blocks} layers on GPU so the completion model stays loaded`);
    return plan;
  }

  async embed(texts: string[], kind: 'query' | 'document', signal?: AbortSignal): Promise<number[][]> {
    const model = settings.embeddingModel();
    this.assertModelAllowed(model);
    const provider = await this.provider('embeddings');
    const prefix = embeddingPrefixes(model)[kind];
    const t0 = performance.now();
    try {
      const vectors = await provider.embed({ model, inputs: texts.map((t) => prefix + t), keepAlive: '5m', signal });
      this.metrics.record({ ts: Date.now(), kind: 'embed', model, ms: performance.now() - t0, outcome: 'ok', count: texts.length });
      return vectors;
    } catch (err) {
      this.metrics.record({ ts: Date.now(), kind: 'embed', model, ms: performance.now() - t0, outcome: isCancellation(err) ? 'cancelled' : 'error', count: 0 });
      throw err;
    }
  }

  /** Loads the completion model ahead of the first keystroke. */
  async warmupAutocomplete(): Promise<void> {
    if (!settings.autocompleteEnabled()) return;
    const provider = this.providerSync('autocomplete');
    if (!provider.warmup) return;
    const s = settings.inline();
    this.assertModelAllowed(s.model);
    const t0 = performance.now();
    await provider.warmup(s.model, s.keepAlive, s.contextLength);
    this.log.info(`Completion model ${s.model} loaded in ${Math.round(performance.now() - t0)} ms`);
  }

  /**
   * Called when the user edits code. If an analysis may have pushed the
   * completion model out of VRAM, reload it now, while the user is still typing.
   */
  noteEditorActivity(): void {
    if (!this.autocompleteMaybeEvicted || this.activeChats > 0) return;
    this.autocompleteMaybeEvicted = false;
    this.warmupAutocomplete().catch((err) => this.log.debug(`re-warm failed: ${(err as Error).message}`));
  }

  async pull(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    if (isRemoteModel({ name: model })) throw new LocalOnlyViolation(`"${model}" is a cloud model; it will not be installed.`);
    const provider = await this.provider('chat');
    if (!provider.pull) throw new Error(`Downloading models is not supported for ${provider.kind}; use its own UI.`);
    await provider.pull(model, onProgress, signal);
    this.modelList = undefined;
  }
}
