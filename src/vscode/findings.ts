// Review and security findings as editor diagnostics, plus the code actions
// that go with them (fix a finding, explain & fix any compiler error).

import * as vscode from 'vscode';
import type { FindingSeverity } from '../webview/protocol';

export const SOURCE = 'Local Copilot';

interface Tagged {
  runId: string;
  findingId: string;
}

const tags = new WeakMap<vscode.Diagnostic, Tagged>();

export interface FindingLocation {
  findingId: string;
  range: vscode.Range;
  severity: FindingSeverity;
  message: string;
  code?: string;
}

function toSeverity(s: FindingSeverity): vscode.DiagnosticSeverity {
  if (s === 'critical') return vscode.DiagnosticSeverity.Error;
  if (s === 'high' || s === 'error' || s === 'medium' || s === 'warning') return vscode.DiagnosticSeverity.Warning;
  return vscode.DiagnosticSeverity.Information;
}

export class FindingsStore implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('localCopilot');
  private readonly staticScan = vscode.languages.createDiagnosticCollection('localCopilotStatic');
  /** uri → runId → diagnostics */
  private readonly byUri = new Map<string, Map<string, vscode.Diagnostic[]>>();

  dispose(): void {
    this.collection.dispose();
    this.staticScan.dispose();
  }

  set(uri: vscode.Uri, runId: string, items: FindingLocation[], label: string): void {
    const diags = items.map((f) => {
      const d = new vscode.Diagnostic(f.range, `[${f.severity}] ${f.message}`, toSeverity(f.severity));
      d.source = `${SOURCE} ${label}`;
      if (f.code) d.code = f.code;
      tags.set(d, { runId, findingId: f.findingId });
      return d;
    });
    const perRun = this.byUri.get(uri.toString()) ?? new Map<string, vscode.Diagnostic[]>();
    perRun.set(runId, diags);
    this.byUri.set(uri.toString(), perRun);
    this.publish(uri);
  }

  clearRun(runId: string): void {
    for (const [key, perRun] of this.byUri) {
      if (perRun.delete(runId)) this.publish(vscode.Uri.parse(key));
    }
  }

  clearAll(): void {
    this.byUri.clear();
    this.collection.clear();
    this.staticScan.clear();
  }

  setStatic(uri: vscode.Uri, items: FindingLocation[]): void {
    this.staticScan.set(
      uri,
      items.map((f) => {
        const d = new vscode.Diagnostic(f.range, `[${f.severity}] ${f.message}`, toSeverity(f.severity));
        d.source = `${SOURCE} (static)`;
        if (f.code) d.code = f.code;
        return d;
      }),
    );
  }

  static tagOf(d: vscode.Diagnostic): Tagged | undefined {
    return tags.get(d);
  }

  private publish(uri: vscode.Uri): void {
    const perRun = this.byUri.get(uri.toString());
    this.collection.set(uri, perRun ? [...perRun.values()].flat() : []);
  }
}

export class LocalCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite];

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const d of context.diagnostics) {
      const tag = FindingsStore.tagOf(d);
      if (tag) {
        const a = new vscode.CodeAction('Local Copilot: fix this finding', vscode.CodeActionKind.QuickFix);
        a.command = { title: a.title, command: 'localCopilot.fixFinding', arguments: [tag.runId, tag.findingId] };
        a.diagnostics = [d];
        actions.push(a);
      } else if (d.severity <= vscode.DiagnosticSeverity.Warning && !String(d.source ?? '').startsWith(SOURCE)) {
        const a = new vscode.CodeAction('Local Copilot: explain and fix', vscode.CodeActionKind.QuickFix);
        a.command = { title: a.title, command: 'localCopilot.fix', arguments: [{ uri: document.uri.toString(), line: d.range.start.line, message: d.message, source: d.source, code: String(typeof d.code === 'object' ? d.code.value : (d.code ?? '')) }] };
        a.diagnostics = [d];
        actions.push(a);
      }
    }
    if (!range.isEmpty) {
      const refactor = new vscode.CodeAction('Local Copilot: refactor selection…', vscode.CodeActionKind.RefactorRewrite);
      refactor.command = { title: refactor.title, command: 'localCopilot.refactor' };
      const explain = new vscode.CodeAction('Local Copilot: explain selection', vscode.CodeActionKind.Empty);
      explain.command = { title: explain.title, command: 'localCopilot.explain' };
      actions.push(refactor, explain);
    }
    return actions;
  }
}
