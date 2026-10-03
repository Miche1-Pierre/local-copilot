// Host side of the results panel: one card per run (explain, review, security…),
// streamed text batched every 50 ms, actions routed back to the extension.

import * as vscode from 'vscode';
import type { PanelInbound, PanelOutbound, RunState } from '../webview/protocol';
import { webviewHtml, webviewRoots } from './webviewHtml';

export interface PanelHandlers {
  onAction(runId: string, actionId: string): void;
  onOpen(path: string, line?: number, endLine?: number): void;
  onFixFinding(runId: string, findingId: string): void;
  onCancel(runId: string): void;
  onFollowUp(runId: string, text: string): void;
  onAsk(text: string): void;
  onInsertCode(code: string): void;
  onRemove(runId: string): void;
  onClearAll(): void;
}

const MAX_RUNS = 40;
let runCounter = 0;

export class RunHandle {
  constructor(
    private readonly panel: ResultsPanel,
    readonly id: string,
  ) {}

  appendContent(text: string): void {
    this.panel.appendDelta(this.id, text, undefined);
  }

  appendThinking(text: string): void {
    this.panel.appendDelta(this.id, undefined, text);
  }

  update(patch: Partial<Omit<RunState, 'id'>>): void {
    this.panel.update(this.id, patch);
  }

  get state(): RunState | undefined {
    return this.panel.run(this.id);
  }
}

export class ResultsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private readonly runs = new Map<string, RunState>();
  private readonly pending = new Map<string, { content: string; thinking: string }>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private handlers?: PanelHandlers;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setHandlers(handlers: PanelHandlers): void {
    this.handlers = handlers;
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.panel?.dispose();
  }

  show(preserveFocus = true): void {
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'localCopilot.results',
      'Local Copilot',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: webviewRoots(this.extensionUri) },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
    this.panel.webview.html = webviewHtml(this.panel.webview, this.extensionUri, 'panel', 'Local Copilot');
    this.panel.webview.onDidReceiveMessage((m: PanelOutbound) => this.onMessage(m));
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
    });
  }

  run(id: string): RunState | undefined {
    return this.runs.get(id);
  }

  startRun(init: Omit<RunState, 'id' | 'status' | 'content' | 'createdAt'> & Partial<Pick<RunState, 'content'>>): RunHandle {
    const run: RunState = { id: `r${Date.now().toString(36)}${++runCounter}`, status: 'running', content: '', createdAt: Date.now(), ...init };
    this.runs.set(run.id, run);
    this.trim();
    this.show(true);
    this.post({ type: 'runStarted', run });
    return new RunHandle(this, run.id);
  }

  appendDelta(id: string, content?: string, thinking?: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    if (content) run.content += content;
    if (thinking) run.thinking = (run.thinking ?? '') + thinking;
    const p = this.pending.get(id) ?? { content: '', thinking: '' };
    p.content += content ?? '';
    p.thinking += thinking ?? '';
    this.pending.set(id, p);
    this.flushTimer ??= setTimeout(() => this.flush(), 50);
  }

  update(id: string, patch: Partial<Omit<RunState, 'id'>>): void {
    const run = this.runs.get(id);
    if (!run) return;
    this.flush();
    Object.assign(run, patch);
    this.post({ type: 'runUpdate', id, patch });
  }

  focus(id: string): void {
    this.show(true);
    this.post({ type: 'focusRun', id });
  }

  remove(id: string): void {
    this.runs.delete(id);
    this.post({ type: 'runRemoved', id });
  }

  clear(): void {
    for (const [id, r] of this.runs) if (r.status !== 'running') this.runs.delete(id);
    this.post({ type: 'init', runs: [...this.runs.values()] });
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    for (const [id, p] of this.pending) {
      this.post({ type: 'runDelta', id, content: p.content || undefined, thinking: p.thinking || undefined });
    }
    this.pending.clear();
  }

  private trim(): void {
    while (this.runs.size > MAX_RUNS) {
      const oldest = [...this.runs.values()].find((r) => r.status !== 'running');
      if (!oldest) break;
      this.runs.delete(oldest.id);
    }
  }

  private post(message: PanelInbound): void {
    // Until the page says it is ready, state is only kept host-side; 'ready' triggers a full 'init'.
    if (!this.panel || !this.ready) return;
    void this.panel.webview.postMessage(message);
  }

  private onMessage(m: PanelOutbound): void {
    const h = this.handlers;
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.pending.clear();
        this.post({ type: 'init', runs: [...this.runs.values()] });
        return;
      case 'action':
        return h?.onAction(m.runId, m.actionId);
      case 'open':
        return h?.onOpen(m.path, m.line, m.endLine);
      case 'fixFinding':
        return h?.onFixFinding(m.runId, m.findingId);
      case 'cancel':
        return h?.onCancel(m.runId);
      case 'followUp':
        return h?.onFollowUp(m.runId, m.text);
      case 'ask':
        return h?.onAsk(m.text);
      case 'copy':
        void vscode.env.clipboard.writeText(m.text);
        void vscode.window.setStatusBarMessage('Local Copilot: copied', 2000);
        return;
      case 'insertCode':
        return h?.onInsertCode(m.code);
      case 'remove':
        this.runs.delete(m.runId);
        return h?.onRemove(m.runId);
      case 'clearAll':
        this.clear();
        return h?.onClearAll();
    }
  }
}
