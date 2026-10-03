import * as vscode from 'vscode';
import type { EngineStatus } from '../core/completion/engine';
import type { MetricsStore } from '../core/metrics/metrics';
import type { IndexStatus } from './indexer';
import type { HealthStatus } from './modelManager';
import { settings } from './settings';

/** One status bar item: model, state (ready / thinking / error / off), latency, privacy. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('localCopilot.status', vscode.StatusBarAlignment.Right, 100);
  private engine: EngineStatus = { state: 'idle' };
  private health?: HealthStatus;
  private index?: IndexStatus;
  private busyTimer?: ReturnType<typeof setTimeout>;
  private showBusy = false;
  private chatRuns = 0;

  constructor(
    private readonly metrics: MetricsStore,
    private readonly isSnoozed: () => boolean,
  ) {
    this.item.name = 'Local Copilot';
    this.item.command = 'localCopilot.statusMenu';
    this.render();
  }

  dispose(): void {
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.item.dispose();
  }

  setEngine(status: EngineStatus): void {
    this.engine = status;
    if (status.state === 'busy') {
      // Only show a spinner for requests that take a noticeable time.
      this.busyTimer ??= setTimeout(() => {
        this.showBusy = true;
        this.render();
      }, 250);
    } else {
      if (this.busyTimer) clearTimeout(this.busyTimer);
      this.busyTimer = undefined;
      this.showBusy = false;
    }
    this.render();
  }

  setHealth(health: HealthStatus): void {
    this.health = health;
    this.render();
  }

  setIndex(status: IndexStatus): void {
    this.index = status;
    this.render();
  }

  setChatActivity(running: number): void {
    this.chatRuns = running;
    this.render();
  }

  render(): void {
    if (!settings.statusBarEnabled()) {
      this.item.hide();
      return;
    }
    const model = settings.autocompleteModel().replace(/:latest$/, '');
    let icon = '$(sparkle)';
    let text = model;
    this.item.backgroundColor = undefined;
    if (this.health && !this.health.localOnly.ok) {
      icon = '$(shield)';
      text = 'blocked';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (this.health && !this.health.reachable) {
      icon = '$(debug-disconnect)';
      text = 'offline';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (!settings.autocompleteEnabled()) {
      icon = '$(circle-slash)';
    } else if (this.isSnoozed()) {
      icon = '$(debug-pause)';
    } else if (this.chatRuns > 0 || this.showBusy) {
      icon = '$(loading~spin)';
    } else if (this.engine.state === 'error') {
      icon = '$(warning)';
    }
    this.item.text = `${icon} ${text}`;
    this.item.tooltip = this.tooltip();
    this.item.show();
  }

  private tooltip(): vscode.MarkdownString {
    const m = this.metrics.summary();
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.appendMarkdown('**Local Copilot**\n\n');
    if (this.health) {
      md.appendMarkdown(this.health.localOnly.ok ? `$(lock) Local only · ${this.health.endpoint}\n\n` : `$(shield) **Blocked:** ${this.health.localOnly.detail}\n\n`);
      if (!this.health.reachable) md.appendMarkdown(`$(debug-disconnect) ${this.health.error ?? 'server unreachable'}\n\n`);
      else if (this.health.version) md.appendMarkdown(`Server: ${this.health.kind} ${this.health.version}\n\n`);
    }
    md.appendMarkdown(`Completion: \`${settings.autocompleteModel()}\`${settings.autocompleteEnabled() ? '' : ' (off)'}${this.isSnoozed() ? ' (snoozed)' : ''}\n\n`);
    md.appendMarkdown(`Intelligence: \`${settings.chatModel()}\`\n\n`);
    if (m.inline.p50Ms !== undefined) {
      md.appendMarkdown(`Latency p50 ${Math.round(m.inline.p50Ms)} ms · p95 ${Math.round(m.inline.p95Ms ?? 0)} ms`);
      if (m.inline.acceptanceRate !== undefined) md.appendMarkdown(` · accepted ${Math.round(m.inline.acceptanceRate * 100)}%`);
      md.appendMarkdown('\n\n');
    }
    if (this.engine.state === 'error') md.appendMarkdown(`$(warning) Last completion error: ${this.engine.message}\n\n`);
    if (this.index) {
      const progress = this.index.progress ? ` ${this.index.progress.done}/${this.index.progress.total}` : '';
      md.appendMarkdown(`Index: ${this.index.state}${progress} · ${this.index.files} files · ${this.index.embedded}/${this.index.chunks} embedded\n\n`);
    }
    md.appendMarkdown('_Click for options_');
    return md;
  }
}
