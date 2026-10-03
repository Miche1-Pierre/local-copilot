// Proposed edits (refactor, fix, documentation) shown as a diff before anything
// touches the user's file. Nothing is applied without an explicit Apply.

import * as vscode from 'vscode';

export const PROPOSAL_SCHEME = 'local-copilot-proposal';

export interface Proposal {
  id: string;
  uri: vscode.Uri;
  range: vscode.Range;
  original: string;
  replacement: string;
  version: number;
  title: string;
}

let counter = 0;

export class ProposalManager implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly proposals = new Map<string, Proposal>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, this);
  }

  dispose(): void {
    this.registration.dispose();
    this.changeEmitter.dispose();
  }

  create(p: Omit<Proposal, 'id'>): Proposal {
    const proposal = { ...p, id: `p${++counter}` };
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  get(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  private uriFor(p: Proposal, side: 'original' | 'proposed'): vscode.Uri {
    const name = p.uri.path.split('/').pop() ?? 'file';
    return vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${side}/${name}`, query: `id=${p.id}&side=${side}` });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    const p = this.proposals.get(params.get('id') ?? '');
    if (!p) return '// This proposal is no longer available.';
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === p.uri.toString());
    const text = doc?.getText() ?? '';
    if (params.get('side') === 'original' || !doc) return text;
    const range = this.currentRange(p, doc);
    if (!range) return text;
    return text.slice(0, doc.offsetAt(range.start)) + p.replacement + text.slice(doc.offsetAt(range.end));
  }

  async showDiff(id: string): Promise<void> {
    const p = this.proposals.get(id);
    if (!p) return;
    await vscode.workspace.openTextDocument(p.uri);
    await vscode.commands.executeCommand('vscode.diff', this.uriFor(p, 'original'), this.uriFor(p, 'proposed'), `${p.title} (proposal)`, { preview: true });
  }

  /** The id of the proposal shown in the active diff editor, if any. */
  activeId(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme !== PROPOSAL_SCHEME) return undefined;
    return new URLSearchParams(uri.query).get('id') ?? undefined;
  }

  async apply(id: string): Promise<boolean> {
    const p = this.proposals.get(id);
    if (!p) return false;
    const doc = await vscode.workspace.openTextDocument(p.uri);
    const range = this.currentRange(p, doc);
    if (!range) {
      void vscode.window.showWarningMessage('Local Copilot: the code changed since this proposal was made. Run the command again.');
      return false;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(p.uri, range, p.replacement);
    const ok = await vscode.workspace.applyEdit(edit);
    if (ok) {
      this.proposals.delete(id);
      await this.closeDiff(p);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(range.start, range.start), preview: false });
    }
    return ok;
  }

  async discard(id: string): Promise<void> {
    const p = this.proposals.get(id);
    if (!p) return;
    this.proposals.delete(id);
    await this.closeDiff(p);
  }

  /** Where the original text is now: the stored range if untouched, else a unique match. */
  private currentRange(p: Proposal, doc: vscode.TextDocument): vscode.Range | undefined {
    if (doc.version === p.version || doc.getText(p.range) === p.original) return p.range;
    const text = doc.getText();
    const at = text.indexOf(p.original);
    if (at < 0 || text.indexOf(p.original, at + 1) >= 0) return undefined;
    return new vscode.Range(doc.positionAt(at), doc.positionAt(at + p.original.length));
  }

  private async closeDiff(p: Proposal): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === PROPOSAL_SCHEME && input.modified.query.includes(`id=${p.id}&`)) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
  }
}
