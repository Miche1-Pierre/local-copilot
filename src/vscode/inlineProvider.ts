// Ghost-text provider. Bridges VS Code's inline completion API to the engine,
// and also serves "pending" suggestions produced by explicit commands
// (e.g. Generate From Comment), so they appear as ghost text accepted with Tab.

import * as vscode from 'vscode';
import type { InlineCompletionEngine } from '../core/completion/engine';
import type { MetricsStore } from '../core/metrics/metrics';
import type { ContextGatherer } from './contextGatherer';
import type { WorkspaceIndexer } from './indexer';
import { settings } from './settings';

const SUPPORTED_SCHEMES = new Set(['file', 'untitled', 'vscode-notebook-cell', 'vscode-remote', 'vscode-vfs']);
const PREFIX_CHARS = 12_000;
const SUFFIX_CHARS = 4_000;

interface Pending {
  uri: string;
  version: number;
  line: number;
  character: number;
  text: string;
  expires: number;
}

export class LocalInlineProvider implements vscode.InlineCompletionItemProvider {
  private pending?: Pending;
  private snoozedUntil = 0;

  constructor(
    private readonly engine: InlineCompletionEngine,
    private readonly context: ContextGatherer,
    private readonly indexer: WorkspaceIndexer,
    private readonly metrics: MetricsStore,
  ) {}

  get snoozed(): boolean {
    return Date.now() < this.snoozedUntil;
  }

  snooze(minutes: number): void {
    this.snoozedUntil = minutes > 0 ? Date.now() + minutes * 60_000 : 0;
  }

  /** Shows `text` as ghost text at the editor's cursor (used by explicit generation commands). */
  async presentSuggestion(editor: vscode.TextEditor, text: string): Promise<void> {
    const pos = editor.selection.active;
    this.pending = { uri: editor.document.uri.toString(), version: editor.document.version, line: pos.line, character: pos.character, text, expires: Date.now() + 120_000 };
    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const pending = this.takePending(document, position);
    if (pending) return [new vscode.InlineCompletionItem(pending, new vscode.Range(position, position))];

    if (!settings.autocompleteEnabled() || this.snoozed) return undefined;
    if (!SUPPORTED_SCHEMES.has(document.uri.scheme)) return undefined;
    if (settings.disabledLanguages().includes(document.languageId)) return undefined;
    const explicit = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
    // Let IntelliSense win while its suggestion list is open.
    if (context.selectedCompletionInfo && !explicit) return undefined;

    const text = document.getText();
    const offset = document.offsetAt(position);
    const lineText = document.lineAt(position.line).text;
    const previousLines: string[] = [];
    for (let l = Math.max(0, position.line - 6); l < position.line; l++) previousLines.push(document.lineAt(l).text);
    const nextLines: string[] = [];
    for (let l = position.line + 1; l < Math.min(document.lineCount, position.line + 31); l++) nextLines.push(document.lineAt(l).text);
    const eolFix = (s: string) => (s.includes('\r') ? s.replace(/\r\n/g, '\n') : s);

    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());
    try {
      const result = await this.engine.complete(
        {
          docKey: document.uri.toString(),
          offset,
          prefix: eolFix(text.slice(Math.max(0, offset - PREFIX_CHARS), offset)),
          suffix: eolFix(text.slice(offset, offset + SUFFIX_CHARS)),
          line: {
            linePrefix: lineText.slice(0, position.character),
            lineSuffix: lineText.slice(position.character),
            previousLines,
            nextLines,
            languageId: document.languageId,
          },
          path: this.indexer.relPath(document.uri),
          languageId: document.languageId,
          repoName: this.indexer.repoName,
          explicit,
          contextFiles: async (budget) => this.context.inlineContext(document, position, budget),
        },
        abort.signal,
      );
      if (!result || token.isCancellationRequested) return undefined;
      const range = result.replaceLineSuffix ? new vscode.Range(position, document.lineAt(position.line).range.end) : new vscode.Range(position, position);
      this.metrics.markShown();
      const item = new vscode.InlineCompletionItem(result.text, range);
      item.command = { title: 'Accepted', command: 'localCopilot.acceptedCompletion' };
      return [item];
    } finally {
      sub.dispose();
    }
  }

  private takePending(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    const p = this.pending;
    if (!p) return undefined;
    if (Date.now() > p.expires) {
      this.pending = undefined;
      return undefined;
    }
    if (p.uri !== document.uri.toString() || p.line !== position.line || p.character !== position.character || p.version !== document.version) return undefined;
    return p.text;
  }

  clearPending(): void {
    this.pending = undefined;
  }
}
