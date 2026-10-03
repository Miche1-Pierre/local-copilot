// End-to-end tests in a real VS Code extension host.
// Mock mode checks exact behaviour; LIVE mode (real Ollama) checks the pipeline works.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { LocalCopilotApi } from '../../../src/extension';

const LIVE = process.env.LOCAL_COPILOT_LIVE === '1';
const EXT_ID = 'miche1pierre.local-copilot';

async function api(): Promise<LocalCopilotApi> {
  const ext = vscode.extensions.getExtension<LocalCopilotApi>(EXT_ID);
  assert.ok(ext, 'extension found');
  return ext.isActive ? ext.exports : ext.activate();
}

function fixture(rel: string): vscode.Uri {
  return vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, rel);
}

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = LIVE ? 240_000 : 20_000, label = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function lastRun(a: LocalCopilotApi, title: string) {
  return waitFor(() => {
    const runs = (a.panel as unknown as { runs: Map<string, { title: string; status: string; content: string; findings?: unknown[]; error?: string }> }).runs;
    const run = [...runs.values()].reverse().find((r) => r.title.startsWith(title));
    return run && run.status !== 'running' ? run : undefined;
  }, undefined, `run "${title}"`);
}

suite('Local Copilot', () => {
  suiteSetup(async function () {
    this.timeout(LIVE ? 300_000 : 60_000);
    const a = await api();
    const health = await a.models.checkHealth();
    assert.equal(health.reachable, true, `server reachable: ${health.error ?? ''}`);
  });

  test('registers every contributed command', async () => {
    const pkg = vscode.extensions.getExtension(EXT_ID)!.packageJSON as { contributes: { commands: { command: string }[] } };
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = pkg.contributes.commands.map((c) => c.command).filter((c) => !registered.has(c));
    assert.deepEqual(missing, []);
  });

  test('inline completion returns ghost text', async () => {
    const a = await api();
    const doc = await vscode.workspace.openTextDocument(fixture('src/math.ts'));
    await vscode.window.showTextDocument(doc);
    const line = doc.getText().split('\n').findIndex((l) => l.includes('export function add'));
    const pos = new vscode.Position(line + 1, 2);
    const items = await a.inline.provideInlineCompletionItems(doc, pos, { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined }, new vscode.CancellationTokenSource().token);
    assert.ok(items && items.length === 1, 'one suggestion');
    const text = String(items[0].insertText);
    if (LIVE) assert.match(text, /a\s*\+\s*b|return/);
    else assert.equal(text, 'return a + b;');
  });

  test('refuses a non-loopback endpoint before any request', async () => {
    const a = await api();
    const config = vscode.workspace.getConfiguration('localCopilot');
    const previous = config.get<string>('endpoint');
    await config.update('endpoint', 'http://192.168.1.50:11434', vscode.ConfigurationTarget.Global);
    try {
      const health = await a.models.checkHealth();
      assert.equal(health.localOnly.ok, false);
      assert.throws(() => a.models.providerSync('chat'));
    } finally {
      await config.update('endpoint', previous, vscode.ConfigurationTarget.Global);
      await a.models.checkHealth();
    }
  });

  test('refuses cloud models', async () => {
    const a = await api();
    assert.throws(() => a.models.assertModelAllowed('gpt-oss:120b-cloud'));
  });

  test('explains code into the results panel', async () => {
    const a = await api();
    const doc = await vscode.workspace.openTextDocument(fixture('src/math.ts'));
    await a.intelligence.explain({ document: doc, range: new vscode.Range(0, 0, 2, 1), description: 'function clamp', symbolName: 'clamp' });
    const run = await lastRun(a, 'Explain · clamp');
    assert.equal(run.status, 'done', run.error);
    assert.ok(run.content.length > 20);
    if (!LIVE) assert.match(run.content, /clamps a value/);
  });

  test('security review: static rule + AI verdict + diagnostics', async () => {
    const a = await api();
    const doc = await vscode.workspace.openTextDocument(fixture('src/auth.py'));
    const start = doc.getText().split('\n').findIndex((l) => l.startsWith('def find_user'));
    await a.intelligence.security({ document: doc, range: new vscode.Range(start, 0, start + 4, 30), description: 'function find_user', symbolName: 'find_user' });
    const run = await lastRun(a, 'Security · find_user');
    assert.equal(run.status, 'done', run.error);
    const findings = run.findings as { source: string; verdict?: string; cwe?: string; title: string }[];
    const sqli = findings.find((f) => f.cwe === 'CWE-89');
    assert.ok(sqli, `SQL injection found among ${JSON.stringify(findings.map((f) => f.title))}`);
    if (!LIVE) {
      assert.equal(sqli.verdict, 'confirmed');
      assert.equal(sqli.source, 'static+llm');
      assert.ok(findings.some((f) => f.source === 'llm'));
    }
    const diags = vscode.languages.getDiagnostics(doc.uri).filter((d) => String(d.source).startsWith('Local Copilot'));
    assert.ok(diags.length > 0, 'diagnostics published');
  });

  test('review: JSON findings mapped to the right line', async () => {
    const a = await api();
    const doc = await vscode.workspace.openTextDocument(fixture('src/math.ts'));
    await a.intelligence.review({ document: doc, range: new vscode.Range(4, 0, 10, 1), description: 'function average', symbolName: 'average' });
    const run = await lastRun(a, 'Review · average');
    assert.equal(run.status, 'done', run.error);
    if (!LIVE) {
      const f = (run.findings as { line: number; title: string }[])[0];
      assert.equal(f.line, 10);
    }
  });

  test('refactor: proposal shown as a diff, then applied', async function () {
    if (LIVE) this.skip();
    const a = await api();
    const doc = await vscode.workspace.openTextDocument(fixture('src/math.ts'));
    const before = doc.getText();
    await a.intelligence.refactor({ document: doc, range: new vscode.Range(4, 0, 10, 1), description: 'function average', symbolName: 'average' }, 'use reduce');
    const run = await lastRun(a, 'Refactor · average');
    assert.equal(run.status, 'done', run.error);
    const id = [...(a.panel as unknown as { runs: Map<string, { id: string; title: string }> }).runs.values()].reverse().find((r) => r.title.startsWith('Refactor'))!.id;
    await a.intelligence.handleAction(id, 'apply');
    await waitFor(() => doc.getText() !== before || undefined, 10_000, 'edit applied');
    assert.match(doc.getText(), /values\.reduce/);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  test('generate from comment produces ghost text', async () => {
    const a = await api();
    const doc = await vscode.workspace.openTextDocument(fixture('src/PlayerHealth.cs'));
    const editor = await vscode.window.showTextDocument(doc);
    const commentLine = doc.getText().split(/\r?\n/).findIndex((l) => l.includes('Create a method that heals'));
    const pos = new vscode.Position(commentLine + 1, 0);
    editor.selection = new vscode.Selection(pos, pos);
    await a.intelligence.generateFromComment(editor);
    const cursor = editor.selection.active;
    const items = await a.inline.provideInlineCompletionItems(doc, cursor, { triggerKind: vscode.InlineCompletionTriggerKind.Automatic, selectedCompletionInfo: undefined }, new vscode.CancellationTokenSource().token);
    assert.ok(items && items.length === 1, 'pending suggestion served');
    assert.match(String(items[0].insertText), /Heal|heal/);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  test('indexes the workspace and answers @codebase questions', async () => {
    const a = await api();
    await waitFor(() => (a.indexer.current.state !== 'indexing' && a.indexer.current.files >= 3 ? true : undefined), undefined, 'index');
    const hits = a.indexer.index.search('where are users looked up by name?', { limit: 3 });
    assert.ok(hits.some((h) => h.chunk.path === 'src/auth.py'), JSON.stringify(hits.map((h) => h.chunk.id)));
    await a.intelligence.askCodebase('Where are users looked up?');
    const run = await lastRun(a, '@codebase');
    assert.equal(run.status, 'done', run.error);
    assert.match(run.content, /auth\.py/);
  });

  test('metrics are recorded locally', async () => {
    const a = await api();
    const s = a.metrics.summary();
    assert.ok(s.inline.requests >= 1);
    assert.ok(s.chat.requests >= 1);
  });
});
