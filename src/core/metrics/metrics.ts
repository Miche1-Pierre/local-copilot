// Local performance metrics. Kept in memory and in VS Code's local storage only;
// nothing here is ever transmitted.

import type { MetricsSummary } from '../../webview/protocol';

export type MetricKind = 'inline' | 'chat' | 'embed';
export type Outcome = 'ok' | 'empty' | 'cached' | 'cancelled' | 'error';

export interface MetricEvent {
  ts: number;
  kind: MetricKind;
  model: string;
  ms: number;
  outcome: Outcome;
  firstTokenMs?: number;
  promptTokens?: number;
  outputTokens?: number;
  tps?: number;
  task?: string;
  count?: number;
}

interface Persisted {
  version: 1;
  events: MetricEvent[];
  shown: number;
  accepted: number;
}

const MAX_EVENTS = 1000;

export function percentile(values: number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function average(values: number[]): number | undefined {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

export class MetricsStore {
  private events: MetricEvent[] = [];
  private shown = 0;
  private accepted = 0;
  private listeners: (() => void)[] = [];

  record(event: MetricEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.emit();
  }

  markShown(): void {
    this.shown++;
    this.emit();
  }

  markAccepted(): void {
    this.accepted++;
    this.emit();
  }

  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  clear(): void {
    this.events = [];
    this.shown = 0;
    this.accepted = 0;
    this.emit();
  }

  /** Latency of the last successful inline completions, for the status bar. */
  recentInlineLatency(): number | undefined {
    const ok = this.events.filter((e) => e.kind === 'inline' && e.outcome === 'ok').slice(-20);
    return percentile(ok.map((e) => e.ms), 0.5);
  }

  summary(): MetricsSummary {
    const inline = this.events.filter((e) => e.kind === 'inline');
    const inlineOk = inline.filter((e) => e.outcome === 'ok');
    const chat = this.events.filter((e) => e.kind === 'chat');
    const chatOk = chat.filter((e) => e.outcome === 'ok');
    const embed = this.events.filter((e) => e.kind === 'embed');
    return {
      inline: {
        requests: inline.length,
        shown: this.shown,
        accepted: this.accepted,
        acceptanceRate: this.shown > 0 ? this.accepted / this.shown : undefined,
        cacheHits: inline.filter((e) => e.outcome === 'cached').length,
        p50Ms: percentile(inlineOk.map((e) => e.ms), 0.5),
        p95Ms: percentile(inlineOk.map((e) => e.ms), 0.95),
        avgTokensPerSecond: average(inlineOk.map((e) => e.tps).filter((v): v is number => v !== undefined)),
        errors: inline.filter((e) => e.outcome === 'error').length,
        cancelled: inline.filter((e) => e.outcome === 'cancelled').length,
      },
      chat: {
        requests: chat.length,
        p50Ms: percentile(chatOk.map((e) => e.ms), 0.5),
        avgFirstTokenMs: average(chatOk.map((e) => e.firstTokenMs).filter((v): v is number => v !== undefined)),
        avgTokensPerSecond: average(chatOk.map((e) => e.tps).filter((v): v is number => v !== undefined)),
        errors: chat.filter((e) => e.outcome === 'error').length,
      },
      embeddings: {
        requests: embed.length,
        vectors: embed.reduce((n, e) => n + (e.count ?? 0), 0),
        errors: embed.filter((e) => e.outcome === 'error').length,
      },
      recent: this.events
        .slice(-15)
        .reverse()
        .map((e) => ({ ts: e.ts, kind: e.task ?? e.kind, model: e.model, ms: Math.round(e.ms), tokens: e.outputTokens, tps: e.tps ? Math.round(e.tps) : undefined, outcome: e.outcome })),
    };
  }

  toJSON(): Persisted {
    return { version: 1, events: this.events, shown: this.shown, accepted: this.accepted };
  }

  load(data: unknown): void {
    const d = data as Partial<Persisted> | undefined;
    if (!d || d.version !== 1 || !Array.isArray(d.events)) return;
    this.events = d.events.slice(-MAX_EVENTS);
    this.shown = d.shown ?? 0;
    this.accepted = d.accepted ?? 0;
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
