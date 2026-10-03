// Host side of the dashboard: connection & privacy status, models per role,
// hardware recommendations with one-click install, VRAM, index and metrics.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { fimSupport } from '../core/fim/templates';
import { describeHardware, recommendModels, type ModelPick } from '../core/hardware/recommend';
import type { MetricsStore } from '../core/metrics/metrics';
import { inspectOllamaExposure, isRemoteModel } from '../core/policy/localOnly';
import type { LoadedModel, ModelInfo } from '../core/providers/types';
import { throttle } from '../core/util/async';
import type { DashboardInbound, DashboardOutbound, DashboardState, ModelView, QuickSettingKey, RecommendationView, Role, RoleView } from '../webview/protocol';
import { detectHardware } from './hardware';
import type { WorkspaceIndexer } from './indexer';
import { friendlyError } from './intelligence';
import type { Logger } from './logger';
import type { ModelManager } from './modelManager';
import { settings, updateSetting } from './settings';
import { webviewHtml, webviewRoots } from './webviewHtml';

const GB = 1024 ** 3;

const SETTING_KEYS: Record<QuickSettingKey, string> = {
  autocompleteEnabled: 'autocomplete.enabled',
  multiline: 'autocomplete.multiline',
  debounceMs: 'autocomplete.debounceMs',
  reasoning: 'chat.reasoning',
  embeddingsEnabled: 'embeddings.enabled',
  securityLlmReview: 'security.llmReview',
};

export interface DashboardDeps {
  models: ModelManager;
  indexer: WorkspaceIndexer;
  metrics: MetricsStore;
  log: Logger;
  rebuildIndex: () => void;
  verifyLocalOnly: () => Promise<void>;
}

interface PullState {
  status: string;
  percent?: number;
  error?: string;
  done?: boolean;
  abort: AbortController;
}

function sameModel(a: string, b: string): boolean {
  const n = (s: string) => (s.includes(':') ? s : `${s}:latest`);
  return n(a) === n(b);
}

