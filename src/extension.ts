// Local Copilot: composition root. Wires the engines, the VS Code providers and
// the commands. Everything talks to a loopback server only; there is no
// telemetry, no remote logging and no network call besides that server.

import * as vscode from 'vscode';
import { InlineCompletionEngine } from './core/completion/engine';
import { MetricsStore } from './core/metrics/metrics';
import { inspectOllamaExposure, isRemoteModel } from './core/policy/localOnly';
import { analyzeStatic } from './core/security/analyzer';
import { debounce } from './core/util/async';
import { ContextGatherer } from './vscode/contextGatherer';
import { Dashboard } from './vscode/dashboard';
import { FindingsStore, LocalCodeActions } from './vscode/findings';
import { WorkspaceIndexer } from './vscode/indexer';
import { LocalInlineProvider } from './vscode/inlineProvider';
import { IntelligenceService, type FixRequest } from './vscode/intelligence';
import { Logger } from './vscode/logger';
import { DirectiveCodeLens, pickModel, showActionMenu, showStatusMenu } from './vscode/menus';
import { ModelManager } from './vscode/modelManager';
import { ResultsPanel } from './vscode/panel';
import { ProposalManager } from './vscode/proposals';
import { connectionFor, SECTION, settings, updateSetting } from './vscode/settings';
import { StatusBar } from './vscode/statusBar';

const METRICS_KEY = 'localCopilot.metrics';
const WELCOMED_KEY = 'localCopilot.welcomed.v1';

export interface LocalCopilotApi {
  engine: InlineCompletionEngine;
  inline: LocalInlineProvider;
  models: ModelManager;
  indexer: WorkspaceIndexer;
  intelligence: IntelligenceService;
  panel: ResultsPanel;
  metrics: MetricsStore;
}

