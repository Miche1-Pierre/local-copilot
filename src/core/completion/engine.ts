// The inline completion engine: debounce, type-ahead cache, single in-flight
// request, prompt assembly, streaming with early stop, post-processing.
// Pure logic (no VS Code import) so it is unit-testable with a fake provider.

import { chooseMode, isAfterComment, shouldTrigger, type CompletionMode, type LineContext, type MultilineSetting } from '../fim/heuristics';
import { postProcessCompletion, shouldStopEarly, type PostProcessContext, type ProcessedCompletion } from '../fim/postprocess';
import type { FimTemplate } from '../fim/templates';
import type { MetricsStore } from '../metrics/metrics';
import type { ContextFile, FimInput, ModelProvider } from '../providers/types';
import { anySignal, isCancellation, sleep } from '../util/async';
import { takeFirstTokens, takeLastTokens } from '../util/tokens';
import { CompletionCache, suffixKeyOf } from './cache';

export interface InlineRequest {
  /** Stable id of the document (URI). */
  docKey: string;
  /** Cursor offset in the document. */
  offset: number;
  /** Text before the cursor (may exceed the budget; the engine trims it). */
  prefix: string;
  /** Text after the cursor (may exceed the budget). */
  suffix: string;
  line: LineContext;
  path: string;
  languageId: string;
  repoName: string;
  /** Explicit trigger (Alt+\): no debounce, allowed in the middle of a line. */
  explicit: boolean;
  /** Gathers repository context within a token budget. */
  contextFiles?: (budgetTokens: number, signal: AbortSignal) => Promise<ContextFile[]>;
}

export interface InlineSettings {
  model: string;
  debounceMs: number;
  multiline: MultilineSetting;
  maxTokens: number;
  maxTokensMultiline: number;
  maxLines: number;
  temperature: number;
  contextLength: number;
  prefixTokens: number;
  suffixTokens: number;
  repoContextTokens: number;
  keepAlive: string;
}

export interface InlineResult extends ProcessedCompletion {
  fromCache: boolean;
  model: string;
  latencyMs: number;
  mode: CompletionMode;
}

export type EngineStatus = { state: 'busy' } | { state: 'idle'; latencyMs?: number } | { state: 'error'; message: string };

export interface InlineEngineDeps {
  provider: () => ModelProvider;
  settings: () => InlineSettings;
  template: (model: string, signal?: AbortSignal) => Promise<FimTemplate>;
  metrics?: MetricsStore;
  onStatus?: (status: EngineStatus) => void;
  log?: (message: string) => void;
}

export class InlineCompletionEngine {
  private readonly cache = new CompletionCache();
  private inflight?: AbortController;

  constructor(private readonly deps: InlineEngineDeps) {}

  clearCache(): void {
    this.cache.clear();
  }

  async complete(req: InlineRequest, cancel: AbortSignal): Promise<InlineResult | undefined> {
    const s = this.deps.settings();
    if (!shouldTrigger(req.line, req.explicit).trigger) return undefined;
    const t0 = performance.now();
    const mode = chooseMode(req.line, s.multiline);
    const suffixKey = suffixKeyOf(req.suffix);

    const cached = this.cache.lookup(req.docKey, req.offset, req.prefix, suffixKey, s.model);
    if (cached) {
      this.deps.metrics?.record({ ts: Date.now(), kind: 'inline', model: s.model, ms: performance.now() - t0, outcome: 'cached' });
      return { ...cached, fromCache: true, model: s.model, latencyMs: performance.now() - t0, mode };
    }

    if (!req.explicit && s.debounceMs > 0) {
      try {
        await sleep(s.debounceMs, cancel);
      } catch {
        return undefined;
      }
    }
    if (cancel.aborted) return undefined;

    // Single flight: a newer request supersedes the previous one.
    this.inflight?.abort();
    const local = new AbortController();
    this.inflight = local;
    const signal = anySignal([cancel, local.signal]);

    const ppCtx: PostProcessContext = {
      mode,
      linePrefix: req.line.linePrefix,
      lineSuffix: req.line.lineSuffix,
      nextLines: req.line.nextLines,
      previousLines: req.line.previousLines,
      maxLines: mode === 'multi' ? s.maxLines : 1,
    };
    const maxTokens = mode === 'multi' || isAfterComment(req.line) ? s.maxTokensMultiline : s.maxTokens;

    try {
      const [template, contextFiles] = await Promise.all([
        this.deps.template(s.model, signal),
        s.repoContextTokens > 0 && req.contextFiles ? req.contextFiles(s.repoContextTokens, signal).catch(() => []) : Promise.resolve([]),
      ]);
      if (signal.aborted) return undefined;
      const input: FimInput = {
        prefix: takeLastTokens(req.prefix, s.prefixTokens),
        suffix: takeFirstTokens(req.suffix, s.suffixTokens),
        path: req.path,
        languageId: req.languageId,
        repoName: req.repoName,
        contextFiles,
      };
      this.deps.onStatus?.({ state: 'busy' });
      const result = await this.deps.provider().fim({
        model: s.model,
        input,
        template,
        signal,
        options: {
          maxTokens,
          temperature: s.temperature,
          topP: 0.9,
          stop: mode === 'single' ? ['\n'] : undefined,
          contextLength: s.contextLength,
          keepAlive: s.keepAlive,
        },
        onDelta: (_delta, accumulated) => (shouldStopEarly(accumulated, ppCtx) ? 'stop' : undefined),
      });
      const processed = postProcessCompletion(result.text, ppCtx);
      const latencyMs = performance.now() - t0;
      this.deps.metrics?.record({
        ts: Date.now(),
        kind: 'inline',
        model: s.model,
        ms: latencyMs,
        firstTokenMs: result.stats.firstTokenMs,
        promptTokens: result.stats.promptTokens,
        outputTokens: result.stats.outputTokens,
        tps: result.stats.tokensPerSecond,
        outcome: processed ? 'ok' : 'empty',
      });
      this.deps.onStatus?.({ state: 'idle', latencyMs });
      if (!processed) return undefined;
      this.cache.store(req.docKey, req.offset, req.prefix, suffixKey, s.model, processed);
      if (cancel.aborted) return undefined;
      return { ...processed, fromCache: false, model: s.model, latencyMs, mode };
    } catch (err) {
      if (isCancellation(err) || signal.aborted) {
        this.deps.metrics?.record({ ts: Date.now(), kind: 'inline', model: s.model, ms: performance.now() - t0, outcome: 'cancelled' });
        this.deps.onStatus?.({ state: 'idle' });
        return undefined;
      }
      const message = (err as Error).message ?? String(err);
      this.deps.metrics?.record({ ts: Date.now(), kind: 'inline', model: s.model, ms: performance.now() - t0, outcome: 'error' });
      this.deps.onStatus?.({ state: 'error', message });
      this.deps.log?.(`inline completion failed: ${message}`);
      return undefined;
    } finally {
      if (this.inflight === local) this.inflight = undefined;
    }
  }
}
