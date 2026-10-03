// Code intelligence commands: explain, review, security, tests, refactor, fix,
// document, generate-from-comment, @codebase questions and follow-ups.
// Each run streams into the results panel; edits go through diff proposals.

import * as vscode from 'vscode';
import { directiveAt, type DirectiveKind } from '../core/intelligence/directives';
import { locateExcerpt, parseJsonLoose, primaryCode } from '../core/intelligence/parse';
import {
  codebasePrompt,
  documentPrompt,
  explainPrompt,
  fixPrompt,
  followUpMessages,
  generatePrompt,
  refactorPrompt,
  reviewPrompt,
  securityPrompt,
  testsPrompt,
  type CodeUnderAnalysis,
  type CodebaseExcerpt,
  type PromptEnvironment,
} from '../core/intelligence/prompts';
import { REVIEW_SCHEMA, SECURITY_SCHEMA, type ReviewAnswer, type SecurityAnswer } from '../core/intelligence/schemas';
import { testFrameworkFor } from '../core/index/projectSummary';
import { LocalOnlyViolation } from '../core/policy/localOnly';
import { ProviderError, type ChatMessage } from '../core/providers/types';
import { analyzeStatic, formatFindingsForPrompt, type StaticFinding } from '../core/security/analyzer';
import { isCancellation } from '../core/util/async';
import { leadingWhitespace, truncate } from '../core/util/text';
import { estimateTokens } from '../core/util/tokens';
import type { ActionView, FindingSeverity, FindingView, TaskKind } from '../webview/protocol';
import type { ContextGatherer } from './contextGatherer';
import { FindingsStore, type FindingLocation } from './findings';
import { gitDiff } from './git';
import type { WorkspaceIndexer } from './indexer';
import type { LocalInlineProvider } from './inlineProvider';
import type { Logger } from './logger';
import type { ChatCallResult, ModelManager } from './modelManager';
import type { RunHandle, ResultsPanel } from './panel';
import type { ProposalManager } from './proposals';
import { settings } from './settings';
import { resolveTarget, targetAtLine, targetBelow, type CodeTarget } from './targets';

interface FindingRecord {
  view: FindingView;
  uri: vscode.Uri;
  range: vscode.Range;
}

interface RunRecord {
  id: string;
  task: TaskKind;
  abort: AbortController;
  history: ChatMessage[];
  languageId?: string;
  code?: string;
  suggestedPath?: string;
  proposalId?: string;
  findings: Map<string, FindingRecord>;
  rerunWithReasoning?: () => void;
}

export interface Deps {
  models: ModelManager;
  indexer: WorkspaceIndexer;
  context: ContextGatherer;
  panel: ResultsPanel;
  proposals: ProposalManager;
  findings: FindingsStore;
  inline: LocalInlineProvider;
  log: Logger;
}

export interface FixRequest {
  uri: string;
  line: number;
  message: string;
  source?: string;
  code?: string;
}

const DEFAULT_REFACTOR = 'improve readability and structure without changing behaviour';
const OUTPUT_RESERVE = 3000;

export function friendlyError(err: unknown, model?: string): string {
  if (err instanceof LocalOnlyViolation) return `🔒 ${err.message}`;
  if (err instanceof ProviderError) {
    switch (err.code) {
      case 'unreachable':
        return `${err.message}\n\nStart Ollama (or your local server) and try again.`;
      case 'model_not_found':
        return `Model ${model ? `"${model}" ` : ''}is not installed. Install it from the dashboard (Local Copilot: Open Dashboard) or run \`ollama pull ${model ?? '<model>'}\`.`;
      case 'timeout':
        return `${err.message} The model may still be loading, or be too large for this machine.`;
      default:
        return err.message;
    }
  }
  return (err as Error)?.message ?? String(err);
}

export class IntelligenceService {
  private readonly records = new Map<string, RunRecord>();

  constructor(private readonly d: Deps) {}

  // ---------------------------------------------------------------- entry points

  async explain(target?: CodeTarget): Promise<void> {
    const t = target ?? (await this.pickTarget('explain'));
    if (!t) return;
    const { cua, env } = await this.prepare(t);
    await this.simpleRun('explain', `Explain · ${t.symbolName ?? t.description}`, t, explainPrompt(cua, env), [{ id: 'copy', label: 'Copy' }]);
  }