export function activate(context: vscode.ExtensionContext): LocalCopilotApi {
  const log = new Logger();
  const metrics = new MetricsStore();
  metrics.load(context.globalState.get(METRICS_KEY));
  const saveMetrics = debounce(() => {
    if (settings.metricsEnabled()) void context.globalState.update(METRICS_KEY, metrics.toJSON());
  }, 5000);

  const models = new ModelManager(log, metrics);
  const indexer = new WorkspaceIndexer(context, models, log);
  const gatherer = new ContextGatherer(indexer);
  let statusBar: StatusBar | undefined;
  const checkHealthSoon = debounce(() => void models.checkHealth(), 3000);
  const engine = new InlineCompletionEngine({
    provider: () => models.providerSync('autocomplete'),
    settings: () => settings.inline(),
    template: (model, signal) => models.fimTemplate(model, signal),
    metrics,
    onStatus: (s) => {
      statusBar?.setEngine(s);
      if (s.state === 'error') checkHealthSoon();
    },
    log: (m) => log.debug(m),
  });
  const inline = new LocalInlineProvider(engine, gatherer, indexer, metrics);
  statusBar = new StatusBar(metrics, () => inline.snoozed);
  const panel = new ResultsPanel(context.extensionUri);
  const proposals = new ProposalManager();
  const findings = new FindingsStore();
  const intelligence = new IntelligenceService({ models, indexer, context: gatherer, panel, proposals, findings, inline, log });
  const codeLens = new DirectiveCodeLens();

  const verifyLocalOnly = async () => {
    const lines: string[] = [];
    const ok = (good: boolean, text: string) => lines.push(`${good ? '✅' : '⚠️'} ${text}`);
    for (const role of ['autocomplete', 'chat', 'embeddings'] as const) {
      const conn = connectionFor(role);
      try {
        const provider = await models.provider(role);
        const verdict = await models.policy.verifyEndpoint(provider.baseUrl);
        ok(verdict.ok, `${role}: ${conn.kind} at \`${provider.baseUrl}\`${verdict.ok ? ` (resolves to ${(verdict.addresses ?? []).join(', ')})` : ` — ${verdict.reason}`}`);
      } catch (err) {
        ok(false, `${role}: ${(err as Error).message}`);
      }
    }
    for (const [role, model] of [
      ['autocomplete', settings.autocompleteModel()],
      ['intelligence', settings.chatModel()],
      ['embeddings', settings.embeddingModel()],
    ] as const) {
      ok(!isRemoteModel({ name: model }), `${role} model \`${model}\` ${isRemoteModel({ name: model }) ? 'is a cloud model and will be refused' : 'runs locally'}`);
    }
    const exposure = inspectOllamaExposure(process.env);
    ok(exposure.bind === 'loopback', `Ollama listens on \`${exposure.bindValue}\`${exposure.bind === 'loopback' ? ' (this machine only)' : ' — reachable from your network'}`);
    ok(exposure.cloudDisabled === true, exposure.cloudDisabled === true ? 'Ollama cloud features are disabled (OLLAMA_NO_CLOUD).' : 'Ollama cloud features are not disabled on the server (Local Copilot still refuses cloud models).');
    lines.push('✅ This extension has no telemetry, no analytics, no crash reporting and no remote logging; its only network peer is the loopback server above.');
    lines.push('✅ Redirects are refused and every request URL is re-checked against the loopback policy before it is sent.');
    const telemetry = vscode.workspace.getConfiguration('telemetry').get<string>('telemetryLevel', 'all');
    lines.push(`ℹ️ VS Code's own telemetry (not this extension) is set to \`${telemetry}\`.`);
    const warnings = exposure.warnings.map((w) => `> ${w}`).join('\n\n');
    const run = panel.startRun({ task: 'review', title: 'Local-only verification', subtitle: new Date().toLocaleString() });
    run.update({ status: 'done', content: `${lines.join('\n\n')}${warnings ? `\n\n**Hardening tips**\n\n${warnings}` : ''}` });
    panel.focus(run.id);
  };

  const dashboard = new Dashboard(context.extensionUri, { models, indexer, metrics, log, rebuildIndex: () => void indexer.rebuild(true), verifyLocalOnly });

  panel.setHandlers({
    onAction: (runId, actionId) => void intelligence.handleAction(runId, actionId),
    onOpen: (path, line, endLine) => void openLocation(indexer, path, line, endLine),
    onFixFinding: (runId, findingId) => void intelligence.fixFinding(runId, findingId),
    onCancel: (runId) => intelligence.cancel(runId),
    onFollowUp: (runId, text) => void intelligence.followUp(runId, text),
    onAsk: (text) => void intelligence.askCodebase(text),
    onInsertCode: (code) => void intelligence.insertAtCursor(code),
    onRemove: (runId) => intelligence.forget(runId),
    onClearAll: () => findings.clearAll(),
  });

  const command = (id: string, fn: (...args: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn as (...args: unknown[]) => unknown));

  command('localCopilot.showActions', () => showActionMenu());
  command('localCopilot.statusMenu', () => showStatusMenu(inline.snoozed));
  command('localCopilot.explain', () => intelligence.explain());
  command('localCopilot.review', () => intelligence.review());
  command('localCopilot.securityReview', () => intelligence.security());
  command('localCopilot.generateTests', () => intelligence.tests());
  command('localCopilot.refactor', () => intelligence.refactor());
  command('localCopilot.fix', (arg?: FixRequest) => intelligence.fix(arg && typeof arg === 'object' && 'uri' in arg ? arg : undefined));
  command('localCopilot.document', () => intelligence.document());
  command('localCopilot.generateFromComment', () => intelligence.generateFromComment());
  command('localCopilot.askCodebase', (question?: string) => intelligence.askCodebase(typeof question === 'string' ? question : undefined));
  command('localCopilot.runDirective', (uri: string, line: number) => intelligence.runDirective(uri, line));
  command('localCopilot.fixFinding', (runId: string, findingId: string) => intelligence.fixFinding(runId, findingId));
  command('localCopilot.applyProposal', () => intelligence.applyActiveProposal(true));
  command('localCopilot.discardProposal', () => intelligence.applyActiveProposal(false));
  command('localCopilot.acceptedCompletion', () => metrics.markAccepted());
  command('localCopilot.toggleAutocomplete', () => updateSetting('autocomplete.enabled', !settings.autocompleteEnabled()));
  command('localCopilot.toggleAutocompleteForLanguage', async () => {
    const lang = vscode.window.activeTextEditor?.document.languageId;
    if (!lang) return;
    const list = settings.disabledLanguages();
    await updateSetting('autocomplete.disabledLanguages', list.includes(lang) ? list.filter((l) => l !== lang) : [...list, lang]);
  });
  command('localCopilot.snooze', () => {
    inline.snooze(inline.snoozed ? 0 : 15);
    statusBar?.render();
  });
  command('localCopilot.selectAutocompleteModel', () => pickModel(models, 'autocomplete'));
  command('localCopilot.selectChatModel', () => pickModel(models, 'chat'));
  command('localCopilot.selectEmbeddingModel', () => pickModel(models, 'embeddings'));
  command('localCopilot.openDashboard', () => dashboard.show());
  command('localCopilot.openPanel', () => panel.show(false));
  command('localCopilot.rebuildIndex', () => indexer.rebuild(true));
  command('localCopilot.verifyLocalOnly', () => verifyLocalOnly());
  command('localCopilot.showLogs', () => log.show());
  command('localCopilot.clearMetrics', () => metrics.clear());
  command('localCopilot.clearFindings', () => findings.clearAll());

  context.subscriptions.push(
    log,
    models,
    indexer,
    gatherer,
    panel,
    proposals,
    findings,
    dashboard,
    statusBar,
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inline),
    vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'untitled' }], codeLens),
    vscode.languages.registerCodeActionsProvider([{ scheme: 'file' }, { scheme: 'untitled' }], new LocalCodeActions(), { providedCodeActionKinds: LocalCodeActions.kinds }),
    {
      dispose: metrics.onChange(() => {
        saveMetrics();
        dashboard.notifyChange();
      }),
    },
    models.onDidChangeHealth((h) => {
      statusBar?.setHealth(h);
      dashboard.notifyChange();
    }),
    models.onDidChangeActivity((n) => statusBar?.setChatActivity(n)),
    indexer.onDidChangeStatus((s) => {
      statusBar?.setIndex(s);
      dashboard.notifyChange();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0 || e.document !== vscode.window.activeTextEditor?.document) return;
      models.noteEditorActivity();
      indexer.noteTyping();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!settings.scanOnSave()) return;
      const results = analyzeStatic(doc.getText().replace(/\r\n/g, '\n'), doc.languageId);
      findings.setStatic(
        doc.uri,
        results.map((f) => ({ findingId: f.id, range: new vscode.Range(f.line, f.column, f.line, f.endColumn), severity: f.severity, message: `${f.title} (${f.cwe}): ${f.message}`, code: f.cwe })),
      );
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      models.reset();
      engine.clearCache();
      statusBar?.render();
      codeLens.refresh();
      dashboard.notifyChange();
      if (e.affectsConfiguration(`${SECTION}.provider`) || e.affectsConfiguration(`${SECTION}.endpoint`)) void models.checkHealth();
      if (e.affectsConfiguration(`${SECTION}.autocomplete.model`) || e.affectsConfiguration(`${SECTION}.autocomplete.contextLength`)) {
        void models.warmupAutocomplete().catch((err) => log.warn(`warm-up failed: ${(err as Error).message}`));
      }
      if (e.affectsConfiguration(`${SECTION}.index`)) indexer.start();
      else if (e.affectsConfiguration(`${SECTION}.embeddings`)) void indexer.rebuild(false);
    }),
  );

  void startup(context, models, indexer, log, dashboard);
  return { engine, inline, models, indexer, intelligence, panel, metrics };
}