export class Dashboard implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly pulls = new Map<string, PullState>();
  private readonly pushSoon = throttle(() => void this.push(), 1000);

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly d: DashboardDeps,
  ) {}

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const p of this.pulls.values()) p.abort.abort();
    this.panel?.dispose();
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel('localCopilot.dashboard', 'Local Copilot · Dashboard', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: webviewRoots(this.extensionUri),
    });
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
    this.panel.webview.html = webviewHtml(this.panel.webview, this.extensionUri, 'dashboard', 'Local Copilot · Dashboard');
    this.panel.webview.onDidReceiveMessage((m: DashboardOutbound) => void this.onMessage(m));
    this.panel.onDidChangeViewState(() => this.pushSoon());
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
    });
    this.timer = setInterval(() => {
      if (this.panel?.visible) this.pushSoon();
    }, 5000);
  }

  notifyChange(): void {
    if (this.panel && this.ready) this.pushSoon();
  }

  private post(message: DashboardInbound): void {
    if (this.panel && this.ready) void this.panel.webview.postMessage(message);
  }

  private async push(): Promise<void> {
    if (!this.panel || !this.ready) return;
    try {
      this.post({ type: 'state', state: await this.buildState() });
    } catch (err) {
      this.d.log.error('dashboard state', err);
    }
  }

  private async buildState(): Promise<DashboardState> {
    const health = await this.d.models.checkHealth();
    let installed: ModelInfo[] = [];
    let loaded: LoadedModel[] = [];
    if (health.reachable) {
      installed = await this.d.models.listModels().catch(() => []);
      loaded = await this.d.models.loadedModels().catch(() => []);
    }
    const serverJson = await readFile(join(homedir(), '.ollama', 'server.json'), 'utf8')
      .then((t) => JSON.parse(t) as { disable_ollama_cloud?: boolean })
      .catch(() => undefined);
    const exposure = inspectOllamaExposure(process.env, serverJson);
    const hw = await detectHardware();
    const rec = recommendModels(hw);
    const isInstalled = (name: string) => installed.some((m) => sameModel(m.name, name));
    const roleOf = (name: string): Role[] =>
      (['autocomplete', 'chat', 'embeddings'] as Role[]).filter((r) => sameModel(this.modelFor(r), name));

    const roleView = (role: Role): RoleView => {
      const model = this.modelFor(role);
      const info = installed.find((m) => sameModel(m.name, model));
      const view: RoleView = { model, installed: !!info };
      if (isRemoteModel({ name: model, remote: info?.remote })) view.warning = 'Cloud model: refused by the local-only policy.';
      else if (health.reachable && !info) view.warning = 'Not installed: install it below or pick another model.';
      if (role === 'autocomplete') {
        view.fimSupport = fimSupport(model, info?.capabilities);
        if (view.fimSupport === 'none' && !view.warning) view.warning = 'This model was not trained for fill-in-the-middle: ghost text will be poor. Use a *-base code model (e.g. qwen2.5-coder:3b-base).';
      }
      if (role === 'embeddings' && info?.capabilities && !info.capabilities.includes('embedding')) view.warning = 'This model does not produce embeddings.';
      return view;
    };

    const recView = (p: ModelPick): RecommendationView => ({ model: p.model, reason: p.reason, installed: isInstalled(p.model), sizeGB: p.sizeGB });
    const installedViews: ModelView[] = installed.map((m) => ({
      name: m.name,
      sizeGB: m.sizeBytes ? Math.round((m.sizeBytes / GB) * 10) / 10 : undefined,
      parameterSize: m.parameterSize,
      quantization: m.quantization,
      capabilities: m.capabilities ?? [],
      remote: isRemoteModel(m),
      roles: roleOf(m.name),
    }));
    const idx = this.d.indexer.current;
    return {
      connection: {
        provider: health.kind,
        endpoint: health.endpoint,
        reachable: health.reachable,
        version: health.version,
        error: health.reachable ? undefined : health.error,
        localOnly: health.localOnly,
      },
      exposure: { bind: exposure.bind, bindValue: exposure.bindValue, cloudDisabled: exposure.cloudDisabled, warnings: health.kind === 'ollama' ? exposure.warnings : [] },
      roles: { autocomplete: roleView('autocomplete'), chat: roleView('chat'), embeddings: roleView('embeddings') },
      installed: installedViews,
      loaded: loaded.map((l) => ({
        name: l.name,
        sizeGB: Math.round((l.sizeBytes / GB) * 10) / 10,
        vramGB: Math.round((l.vramBytes / GB) * 10) / 10,
        contextLength: l.contextLength,
        until: l.expiresAt,
      })),
      hardware: {
        summary: `${describeHardware(hw)} → ${rec.tier}`,
        gpus: hw.gpus.map((g) => ({ name: g.name, vramGB: Math.round((g.vramMB / 1024) * 10) / 10 })),
        ramGB: Math.round(hw.totalRamMB / 1024),
        cpu: hw.cpuModel,
      },
      recommendation: { autocomplete: recView(rec.autocomplete), chat: recView(rec.chat), embeddings: recView(rec.embeddings), notes: rec.notes },
      index: { enabled: settings.indexEnabled(), status: idx.state, files: idx.files, symbols: idx.symbols, chunks: idx.chunks, embedded: idx.embedded, message: idx.message },
      metrics: this.d.metrics.summary(),
      pulls: [...this.pulls.entries()].map(([model, p]) => ({ model, status: p.status, percent: p.percent, error: p.error, done: p.done })),
      settings: {
        autocompleteEnabled: settings.autocompleteEnabled(),
        multiline: settings.inline().multiline,
        debounceMs: settings.inline().debounceMs,
        reasoning: settings.reasoning(),
        embeddingsEnabled: settings.embeddingsEnabled(),
        securityLlmReview: settings.securityLlmReview(),
      },
    };
  }

  private modelFor(role: Role): string {
    if (role === 'autocomplete') return settings.autocompleteModel();
    if (role === 'chat') return settings.chatModel();
    return settings.embeddingModel();
  }

  private async onMessage(m: DashboardOutbound): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        return this.push();
      case 'refresh':
        await this.d.models.listModels(true).catch(() => undefined);
        return this.push();
      case 'setRole':
        await updateSetting(`${m.role}.model`, m.model);
        if (m.role === 'autocomplete') void this.d.models.warmupAutocomplete().catch(() => undefined);
        this.post({ type: 'toast', kind: 'info', message: `${m.role} model → ${m.model}` });
        return this.push();
      case 'pull':
        return this.pull(m.model);
      case 'cancelPull':
        this.pulls.get(m.model)?.abort.abort();
        return;
      case 'setSetting': {
        const key = SETTING_KEYS[m.key];
        if (key) await updateSetting(key, m.value);
        return this.push();
      }
      case 'testModel':
        return this.test(m.role);
      case 'rebuildIndex':
        this.d.rebuildIndex();
        return;
      case 'clearMetrics':
        this.d.metrics.clear();
        return;
      case 'verifyLocalOnly':
        await this.d.verifyLocalOnly();
        return this.push();
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:miche1pierre.local-copilot');
        return;
      case 'openLogs':
        this.d.log.show();
        return;
    }
  }

  private async pull(model: string): Promise<void> {
    if (this.pulls.get(model) && !this.pulls.get(model)!.done && !this.pulls.get(model)!.error) return;
    const state: PullState = { status: 'starting…', abort: new AbortController() };
    this.pulls.set(model, state);
    this.pushSoon();
    try {
      await this.d.models.pull(
        model,
        (p) => {
          state.status = p.status;
          if (p.total && p.completed !== undefined) state.percent = Math.round((p.completed / p.total) * 100);
          this.pushSoon();
        },
        state.abort.signal,
      );
      state.done = true;
      state.status = 'installed';
      state.percent = 100;
      this.post({ type: 'toast', kind: 'info', message: `${model} installed.` });
    } catch (err) {
      state.error = state.abort.signal.aborted ? 'cancelled' : friendlyError(err, model);
    }
    this.pushSoon();
  }

  private async test(role: Role): Promise<void> {
    const t0 = performance.now();
    try {
      if (role === 'autocomplete') {
        const provider = this.d.models.providerSync('autocomplete');
        const model = settings.autocompleteModel();
        const template = await this.d.models.fimTemplate(model);
        const s = settings.inline();
        const r = await provider.fim({
          model,
          template,
          input: { prefix: 'def add(a, b):\n    ', suffix: '\n\nprint(add(2, 3))\n', path: 'example.py', languageId: 'python', repoName: 'test', contextFiles: [] },
          options: { maxTokens: 24, temperature: 0, contextLength: s.contextLength, keepAlive: s.keepAlive, stop: ['\n\n'] },
        });
        this.post({ type: 'testResult', role, ok: true, message: `${Math.round(performance.now() - t0)} ms → ${JSON.stringify(r.text.trim().slice(0, 60))}` });
      } else if (role === 'chat') {
        const r = await this.d.models.chat('explain', [{ role: 'user', content: 'Reply with exactly: OK' }], { maxTokens: 16, reasoning: false });
        this.post({ type: 'testResult', role, ok: true, message: `${((performance.now() - t0) / 1000).toFixed(1)} s → ${JSON.stringify(r.text.trim().slice(0, 40))}${r.stats.tokensPerSecond ? ` · ${Math.round(r.stats.tokensPerSecond)} tok/s` : ''}` });
      } else {
        const [v] = await this.d.models.embed(['function add(a, b) { return a + b; }'], 'document');
        this.post({ type: 'testResult', role, ok: true, message: `${Math.round(performance.now() - t0)} ms → ${v.length} dimensions` });
      }
    } catch (err) {
      this.post({ type: 'testResult', role, ok: false, message: friendlyError(err, this.modelFor(role)) });
    }
    this.pushSoon();
  }
}