  async review(target?: CodeTarget, reasoning?: boolean): Promise<void> {
    const t = target ?? (await this.pickTarget('review'));
    if (!t) return;
    const { cua, env } = await this.prepare(t);
    const diff = await gitDiff(t.document.uri);
    const messages = reviewPrompt(cua, env, diff);
    const { run, record } = this.begin('review', `Review · ${t.symbolName ?? t.description}`, t);
    record.rerunWithReasoning = () => void this.review(t, true);
    const result = await this.streamJson(run, record, 'review', messages, REVIEW_SCHEMA, reasoning);
    if (!result) return;
    const answer = parseJsonLoose<ReviewAnswer>(result.text);
    if (!answer) return this.finishAsText(run, record, result);
    const lines = t.document.getText().split(/\r?\n/);
    const views: FindingView[] = [];
    const locations: FindingLocation[] = [];
    (answer.findings ?? []).forEach((f, i) => {
      const line = this.clampToTarget(t, locateExcerpt(lines, f.excerpt, (f.line ?? t.range.start.line + 1) - 1));
      const endLine = f.endLine && f.endLine > f.line ? Math.min(t.range.end.line, line + (f.endLine - f.line)) : line;
      const view: FindingView = {
        id: `R${i + 1}`,
        severity: (['info', 'warning', 'error'].includes(f.severity) ? f.severity : 'warning') as FindingSeverity,
        title: f.title,
        line: line + 1,
        endLine: endLine + 1,
        path: this.d.indexer.relPath(t.document.uri),
        category: f.category,
        source: 'llm',
        explanation: f.explanation,
        suggestion: f.suggestion,
      };
      const range = new vscode.Range(line, 0, endLine, lines[endLine]?.length ?? 0);
      views.push(view);
      record.findings.set(view.id, { view, uri: t.document.uri, range });
      locations.push({ findingId: view.id, range, severity: view.severity, message: view.title, code: f.category });
    });
    this.d.findings.set(t.document.uri, record.id, locations, 'review');
    record.history = [...messages, { role: 'assistant', content: this.findingsAsText(answer.summary, views) }];
    run.update({
      status: 'done',
      content: `${answer.summary || ''}${views.length === 0 ? '\n\n✅ No issues found.' : ''}`,
      findings: views,
      actions: this.reviewActions(record, result),
    });
  }