async function startup(context: vscode.ExtensionContext, models: ModelManager, indexer: WorkspaceIndexer, log: Logger, dashboard: Dashboard): Promise<void> {
  log.info('Local Copilot starting (local-only: loopback endpoints, no telemetry).');
  const health = await models.checkHealth();
  if (!health.localOnly.ok) {
    void vscode.window.showErrorMessage(`Local Copilot is blocked: ${health.localOnly.detail}`, 'Open Settings').then((a) => {
      if (a) void vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.endpoint`);
    });
    return;
  }
  if (!health.reachable) {
    log.warn(`Server not reachable: ${health.error}`);
    void vscode.window.showWarningMessage(`Local Copilot: cannot reach ${health.endpoint}. Start Ollama, then click Retry.`, 'Retry', 'Dashboard').then(async (a) => {
      if (a === 'Retry') {
        const h = await models.checkHealth();
        if (h.reachable) void models.warmupAutocomplete().catch(() => undefined);
      } else if (a === 'Dashboard') dashboard.show();
    });
  } else {
    log.info(`Connected to ${health.kind} ${health.version ?? ''} at ${health.endpoint}`);
    void models.warmupAutocomplete().catch((err) => log.warn(`Completion model warm-up failed: ${(err as Error).message}`));
    void welcome(context, models, dashboard);
  }
  // Let VS Code finish starting before scanning the workspace.
  setTimeout(() => indexer.start(), 2500);
}

async function welcome(context: vscode.ExtensionContext, models: ModelManager, dashboard: Dashboard): Promise<void> {
  const missing: string[] = [];
  for (const m of [settings.autocompleteModel(), settings.chatModel(), settings.embeddingModel()]) if (!(await models.isInstalled(m))) missing.push(m);
  if (missing.length > 0) {
    const a = await vscode.window.showWarningMessage(`Local Copilot: model(s) not installed: ${missing.join(', ')}.`, 'Open Dashboard');
    if (a) dashboard.show();
    return;
  }
  if (context.globalState.get(WELCOMED_KEY)) return;
  await context.globalState.update(WELCOMED_KEY, true);
  const a = await vscode.window.showInformationMessage(
    `Local Copilot is ready, 100% local: ghost text with ${settings.autocompleteModel()} (Tab to accept), analyses with ${settings.chatModel()} (Ctrl+Alt+L).`,
    'Show Actions',
    'Dashboard',
  );
  if (a === 'Show Actions') showActionMenu();
  else if (a === 'Dashboard') dashboard.show();
}

async function openLocation(indexer: WorkspaceIndexer, path: string, line?: number, endLine?: number): Promise<void> {
  let uri = indexer.uriOf(path);
  try {
    if (uri) await vscode.workspace.fs.stat(uri);
  } catch {
    uri = undefined;
  }
  if (!uri) {
    const found = await vscode.workspace.findFiles(`**/${path.replace(/^\.?\//, '')}`, '**/node_modules/**', 1);
    uri = found[0];
  }
  if (!uri) {
    void vscode.window.showWarningMessage(`Local Copilot: "${path}" was not found in the workspace.`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const start = Math.max(0, Math.min(doc.lineCount - 1, (line ?? 1) - 1));
  const end = Math.max(start, Math.min(doc.lineCount - 1, (endLine ?? line ?? 1) - 1));
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, selection: new vscode.Range(start, 0, start, 0) });
  editor.revealRange(new vscode.Range(start, 0, end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

export function deactivate(): void {
  /* disposables are released through context.subscriptions */
}