  async security(target?: CodeTarget, reasoning?: boolean): Promise<void> {
    const t = target ?? (await this.pickTarget('security'));
    if (!t) return;
    const text = t.document.getText().replace(/\r\n/g, '\n');
    const staticFindings = analyzeStatic(text, t.document.languageId, { startLine: t.range.start.line, endLine: t.range.end.line });
    const path = this.d.indexer.relPath(t.document.uri);
    const { run, record } = this.begin('security', `Security · ${t.symbolName ?? t.description}`, t);
    record.rerunWithReasoning = () => void this.security(t, true);
    const lines = text.split('\n');

    const staticViews = staticFindings.map((f, i) => this.staticView(f, i, path));
    staticViews.forEach((v, i) => record.findings.set(v.id, { view: v, uri: t.document.uri, range: this.lineRange(lines, staticFindings[i].line) }));
    this.publishFindings(t.document.uri, record);
    run.update({
      findings: staticViews,
      content: `Static rules: **${staticFindings.length}** potential issue(s).${settings.securityLlmReview() ? ` Asking \`${settings.taskModel('security')}\` to verify them and look further…` : ''}`,
    });
    if (!settings.securityLlmReview()) {
      run.update({ status: 'done', actions: [{ id: 'clearFindings', label: 'Clear highlights' }] });
      return;
    }

    const { cua, env } = await this.prepare(t);
    const messages = securityPrompt(cua, env, formatFindingsForPrompt(staticFindings));
    const result = await this.streamJson(run, record, 'security', messages, SECURITY_SCHEMA, reasoning);
    if (!result) return;
    const answer = parseJsonLoose<SecurityAnswer>(result.text);
    if (!answer) return this.finishAsText(run, record, result);

    for (const v of answer.staticVerdicts ?? []) {
      const rec = record.findings.get(v.id);
      if (!rec) continue;
      rec.view.verdict = v.verdict;
      rec.view.source = 'static+llm';
      if (v.reason) rec.view.explanation = `${rec.view.explanation}\n\n**AI verdict (${v.verdict.replace('_', ' ')}):** ${v.reason}`;
    }
    (answer.findings ?? []).forEach((f, i) => {
      const line = this.clampToTarget(t, locateExcerpt(lines, f.excerpt, (f.line ?? t.range.start.line + 1) - 1));
      const duplicate = [...record.findings.values()].some((r) => r.view.line === line + 1 && r.view.source !== 'llm' && r.view.cwe && r.view.cwe === f.cwe);
      if (duplicate) return;
      const view: FindingView = {
        id: `A${i + 1}`,
        severity: (['low', 'medium', 'high', 'critical'].includes(f.severity) ? f.severity : 'medium') as FindingSeverity,
        title: f.title,
        line: line + 1,
        path,
        cwe: f.cwe,
        confidence: f.confidence,
        category: 'security',
        source: 'llm',
        explanation: f.explanation,
        suggestion: f.suggestion,
      };
      record.findings.set(view.id, { view, uri: t.document.uri, range: this.lineRange(lines, line) });
    });
    const views = [...record.findings.values()]
      .map((r) => r.view)
      .sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || (a.line ?? 0) - (b.line ?? 0));
    this.publishFindings(t.document.uri, record);
    record.history = [...messages, { role: 'assistant', content: this.findingsAsText(answer.summary, views) }];
    const confirmed = views.filter((v) => v.verdict !== 'false_positive').length;
    run.update({
      status: 'done',
      content: `${answer.summary || ''}\n\n${confirmed === 0 ? '✅ No vulnerability confirmed.' : `**${confirmed}** issue(s) to look at (false positives are struck through).`}`,
      findings: views,
      actions: this.reviewActions(record, result),
    });
  }

  async tests(target?: CodeTarget): Promise<void> {
    const t = target ?? (await this.pickTarget('tests'));
    if (!t) return;
    const { cua, env } = await this.prepare(t);
    const framework = testFrameworkFor(t.document.languageId, this.d.indexer.projectSummary);
    const { run, record } = this.begin('tests', `Tests · ${t.symbolName ?? t.description}`, t, framework);
    const result = await this.streamText(run, record, 'tests', testsPrompt(cua, env, framework));
    if (!result) return;
    record.code = primaryCode(result.text, t.document.languageId);
    record.languageId = t.document.languageId;
    record.suggestedPath = /^\s*(?:\/\/|#|--)\s*([\w./\\-]+\.\w+)\s*$/m.exec(record.code?.split('\n')[0] ?? '')?.[1];
    run.update({
      status: 'done',
      actions: [
        { id: 'newFile', label: record.suggestedPath ? `Open as ${record.suggestedPath}` : 'Open in new file', kind: 'primary' },
        { id: 'copyCode', label: 'Copy code' },
      ],
    });
  }

  async refactor(target?: CodeTarget, instruction?: string): Promise<void> {
    const t = target ?? (await this.pickTarget('refactor'));
    if (!t) return;
    let goal = instruction;
    if (goal === undefined) {
      goal = await vscode.window.showInputBox({
        title: 'Local Copilot · Refactor',
        prompt: `How should "${t.symbolName ?? t.description}" change? (Enter = improve readability, same behaviour)`,
        placeHolder: 'e.g. extract the validation into a helper, use async/await, remove duplication…',
      });
      if (goal === undefined) return;
    }
    const { cua, env } = await this.prepare(t);
    const { run, record } = this.begin('refactor', `Refactor · ${t.symbolName ?? t.description}`, t, goal || undefined);
    const result = await this.streamText(run, record, 'refactor', refactorPrompt(cua, env, goal || DEFAULT_REFACTOR));
    if (!result) return;
    await this.proposeReplacement(run, record, t, result.text, 'Refactor');
  }

  async fix(arg?: FixRequest | CodeTarget, problemText?: string): Promise<void> {
    let t: CodeTarget | undefined;
    let problem = problemText ?? '';
    if (arg && 'document' in arg) t = arg;
    else if (arg && 'uri' in arg) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.uri));
      t = await targetAtLine(doc, new vscode.Position(arg.line, 0));
      problem = `${arg.source ? `${arg.source} ` : ''}${arg.code ? `${arg.code}: ` : ''}${arg.message} (line ${arg.line + 1})`;
    } else t = await this.pickTarget('fix');
    if (!t) return;
    if (!problem) {
      const diags = vscode.languages
        .getDiagnostics(t.document.uri)
        .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning && d.range.intersection(t!.range));
      problem = diags.map((d) => `L${d.range.start.line + 1} ${d.source ?? ''} ${d.code ? String(typeof d.code === 'object' ? d.code.value : d.code) : ''}: ${d.message}`).join('\n');
    }
    if (!problem) {
      const typed = await vscode.window.showInputBox({
        title: 'Local Copilot · Fix',
        prompt: 'Describe the problem or paste the error / stack trace (Enter = look for the most likely bug)',
      });
      if (typed === undefined) return;
      problem = typed;
    }
    const { cua, env } = await this.prepare(t);
    const { run, record } = this.begin('fix', `Fix · ${t.symbolName ?? t.description}`, t, problem ? truncate(problem.split('\n')[0], 80) : undefined);
    const result = await this.streamText(run, record, 'fix', fixPrompt(cua, env, problem));
    if (!result) return;
    await this.proposeReplacement(run, record, t, result.text, 'Fix');
  }

  async document(target?: CodeTarget): Promise<void> {
    const t = target ?? (await this.pickTarget('document'));
    if (!t) return;
    const doc = t.document;
    const firstCodeLine = this.firstCodeLine(doc, t.range.start.line, t.range.end.line);
    const declIndent = leadingWhitespace(doc.lineAt(firstCodeLine).text);
    const python = doc.languageId === 'python' || doc.languageId === 'gdscript';
    const indent = python ? `${declIndent}${doc.lineAt(firstCodeLine).text.includes('\t') ? '\t' : '    '}` : declIndent;
    const { cua, env } = await this.prepare(t);
    const { run, record } = this.begin('document', `Docs · ${t.symbolName ?? t.description}`, t);
    const result = await this.streamText(run, record, 'document', documentPrompt(cua, env, indent));
    if (!result) return;
    const comment = primaryCode(result.text, doc.languageId);
    if (!comment) return run.update({ status: 'error', error: 'The model did not return a comment.' });
    const normalized = this.reindent(comment, indent);
    let insertLine = t.range.start.line;
    if (python) {
      insertLine = firstCodeLine;
      while (insertLine < t.range.end.line && !/:\s*(#.*)?$/.test(doc.lineAt(insertLine).text)) insertLine++;
      insertLine++;
    }
    const at = new vscode.Position(insertLine, 0);
    const proposal = this.d.proposals.create({
      uri: doc.uri,
      range: new vscode.Range(at, at),
      original: '',
      replacement: `${normalized}\n`,
      version: doc.version,
      title: `Docs: ${t.symbolName ?? t.description}`,
    });
    record.proposalId = proposal.id;
    record.code = normalized;
    await this.d.proposals.showDiff(proposal.id);
    run.update({ status: 'done', actions: this.proposalActions() });
  }

  /** Ctrl+Alt+Enter: implement the comment above the cursor (or run the analysis it asks for). */
  async generateFromComment(editor = vscode.window.activeTextEditor): Promise<void> {
    if (!editor) return;
    const doc = editor.document;
    const text = doc.getText().replace(/\r\n/g, '\n');
    const directive = directiveAt(text, doc.languageId, editor.selection.active.line);
    if (!directive) {
      void vscode.window.showInformationMessage(
        'Local Copilot: write a comment describing the code you want (e.g. "// Validate a French SIRET number"), then press Ctrl+Alt+Enter on it or on the empty line below.',
      );
      return;
    }
    if (directive.kind !== 'generate') {
      await this.runAnalysis(directive.kind, await targetBelow(doc, directive.endLine));
      return;
    }
    // Generation happens on the line right below the comment block.
    const commentIndent = leadingWhitespace(doc.lineAt(directive.startLine).text);
    let insertLine = directive.endLine + 1;
    if (insertLine >= doc.lineCount || doc.lineAt(insertLine).text.trim() !== '') {
      await editor.edit((e) => e.insert(new vscode.Position(directive.endLine, doc.lineAt(directive.endLine).text.length), `\n${commentIndent}`));
      insertLine = directive.endLine + 1;
    }
    const lineText = doc.lineAt(insertLine).text;
    const cursor = new vscode.Position(insertLine, lineText.length);
    editor.selection = new vscode.Selection(cursor, cursor);
    const offset = doc.offsetAt(cursor);
    const full = doc.getText();
    const env: PromptEnvironment = {
      language: settings.answerLanguage(),
      projectSummary: this.d.indexer.summaryText(),
      related: await this.d.context.taskContext(doc, new vscode.Range(Math.max(0, insertLine - 30), 0, insertLine, 0), 2500),
    };
    const messages = generatePrompt({
      path: this.d.indexer.relPath(doc.uri),
      languageId: doc.languageId,
      before: full.slice(Math.max(0, offset - 6000), offset),
      after: full.slice(offset, offset + 2000),
      instruction: directive.text,
      indent: commentIndent,
      env,
    });
    const versionBefore = doc.version;
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Local Copilot: generating with ${settings.taskModel('generate')}…`, cancellable: true },
      async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        let chars = 0;
        try {
          return await this.d.models.chat('generate', messages, {
            signal: abort.signal,
            onDelta: (dl) => {
              chars += dl.text?.length ?? 0;
              if (dl.text) progress.report({ message: `${Math.round(chars / 3.4)} tokens` });
              else if (dl.thinking) progress.report({ message: 'reasoning…' });
            },
          });
        } catch (err) {
          if (!isCancellation(err)) void vscode.window.showErrorMessage(`Local Copilot: ${friendlyError(err, settings.taskModel('generate'))}`);
          return undefined;
        }
      },
    );
    if (!result) return;
    const code = primaryCode(result.text, doc.languageId);
    if (!code) return;
    const already = lineText; // whitespace already on the cursor line
    const reindented = this.reindent(code, commentIndent);
    const suggestion = reindented.startsWith(already) ? reindented.slice(already.length) : reindented.trimStart();
    const active = vscode.window.activeTextEditor;
    const stillHere = active?.document === doc && doc.version === versionBefore && active.selection.active.isEqual(cursor);
    if (active && stillHere) {
      await this.d.inline.presentSuggestion(active, suggestion);
      void vscode.window.setStatusBarMessage('Local Copilot: Tab to accept the generated code, Esc to dismiss', 6000);
    } else {
      const run = this.d.panel.startRun({ task: 'generate', title: `Generated · ${truncate(directive.text, 60)}`, subtitle: this.d.indexer.relPath(doc.uri) });
      const record = this.record(run.id, 'generate');
      record.code = suggestion;
      run.update({ status: 'done', content: `\`\`\`${doc.languageId}\n${reindented}\n\`\`\``, actions: [{ id: 'insert', label: 'Insert at cursor', kind: 'primary' }, { id: 'copyCode', label: 'Copy' }] });
    }
  }

  async askCodebase(question?: string): Promise<void> {
    const q =
      question ??
      (await vscode.window.showInputBox({
        title: 'Local Copilot · @codebase',
        prompt: 'Ask a question about this workspace',
        placeHolder: 'Where is authentication handled? How does the owner AI react to noise?',
      }));
    if (!q?.trim()) return;
    const status = this.d.indexer.current;
    if (status.state === 'disabled') {
      void vscode.window.showWarningMessage(`Local Copilot: ${status.message ?? 'the codebase index is disabled.'}`);
      return;
    }
    const { run, record } = this.begin('codebase', `@codebase · ${truncate(q, 70)}`);
    if (status.state === 'indexing') run.update({ subtitle: `index still building (${status.files} files so far)` });
    const vector = await this.d.indexer.queryVector(q, record.abort.signal);
    const hits = this.d.indexer.index.search(q, { limit: 16, queryVector: vector });
    const budget = Math.max(2000, settings.chatContextLength() - OUTPUT_RESERVE - 1500);
    const excerpts: CodebaseExcerpt[] = [];
    let used = 0;
    for (const h of hits) {
      const text = await this.d.indexer.index.chunkText(h.chunk);
      if (!text) continue;
      const t = estimateTokens(text);
      if (used + t > budget) continue;
      used += t;
      const file = this.d.indexer.index.files.get(h.chunk.path);
      excerpts.push({ path: h.chunk.path, startLine: h.chunk.startLine + 1, endLine: h.chunk.endLine + 1, symbol: h.chunk.symbol, languageId: file?.languageId ?? 'text', text });
    }
    run.update({ subtitle: `${excerpts.length} excerpt(s)${vector ? ' · semantic + keyword search' : ' · keyword + symbol search'} · ${settings.taskModel('codebase')}` });
    const env: PromptEnvironment = { language: settings.answerLanguage(), projectSummary: this.d.indexer.summaryText(), related: [] };
    const messages = codebasePrompt(q, excerpts, env, this.d.indexer.fileTree());
    const result = await this.streamText(run, record, 'codebase', messages);
    if (!result) return;
    const sources = excerpts.map((e) => `\`${e.path}:${e.startLine}-${e.endLine}\``).join(' · ');
    run.update({ status: 'done', content: `${run.state?.content ?? ''}\n\n---\n**Searched:** ${sources || 'nothing relevant found'}`, actions: [{ id: 'copy', label: 'Copy' }] });
  }

  async followUp(runId: string, question: string): Promise<void> {
    const parent = this.records.get(runId);
    if (!parent || parent.history.length === 0) {
      await this.askCodebase(question);
      return;
    }
    const messages = followUpMessages(parent.history, question);
    const run = this.d.panel.startRun({ task: 'followup', title: `↳ ${truncate(question, 80)}`, parentId: runId, subtitle: settings.taskModel('followup') });
    const record = this.record(run.id, 'followup');
    const result = await this.streamText(run, record, 'followup', messages);
    if (!result) return;
    record.code = primaryCode(result.text);
    run.update({ status: 'done', actions: [{ id: 'copy', label: 'Copy' }] });
  }

  async runDirective(uri: string, line: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
    const directive = directiveAt(doc.getText().replace(/\r\n/g, '\n'), doc.languageId, line);
    if (!directive) return;
    if (directive.kind === 'generate') {
      const editor = await vscode.window.showTextDocument(doc);
      const pos = new vscode.Position(directive.endLine, doc.lineAt(directive.endLine).text.length);
      editor.selection = new vscode.Selection(pos, pos);
      await this.generateFromComment(editor);
      return;
    }
    await this.runAnalysis(directive.kind, await targetBelow(doc, directive.endLine));
  }

  async fixFinding(runId: string, findingId: string): Promise<void> {
    const rec = this.records.get(runId)?.findings.get(findingId);
    if (!rec) return;
    const doc = await vscode.workspace.openTextDocument(rec.uri);
    const target = await targetAtLine(doc, rec.range.start);
    const f = rec.view;
    const problem = `${f.title} (line ${f.line})${f.cwe ? ` [${f.cwe}]` : ''}\n${f.explanation}${f.suggestion ? `\nSuggested fix: ${f.suggestion}` : ''}`;
    await this.fix(target, problem);
  }

  cancel(runId: string): void {
    this.records.get(runId)?.abort.abort();
  }

  forget(runId: string): void {
    this.records.get(runId)?.abort.abort();
    this.records.delete(runId);
    this.d.findings.clearRun(runId);
  }

  async handleAction(runId: string, actionId: string): Promise<void> {
    const record = this.records.get(runId);
    if (!record) return;
    switch (actionId) {
      case 'copy':
        await vscode.env.clipboard.writeText(this.d.panel.run(runId)?.content ?? '');
        void vscode.window.setStatusBarMessage('Local Copilot: copied', 2000);
        return;
      case 'copyCode':
        await vscode.env.clipboard.writeText(record.code ?? '');
        void vscode.window.setStatusBarMessage('Local Copilot: code copied', 2000);
        return;
      case 'insert':
        if (record.code) await this.insertAtCursor(record.code);
        return;
      case 'newFile':
        if (record.code) await this.openAsNewFile(record.code, record.languageId, record.suggestedPath);
        return;
      case 'apply':
        if (record.proposalId && (await this.d.proposals.apply(record.proposalId))) this.d.panel.update(runId, { actions: [], subtitle: `${this.d.panel.run(runId)?.subtitle ?? ''} · applied ✓` });
        return;
      case 'diff':
        if (record.proposalId) await this.d.proposals.showDiff(record.proposalId);
        return;
      case 'discard':
        if (record.proposalId) await this.d.proposals.discard(record.proposalId);
        this.d.panel.update(runId, { actions: [], subtitle: `${this.d.panel.run(runId)?.subtitle ?? ''} · discarded` });
        return;
      case 'clearFindings':
        this.d.findings.clearRun(runId);
        return;
      case 'rerunReasoning':
        record.rerunWithReasoning?.();
        return;
    }
  }

  /** Apply / discard from the diff editor's title buttons. */
  async applyActiveProposal(apply: boolean): Promise<void> {
    const id = this.d.proposals.activeId();
    if (!id) return;
    const record = [...this.records.values()].find((r) => r.proposalId === id);
    if (record) return this.handleAction(record.id, apply ? 'apply' : 'discard');
    if (apply) await this.d.proposals.apply(id);
    else await this.d.proposals.discard(id);
  }

  async insertAtCursor(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
    if (!editor) {
      void vscode.window.showWarningMessage('Local Copilot: open an editor to insert the code.');
      return;
    }
    await editor.edit((e) => e.replace(editor.selection, code));
  }

  async runAnalysis(kind: DirectiveKind, target: CodeTarget): Promise<void> {
    switch (kind) {
      case 'security':
        return this.security(target);
      case 'review':
        return this.review(target);
      case 'explain':
        return this.explain(target);
      case 'tests':
        return this.tests(target);
      case 'refactor':
        return this.refactor(target);
      case 'document':
        return this.document(target);
      case 'fix':
        return this.fix(target);
      case 'generate':
        return this.generateFromComment();
    }
  }

  // ---------------------------------------------------------------- internals

  private async pickTarget(task: TaskKind): Promise<CodeTarget | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Local Copilot: open a file and place the cursor in the code first.');
      return undefined;
    }
    const doc = editor.document;
    if (editor.selection.isEmpty) {
      // On a directive comment ("// review the function below"), act on the code below it.
      const directive = directiveAt(doc.getText().replace(/\r\n/g, '\n'), doc.languageId, editor.selection.active.line);
      if (directive && directive.kind !== 'generate' && editor.selection.active.line <= directive.endLine) return targetBelow(doc, directive.endLine);
    }
    return resolveTarget(editor);
  }

  private async prepare(t: CodeTarget): Promise<{ cua: CodeUnderAnalysis; env: PromptEnvironment }> {
    let code = t.document.getText(t.range).replace(/\r\n/g, '\n');
    const maxCodeTokens = Math.max(1500, settings.chatContextLength() - OUTPUT_RESERVE - 3000);
    if (estimateTokens(code) > maxCodeTokens) {
      const keepLines = Math.floor((maxCodeTokens * 3.4) / Math.max(20, code.length / code.split('\n').length));
      code = `${code.split('\n').slice(0, keepLines).join('\n')}\n… (truncated: the code is too long for the model context)`;
    }
    const budget = Math.max(0, Math.min(6000, settings.chatContextLength() - estimateTokens(code) - OUTPUT_RESERVE - 1000));
    const related = budget > 300 ? await this.d.context.taskContext(t.document, t.range, budget) : [];
    return {
      cua: { path: this.d.indexer.relPath(t.document.uri), languageId: t.document.languageId, startLine: t.range.start.line + 1, code, description: t.description },
      env: { language: settings.answerLanguage(), projectSummary: this.d.indexer.summaryText(), related },
    };
  }

  private record(id: string, task: TaskKind): RunRecord {
    const record: RunRecord = { id, task, abort: new AbortController(), history: [], findings: new Map() };
    this.records.set(id, record);
    if (this.records.size > 60) this.records.delete(this.records.keys().next().value as string);
    return record;
  }

  private begin(task: TaskKind, title: string, t?: CodeTarget, note?: string): { run: RunHandle; record: RunRecord } {
    const where = t ? `${this.d.indexer.relPath(t.document.uri)}:${t.range.start.line + 1}-${t.range.end.line + 1}` : undefined;
    const subtitle = [where, note, settings.taskModel(task)].filter(Boolean).join(' · ');
    const run = this.d.panel.startRun({ task, title, subtitle });
    return { run, record: this.record(run.id, task) };
  }

  private async simpleRun(task: TaskKind, title: string, t: CodeTarget, messages: ChatMessage[], actions: ActionView[]): Promise<void> {
    const { run, record } = this.begin(task, title, t);
    const result = await this.streamText(run, record, task, messages);
    if (!result) return;
    run.update({ status: 'done', actions });
  }

  private async streamText(run: RunHandle, record: RunRecord, task: TaskKind, messages: ChatMessage[], reasoning?: boolean): Promise<ChatCallResult | undefined> {
    return this.call(run, record, task, messages, { reasoning, onText: (s) => run.appendContent(s) });
  }

  /** JSON answers are not shown raw: show a progress line, render the parsed result at the end. */
  private async streamJson(run: RunHandle, record: RunRecord, task: TaskKind, messages: ChatMessage[], schema: object, reasoning?: boolean): Promise<ChatCallResult | undefined> {
    const prefix = run.state?.content ? `${run.state.content}\n\n` : '';
    let chars = 0;
    let lastShown = 0;
    return this.call(run, record, task, messages, {
      reasoning,
      jsonSchema: schema as Record<string, unknown>,
      onText: (s) => {
        chars += s.length;
        if (chars - lastShown > 200) {
          lastShown = chars;
          run.update({ content: `${prefix}_Analyzing… ${Math.round(chars / 3.4)} tokens_` });
        }
      },
    });
  }

  private async call(
    run: RunHandle,
    record: RunRecord,
    task: TaskKind,
    messages: ChatMessage[],
    opts: { reasoning?: boolean; jsonSchema?: Record<string, unknown>; onText: (s: string) => void },
  ): Promise<ChatCallResult | undefined> {
    try {
      const result = await this.d.models.chat(task, messages, {
        jsonSchema: opts.jsonSchema,
        reasoning: opts.reasoning,
        signal: record.abort.signal,
        onDelta: (dl) => {
          if (dl.thinking) run.appendThinking(dl.thinking);
          if (dl.text) opts.onText(dl.text);
        },
      });
      record.history = [...messages, { role: 'assistant', content: result.text }];
      run.update({
        stats: { model: result.model, seconds: result.stats.totalMs / 1000, outputTokens: result.stats.outputTokens, tokensPerSecond: result.stats.tokensPerSecond },
      });
      return result;
    } catch (err) {
      if (isCancellation(err) || record.abort.signal.aborted) {
        run.update({ status: 'cancelled' });
        return undefined;
      }
      this.d.log.error(`${task} failed`, err);
      run.update({ status: 'error', error: friendlyError(err, settings.taskModel(task)) });
      return undefined;
    }
  }

  private finishAsText(run: RunHandle, record: RunRecord, result: ChatCallResult): void {
    // The model ignored the JSON format: show what it said rather than nothing.
    record.history = [...record.history.slice(0, -1), { role: 'assistant', content: result.text }];
    run.update({ status: 'done', content: result.text, actions: [{ id: 'copy', label: 'Copy' }] });
  }

  private reviewActions(record: RunRecord, result: ChatCallResult): ActionView[] {
    const actions: ActionView[] = [{ id: 'clearFindings', label: 'Clear highlights' }];
    if (result.reasoningAvailable && !result.reasoningUsed && record.rerunWithReasoning) actions.unshift({ id: 'rerunReasoning', label: 'Re-run with deep reasoning (slower)' });
    return actions;
  }

  private proposalActions(): ActionView[] {
    return [
      { id: 'apply', label: 'Apply', kind: 'primary' },
      { id: 'diff', label: 'Show diff' },
      { id: 'discard', label: 'Discard' },
    ];
  }

  private async proposeReplacement(run: RunHandle, record: RunRecord, t: CodeTarget, answer: string, label: string): Promise<void> {
    const code = primaryCode(answer, t.document.languageId);
    if (!code) {
      run.update({ status: 'done', actions: [{ id: 'copy', label: 'Copy' }] });
      return;
    }
    const original = t.document.getText(t.range);
    const eol = t.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const replacement = code.replace(/\r?\n/g, eol);
    if (replacement.trim() === original.trim()) {
      run.update({ status: 'done', content: `${run.state?.content ?? ''}\n\n_No change proposed._` });
      return;
    }
    const proposal = this.d.proposals.create({ uri: t.document.uri, range: t.range, original, replacement, version: t.document.version, title: `${label}: ${t.symbolName ?? t.description}` });
    record.proposalId = proposal.id;
    record.code = code;
    await this.d.proposals.showDiff(proposal.id);
    run.update({ status: 'done', actions: this.proposalActions() });
  }

  private staticView(f: StaticFinding, i: number, path: string): FindingView {
    return {
      id: `S${i + 1}`,
      severity: f.severity,
      title: f.title,
      line: f.line + 1,
      path,
      cwe: f.cwe,
      confidence: f.confidence,
      category: 'security',
      source: 'static',
      explanation: `${f.message}${f.taint ? `\n\nData flow: \`${f.taint.variable}\` comes from ${f.taint.source === 'user-input' ? 'user input' : 'a parameter'}${f.taint.functionName ? ` of \`${f.taint.functionName}\`` : ''}.` : ''}\n\n\`${f.excerpt}\``,
      suggestion: f.recommendation,
    };
  }

  private publishFindings(uri: vscode.Uri, record: RunRecord): void {
    const items: FindingLocation[] = [...record.findings.entries()]
      .filter(([, r]) => r.view.verdict !== 'false_positive')
      .map(([id, r]) => ({ findingId: id, range: r.range, severity: r.view.severity, message: `${r.view.title}${r.view.cwe ? ` (${r.view.cwe})` : ''}`, code: r.view.cwe }));
    this.d.findings.set(uri, record.id, items, record.task === 'security' ? 'security' : 'review');
  }

  private findingsAsText(summary: string, views: FindingView[]): string {
    const lines = views.map((v) => `- L${v.line} [${v.severity}${v.verdict ? `, ${v.verdict}` : ''}] ${v.title}: ${v.explanation.split('\n')[0]}`);
    return `${summary}\n\n${lines.join('\n') || 'No findings.'}`;
  }

  private lineRange(lines: string[], line: number): vscode.Range {
    const l = Math.max(0, Math.min(lines.length - 1, line));
    const text = lines[l] ?? '';
    const start = text.length - text.trimStart().length;
    return new vscode.Range(l, start, l, text.length);
  }

  private clampToTarget(t: CodeTarget, line: number): number {
    return Math.max(t.range.start.line, Math.min(t.range.end.line, line));
  }

  private firstCodeLine(doc: vscode.TextDocument, start: number, end: number): number {
    for (let l = start; l <= end; l++) {
      const s = doc.lineAt(l).text.trim();
      if (s && !/^(\/\/|#|\/\*|\*|@|\[)/.test(s)) return l;
    }
    return start;
  }

  /** Re-bases a code block on `indent`, keeping its relative indentation. */
  private reindent(code: string, indent: string): string {
    const lines = code.replace(/\r\n/g, '\n').split('\n');
    const nonEmpty = lines.filter((l) => l.trim());
    const min = Math.min(...nonEmpty.map((l) => leadingWhitespace(l).length));
    return lines.map((l) => (l.trim() ? indent + l.slice(Number.isFinite(min) ? min : 0) : '')).join('\n');
  }

  private async openAsNewFile(code: string, languageId?: string, suggested?: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (suggested && folder) {
      const target = vscode.Uri.joinPath(folder.uri, suggested.replace(/\\/g, '/'));
      let exists = true;
      try {
        await vscode.workspace.fs.stat(target);
      } catch {
        exists = false;
      }
      if (!exists) {
        const doc = await vscode.workspace.openTextDocument(target.with({ scheme: 'untitled' }));
        const editor = await vscode.window.showTextDocument(doc);
        await editor.edit((e) => e.insert(new vscode.Position(0, 0), code));
        if (languageId) await vscode.languages.setTextDocumentLanguage(doc, languageId);
        return;
      }
    }
    const doc = await vscode.workspace.openTextDocument({ language: languageId, content: code });
    await vscode.window.showTextDocument(doc);
  }
}

function sevRank(s: FindingSeverity): number {
  return { info: 0, low: 1, medium: 2, warning: 2, high: 3, error: 3, critical: 4 }[s] ?? 0;
}
