// Results panel webview.
//
// One card per run, newest at the bottom. The run list lives in `runs` (and in
// vscode.setState so a reload restores it); the DOM is patched per card and per section,
// throttled to one pass per animation frame, so streaming never resets an open <details>,
// an expanded finding or a half-typed follow-up. Every string from the host is escaped;
// markdown goes through renderMarkdown, which escapes everything it is given.

import type { ActionView, FindingSeverity, FindingView, PanelInbound, PanelOutbound, RunState, RunStats, RunStatus, TaskKind } from './protocol';
import { escapeHtml, renderMarkdown } from './markdown';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };

const vscode = acquireVsCodeApi();

function post(msg: PanelOutbound): void {
  vscode.postMessage(msg);
}

// ---------------------------------------------------------------------------------------
// Constants

const TASK_LABELS: Record<TaskKind, string> = {
  explain: 'Explain',
  review: 'Review',
  security: 'Security',
  tests: 'Tests',
  refactor: 'Refactor',
  fix: 'Fix',
  document: 'Docs',
  generate: 'Generate',
  codebase: 'Codebase',
  followup: 'Follow-up',
};

const STATUS_VIEW: Record<RunStatus, { glyph: string; label: string }> = {
  running: { glyph: '', label: 'Running' },
  done: { glyph: '✓', label: 'Done' },
  error: { glyph: '✕', label: 'Failed' },
  cancelled: { glyph: '⏹', label: 'Stopped' },
};

const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'error', 'medium', 'warning', 'low', 'info'];

const SEVERITY_TONE: Record<FindingSeverity, string> = {
  critical: 'sev-error',
  high: 'sev-error',
  error: 'sev-error',
  medium: 'sev-warning',
  warning: 'sev-warning',
  low: 'sev-info',
  info: 'sev-info',
};

const SOURCE_VIEW: Record<FindingView['source'], { label: string; title: string }> = {
  static: { label: 'static', title: 'Found by the static rules' },
  llm: { label: 'AI', title: 'Found by the local model' },
  'static+llm': { label: 'static+AI', title: 'Found by the static rules and the local model' },
};

const VERDICT_VIEW: Record<NonNullable<FindingView['verdict']>, { label: string; cls: string; title: string }> = {
  confirmed: { label: 'confirmed ✓', cls: 'verdict-confirmed', title: 'Confirmed by the local model' },
  false_positive: { label: 'false positive', cls: 'verdict-fp', title: 'Judged a false positive by the local model' },
  uncertain: { label: 'uncertain ?', cls: 'verdict-uncertain', title: 'The local model could not decide' },
};

/** Codicons are not available in the webview: a few common names map to text glyphs. */
const ICON_GLYPHS: Record<string, string> = {
  check: '✓',
  'check-all': '✓',
  close: '✕',
  x: '✕',
  copy: '⧉',
  clippy: '⧉',
  insert: '⤓',
  diff: '±',
  'git-compare': '±',
  edit: '✎',
  pencil: '✎',
  play: '▶',
  run: '▶',
  'debug-start': '▶',
  refresh: '↻',
  sync: '↻',
  redo: '↻',
  discard: '↺',
  trash: '🗑',
  file: '🗎',
  'new-file': '🗎',
  'go-to-file': '↗',
  'link-external': '↗',
  'arrow-right': '→',
  beaker: '⚗',
  shield: '🛡',
  bug: '🐞',
  wrench: '🔧',
  tools: '🔧',
  lightbulb: '💡',
  sparkle: '✦',
  wand: '✦',
  comment: '💬',
  'comment-discussion': '💬',
  search: '⌕',
  add: '+',
  save: '💾',
  book: '📖',
  info: 'ⓘ',
  warning: '⚠',
  stop: '⏹',
  'debug-stop': '⏹',
};

const MAX_SAVED_RUNS = 50;
const STICK_THRESHOLD_PX = 40;

/** Own-property lookup: keys come from the host (and from model output it parsed). */
function own<T>(map: Record<string, T>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined;
}

function isStatus(v: unknown): v is RunStatus {
  return v === 'running' || v === 'done' || v === 'error' || v === 'cancelled';
}

/** A 1-based line number, or undefined: never interpolate an unchecked value into HTML. */
function lineNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function objects<T>(list: unknown): T[] {
  return Array.isArray(list) ? (list.filter((x) => x !== null && typeof x === 'object') as T[]) : [];
}

const CODE_TOOLBAR =
  '<div class="code-toolbar" role="toolbar" aria-label="Code block">' +
  '<button type="button" class="code-btn" data-act="copy-code" title="Copy to the clipboard">Copy</button>' +
  '<button type="button" class="code-btn" data-act="insert-code" title="Insert at the cursor in the active editor">Insert</button>' +
  '</div>';

// ---------------------------------------------------------------------------------------
// State

interface SavedState {
  v: 1;
  runs: RunState[];
  draft?: string;
  expanded?: string[];
}

interface Card {
  el: HTMLElement;
  header: HTMLElement;
  reasoning: HTMLDetailsElement;
  reasoningLabel: HTMLElement;
  reasoningText: Text;
  content: HTMLElement;
  findings: HTMLElement;
  error: HTMLElement;
  actions: HTMLElement;
  stats: HTMLElement;
  followup: HTMLFormElement;
  /** Last rendered values: a section is only touched when its input changed. */
  shown: {
    header: string;
    content: string | null;
    thinking: string;
    words: number;
    label: string;
    findings: FindingView[] | undefined | null;
    error: string;
    actions: string;
    stats: string;
  };
}

const runs = new Map<string, RunState>();
const cards = new Map<string, Card>();
const dirty = new Set<string>();
/** `${runId}::${findingId}` of expanded findings. */
const expandedFindings = new Set<string>();
let structureDirty = true;
let frame = 0;
let persistTimer = 0;
let stickToBottom = true;
let revealId: string | null = null;
let initReceived = false;

// ---------------------------------------------------------------------------------------
// Shell

const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);
const MOD = isMac ? 'Cmd' : 'Ctrl';
const ALT = isMac ? 'Option' : 'Alt';

function kbd(...keys: string[]): string {
  return keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('+');
}

const app = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
app.innerHTML = `
  <main class="runs" id="runs">
    <section class="empty-state" id="empty" hidden>
      <h2>Local Copilot</h2>
      <p>Explanations, reviews, security findings, tests and codebase answers appear here. Everything runs on this machine.</p>
      <ul class="shortcuts">
        <li>${kbd(MOD, ALT, 'L')} <span>opens the action menu (explain, review, security, tests…)</span></li>
        <li>${kbd(MOD, ALT, 'Enter')} <span>generates code from the comment above the cursor</span></li>
        <li>${kbd(MOD, ALT, 'K')} <span>asks the codebase</span></li>
        <li>${kbd('Tab')} <span>accepts ghost text</span></li>
        <li>${kbd(ALT, '\\')} <span>asks for a suggestion</span></li>
      </ul>
      <p class="muted">Or type a question about your code below.</p>
    </section>
    <div class="run-list" id="run-list"></div>
  </main>
  <form class="ask-bar" id="ask-form" autocomplete="off">
    <textarea id="ask-input" rows="1" placeholder="Ask the codebase… (Enter to send)" aria-label="Ask the codebase"></textarea>
    <button type="submit" class="btn btn-primary" title="Send (Enter)">Ask</button>
    <button type="button" class="btn btn-secondary" id="clear-all" data-act="clear-all" title="Remove all results">Clear</button>
  </form>`;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Local Copilot panel: #${id} is missing`);
  return el as T;
}

const scroller = byId<HTMLElement>('runs');
const listEl = byId<HTMLElement>('run-list');
const emptyEl = byId<HTMLElement>('empty');
const askForm = byId<HTMLFormElement>('ask-form');
const askInput = byId<HTMLTextAreaElement>('ask-input');
const clearBtn = byId<HTMLButtonElement>('clear-all');

const CARD_TEMPLATE = `
  <header class="run-header"></header>
  <details class="reasoning" hidden>
    <summary><span class="reasoning-label"></span></summary>
    <pre class="reasoning-text"></pre>
  </details>
  <div class="run-content md"></div>
  <section class="findings" hidden></section>
  <div class="run-error" role="alert" hidden></div>
  <div class="run-actions" hidden></div>
  <footer class="run-stats" hidden></footer>
  <form class="followup" hidden autocomplete="off">
    <textarea rows="1" placeholder="Ask a follow-up… (Enter to send)" title="Enter to send, Shift+Enter for a new line" aria-label="Follow-up question"></textarea>
    <button type="submit" class="btn btn-secondary btn-small" title="Send the follow-up (Enter)">Send</button>
  </form>`;

function createCard(run: RunState): Card {
  const el = document.createElement('article');
  el.className = 'run';
  el.tabIndex = -1;
  el.dataset.runId = run.id;
  el.innerHTML = CARD_TEMPLATE;
  const pick = <T extends Element>(selector: string): T => {
    const found = el.querySelector<T>(selector);
    if (!found) throw new Error(`Local Copilot panel: ${selector} is missing`);
    return found;
  };
  const reasoningText = document.createTextNode('');
  pick<HTMLElement>('.reasoning-text').appendChild(reasoningText);
  return {
    el,
    header: pick('.run-header'),
    reasoning: pick('.reasoning'),
    reasoningLabel: pick('.reasoning-label'),
    reasoningText,
    content: pick('.run-content'),
    findings: pick('.findings'),
    error: pick('.run-error'),
    actions: pick('.run-actions'),
    stats: pick('.run-stats'),
    followup: pick('.followup'),
    shown: { header: '', content: null, thinking: '', words: 0, label: '', findings: null, error: '', actions: '', stats: '' },
  };
}

// ---------------------------------------------------------------------------------------
// Rendering

/** Markdown with the hover toolbar on every code block (renderMarkdown's output format is fixed). */
function markdown(text: string): string {
  const html = renderMarkdown(text);
  if (html.indexOf('<pre class="code-block"') < 0) return html;
  return html
    .replace(/<pre class="code-block" data-lang="([^"]*)">/g, '<div class="code-wrap" data-lang="$1"><pre class="code-block" data-lang="$1">')
    .replace(/<\/pre>/g, `</pre>${CODE_TOOLBAR}</div>`);
}

function cssToken(value: string): string {
  return String(value).toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function renderHeader(run: RunState): string {
  const task = own(TASK_LABELS, run.task) ?? String(run.task);
  const status = own(STATUS_VIEW, run.status) ?? STATUS_VIEW.done;
  const statusHtml =
    run.status === 'running'
      ? `<span class="run-status status-running" title="Running"><span class="spinner" aria-hidden="true"></span><span class="visually-hidden">Running</span></span>`
      : `<span class="run-status status-${cssToken(run.status)}" title="${status.label}" aria-label="${status.label}">${status.glyph}</span>`;
  const control =
    run.status === 'running'
      ? '<button type="button" class="btn btn-secondary btn-small" data-act="stop" title="Stop generating">Stop</button>'
      : '<button type="button" class="icon-btn" data-act="remove" title="Remove this result" aria-label="Remove this result">×</button>';
  const subtitle = run.subtitle ? `<div class="run-subtitle">${escapeHtml(run.subtitle)}</div>` : '';
  return (
    `<span class="task-badge task-${cssToken(run.task)}">${escapeHtml(task)}</span>` +
    `<div class="run-titles"><div class="run-title">${escapeHtml(run.title || task)}</div>${subtitle}</div>` +
    statusHtml +
    control
  );
}

function countWords(text: string, from: number, inWord: boolean): { count: number; inWord: boolean } {
  let count = 0;
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return { count, inWord };
}

function updateReasoning(run: RunState, card: Card): void {
  const thinking = run.thinking ?? '';
  const visible = thinking.trim() !== '';
  if (card.reasoning.hidden === visible) card.reasoning.hidden = !visible;
  if (thinking !== card.shown.thinking) {
    const prev = card.shown.thinking;
    if (prev !== '' && thinking.length > prev.length && thinking.startsWith(prev)) {
      const endsInWord = !/\s$/.test(prev);
      const added = countWords(thinking, prev.length, endsInWord);
      card.shown.words += added.count;
      card.reasoningText.appendData(thinking.slice(prev.length));
    } else {
      card.shown.words = countWords(thinking, 0, false).count;
      card.reasoningText.data = thinking;
    }
    card.shown.thinking = thinking;
  }
  if (!visible) return;
  const words = card.shown.words;
  const label =
    run.status === 'running' && !run.content
      ? `<span class="reasoning-live">Reasoning… ${words} words</span>`
      : `Reasoning <span class="muted">· ${words} words</span>`;
  if (label !== card.shown.label) {
    card.reasoningLabel.innerHTML = label;
    card.shown.label = label;
  }
}

function findingKey(runId: string, findingId: string): string {
  return `${runId}::${findingId}`;
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function renderLocation(f: FindingView, showFile: boolean): string {
  const line = lineNumber(f.line);
  const end = lineNumber(f.endLine);
  const range = line !== undefined && end !== undefined && end > line ? end : undefined;
  const lines = line === undefined ? '' : range !== undefined ? `L${line}-${range}` : `L${line}`;
  const path = typeof f.path === 'string' ? f.path : '';
  if (!path) return lines ? `<span class="finding-loc">${lines}</span>` : '';
  const text = showFile ? `${basename(path)}${lines ? ` ${lines}` : ''}` : lines || basename(path);
  const where = line === undefined ? '' : range !== undefined ? ` at lines ${line}-${range}` : ` at line ${line}`;
  const title = `Open ${path}${where}`;
  return (
    `<a class="file-ref finding-loc" href="#" data-path="${escapeHtml(path)}"` +
    `${line !== undefined ? ` data-line="${line}"` : ''}${range !== undefined ? ` data-end="${range}"` : ''}` +
    ` title="${escapeHtml(title)}">${escapeHtml(text)}</a>`
  );
}

function renderFindingBody(f: FindingView): string {
  let html = f.explanation ? markdown(f.explanation) : '<p class="muted">No explanation.</p>';
  if (f.suggestion) html += `<div class="finding-suggestion"><div class="finding-suggestion-label">Suggestion</div>${markdown(f.suggestion)}</div>`;
  if (f.category) html += `<p class="finding-category muted">Category: ${escapeHtml(f.category)}</p>`;
  return html;
}

function renderFinding(runId: string, f: FindingView, showFile: boolean): string {
  const open = expandedFindings.has(findingKey(runId, f.id));
  const severity: FindingSeverity = own(SEVERITY_TONE, f.severity) ? f.severity : 'info';
  const tags: string[] = [];
  const source = own(SOURCE_VIEW, f.source);
  if (source) tags.push(`<span class="tag tag-source" title="${source.title}">${source.label}</span>`);
  if (f.confidence) tags.push(`<span class="tag" title="Confidence">${escapeHtml(f.confidence)} confidence</span>`);
  if (f.cwe) {
    const cwe = /^\d+$/.test(String(f.cwe)) ? `CWE-${f.cwe}` : f.cwe;
    tags.push(`<span class="tag tag-cwe">${escapeHtml(cwe)}</span>`);
  }
  const verdict = own(VERDICT_VIEW, f.verdict);
  if (verdict) tags.push(`<span class="tag ${verdict.cls}" title="${verdict.title}">${verdict.label}</span>`);
  const classes = ['finding', open ? 'is-open' : '', f.verdict === 'false_positive' ? 'is-false-positive' : ''].filter(Boolean).join(' ');
  return (
    `<li class="${classes}" data-finding-id="${escapeHtml(f.id)}">` +
    `<div class="finding-head" data-act="toggle-finding">` +
    `<button type="button" class="finding-toggle" data-act="toggle-finding" aria-expanded="${open}">` +
    `<span class="chevron" aria-hidden="true">▸</span>` +
    `<span class="sev-chip ${SEVERITY_TONE[severity]}">${severity}</span>` +
    `<span class="finding-title">${escapeHtml(f.title)}</span></button>` +
    `<span class="finding-meta">${renderLocation(f, showFile)}${tags.join('')}</span>` +
    `<button type="button" class="btn btn-secondary btn-small finding-fix" data-act="fix-finding" title="Ask the local model to fix this finding">Fix</button>` +
    `</div>` +
    `<div class="finding-body md"${open ? '' : ' hidden'}${open ? ' data-rendered="1"' : ''}>${open ? renderFindingBody(f) : ''}</div>` +
    `</li>`
  );
}

function renderFindings(run: RunState, card: Card): void {
  const list = objects<FindingView>(run.findings);
  if (list.length === 0) {
    card.findings.hidden = true;
    card.findings.innerHTML = '';
    return;
  }
  const counts = new Map<FindingSeverity, number>();
  let falsePositives = 0;
  const paths = new Set<string>();
  for (const f of list) {
    if (typeof f.path === 'string' && f.path) paths.add(f.path);
    const severity: FindingSeverity = own(SEVERITY_TONE, f.severity) ? f.severity : 'info';
    if (f.verdict === 'false_positive') falsePositives++;
    else counts.set(severity, (counts.get(severity) ?? 0) + 1);
  }
  const chips = SEVERITY_ORDER.filter((s) => counts.has(s))
    .map((s) => `<span class="sev-chip ${SEVERITY_TONE[s]}">${counts.get(s)} ${s}</span>`)
    .join('');
  const fp = falsePositives ? `<span class="muted">${falsePositives} false positive${falsePositives === 1 ? '' : 's'}</span>` : '';
  let html =
    `<div class="findings-summary"><strong>${list.length} finding${list.length === 1 ? '' : 's'}</strong>${chips}${fp}</div>` +
    '<ul class="finding-list">';
  const showFile = paths.size > 1;
  for (const f of list) html += renderFinding(run.id, f, showFile);
  card.findings.innerHTML = `${html}</ul>`;
  card.findings.hidden = false;
}

function renderActions(actions: ActionView[] | undefined): string {
  return objects<ActionView>(actions)
    .map((a) => {
      const kind = a.kind === 'primary' ? 'btn-primary' : 'btn-secondary';
      const glyph = own(ICON_GLYPHS, a.icon);
      const icon = glyph ? `<span class="btn-icon" aria-hidden="true">${glyph}</span>` : '';
      return `<button type="button" class="btn ${kind}" data-act="action" data-action-id="${escapeHtml(a.id)}">${icon}${escapeHtml(a.label)}</button>`;
    })
    .join('');
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function renderStats(stats: RunStats): string {
  const parts: string[] = [];
  if (stats.model) parts.push(escapeHtml(stats.model));
  if (isNum(stats.seconds)) parts.push(`${stats.seconds.toFixed(1)} s`);
  if (isNum(stats.outputTokens)) parts.push(`${Math.round(stats.outputTokens)} tok`);
  if (isNum(stats.tokensPerSecond)) parts.push(`${Math.round(stats.tokensPerSecond)} tok/s`);
  return parts.join(' · ');
}

function setSection(el: HTMLElement, html: string, last: string): string {
  if (html !== last) {
    el.innerHTML = html;
    el.hidden = html === '';
  }
  return html;
}

function updateCard(run: RunState, card: Card): void {
  const header = renderHeader(run);
  if (header !== card.shown.header) {
    card.header.innerHTML = header;
    card.shown.header = header;
  }
  card.el.dataset.status = run.status;
  card.el.classList.toggle('is-running', run.status === 'running');

  updateReasoning(run, card);

  const content = run.content ?? '';
  if (content !== card.shown.content) {
    card.content.innerHTML = content ? markdown(content) : '';
    card.shown.content = content;
  }
  card.content.hidden = content === '' && run.status !== 'running';
  card.el.classList.toggle('is-waiting', run.status === 'running' && content === '' && !(run.thinking ?? '').trim());

  if (run.findings !== card.shown.findings) {
    renderFindings(run, card);
    card.shown.findings = run.findings;
  }

  const error = run.status === 'error' ? `<span class="run-error-icon" aria-hidden="true">✕</span> ${escapeHtml(run.error || 'The request failed.')}` : '';
  card.shown.error = setSection(card.error, error, card.shown.error);
  card.shown.actions = setSection(card.actions, renderActions(run.actions), card.shown.actions);
  const stats = run.status === 'done' && run.stats ? renderStats(run.stats) : '';
  card.shown.stats = setSection(card.stats, stats, card.shown.stats);
}

/**
 * The follow-up input sits on every finished run that is the latest of its conversation:
 * once a follow-up answers a run (running or done), the input moves to that follow-up.
 */
function updateFollowups(): void {
  const answered = new Set<string>();
  for (const run of runs.values()) {
    if (run.parentId && (run.status === 'running' || run.status === 'done')) answered.add(run.parentId);
  }
  for (const [id, card] of cards) {
    const run = runs.get(id);
    const show = run !== undefined && run.status === 'done' && !answered.has(id);
    if (card.followup.hidden === show) card.followup.hidden = !show;
  }
}

function syncStructure(): void {
  for (const [id, card] of cards) {
    if (!runs.has(id)) {
      card.el.remove();
      cards.delete(id);
    }
  }
  let prev: Element | null = null;
  for (const run of runs.values()) {
    let card = cards.get(run.id);
    if (!card) {
      card = createCard(run);
      cards.set(run.id, card);
      dirty.add(run.id);
    }
    const expected: Element | null = prev ? prev.nextElementSibling : listEl.firstElementChild;
    if (expected !== card.el) listEl.insertBefore(card.el, expected);
    prev = card.el;
  }
  emptyEl.hidden = runs.size > 0;
  clearBtn.disabled = runs.size === 0;
  structureDirty = false;
}

function nearBottom(): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_THRESHOLD_PX;
}

function flush(): void {
  if (frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  if (structureDirty) syncStructure();
  for (const id of dirty) {
    const run = runs.get(id);
    const card = cards.get(id);
    if (!run || !card) continue;
    try {
      updateCard(run, card);
    } catch (err) {
      console.error('[Local Copilot] could not render run', id, err); // one malformed run must not break the others
    }
  }
  dirty.clear();
  updateFollowups();
  const reveal = revealId ? cards.get(revealId) : undefined;
  revealId = null;
  if (reveal) {
    reveal.el.scrollIntoView({ block: 'start' });
    stickToBottom = nearBottom();
  } else if (stickToBottom) {
    scroller.scrollTop = scroller.scrollHeight;
  }
}

function scheduleFlush(): void {
  if (!frame) frame = requestAnimationFrame(() => {
    frame = 0;
    flush();
  });
}

// ---------------------------------------------------------------------------------------
// Persistence

function persist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = 0;
  }
  const kept = [...runs.values()].slice(-MAX_SAVED_RUNS);
  const ids = new Set(kept.map((r) => r.id));
  const expanded = [...expandedFindings].filter((k) => ids.has(k.slice(0, k.indexOf('::'))));
  const state: SavedState = { v: 1, runs: kept, draft: askInput.value, expanded };
  try {
    vscode.setState(state);
  } catch {
    // State is a convenience; never break the panel over it.
  }
}

/** Structural changes are saved at once, streamed text at most every 500 ms. */
function schedulePersist(immediate = false): void {
  if (immediate) persist();
  else if (!persistTimer) persistTimer = window.setTimeout(persist, 500);
}

function normalizeRun(raw: unknown): RunState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<RunState>;
  if (typeof r.id !== 'string' || r.id === '') return null;
  const status: RunStatus = r.status === 'running' || r.status === 'error' || r.status === 'cancelled' ? r.status : 'done';
  return {
    ...r,
    id: r.id,
    task: (typeof r.task === 'string' ? r.task : 'explain') as TaskKind,
    title: typeof r.title === 'string' ? r.title : '',
    status,
    content: typeof r.content === 'string' ? r.content : '',
    thinking: typeof r.thinking === 'string' ? r.thinking : undefined,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
  };
}

function restoreState(): void {
  let saved: Partial<SavedState> | undefined;
  try {
    saved = vscode.getState() as Partial<SavedState> | undefined;
  } catch {
    saved = undefined;
  }
  if (!saved || typeof saved !== 'object') return;
  if (Array.isArray(saved.runs)) {
    for (const raw of saved.runs) {
      const run = normalizeRun(raw);
      if (run) runs.set(run.id, run);
    }
  }
  if (Array.isArray(saved.expanded)) for (const k of saved.expanded) if (typeof k === 'string') expandedFindings.add(k);
  if (typeof saved.draft === 'string') askInput.value = saved.draft;
}

// ---------------------------------------------------------------------------------------
// Host messages

function resetCards(): void {
  for (const card of cards.values()) card.el.remove();
  cards.clear();
  dirty.clear();
  structureDirty = true;
}

function handleInit(list: unknown): void {
  const incoming = (Array.isArray(list) ? list : [])
    .map(normalizeRun)
    .filter((r): r is RunState => r !== null)
    .sort((a, b) => a.createdAt - b.createdAt);
  if (incoming.length === 0 && !initReceived && runs.size > 0) {
    // The host starts empty (e.g. after a window reload) but this view restored its
    // previous runs from setState: keep them; nothing will stream into them any more.
    for (const run of runs.values()) {
      if (run.status === 'running') {
        run.status = 'cancelled';
        dirty.add(run.id);
      }
    }
  } else {
    runs.clear();
    for (const run of incoming) runs.set(run.id, run);
    resetCards();
  }
  initReceived = true;
  stickToBottom = true;
  schedulePersist(true);
  flush();
}

function removeRun(id: string): void {
  if (!runs.delete(id)) return;
  for (const k of [...expandedFindings]) if (k.startsWith(`${id}::`)) expandedFindings.delete(k);
  structureDirty = true;
  schedulePersist(true);
  scheduleFlush();
}

function focusRun(id: string): void {
  if (structureDirty || dirty.size > 0) flush();
  const card = cards.get(id);
  if (!card) return;
  card.el.scrollIntoView({ block: 'start' });
  stickToBottom = nearBottom();
  card.el.focus({ preventScroll: true });
  card.el.classList.remove('flash');
  void card.el.offsetWidth; // restart the highlight animation
  card.el.classList.add('flash');
  window.setTimeout(() => card.el.classList.remove('flash'), 1600);
}

function onMessage(msg: PanelInbound): void {
  switch (msg.type) {
    case 'init':
      handleInit(msg.runs);
      break;
    case 'runStarted': {
      const run = normalizeRun(msg.run);
      if (!run) break;
      const old = cards.get(run.id);
      if (old) {
        old.el.remove();
        cards.delete(run.id);
      }
      runs.delete(run.id); // re-inserted last: newest at the bottom
      runs.set(run.id, run);
      structureDirty = true;
      revealId = run.id;
      schedulePersist(true);
      scheduleFlush();
      break;
    }
    case 'runDelta': {
      const run = runs.get(msg.id);
      if (!run) break;
      if (typeof msg.content === 'string' && msg.content) run.content = (run.content ?? '') + msg.content;
      if (typeof msg.thinking === 'string' && msg.thinking) run.thinking = (run.thinking ?? '') + msg.thinking;
      dirty.add(run.id);
      schedulePersist();
      scheduleFlush();
      break;
    }
    case 'runUpdate': {
      const run = runs.get(msg.id);
      if (!run || !msg.patch || typeof msg.patch !== 'object') break;
      const previous = run.status;
      Object.assign(run, msg.patch);
      run.id = msg.id;
      if (!isStatus(run.status)) run.status = previous;
      if (typeof run.content !== 'string') run.content = '';
      dirty.add(run.id);
      schedulePersist(msg.patch.status !== undefined);
      scheduleFlush();
      break;
    }
    case 'runRemoved':
      removeRun(msg.id);
      break;
    case 'focusRun':
      focusRun(msg.id);
      break;
    case 'clear':
      runs.clear();
      expandedFindings.clear();
      resetCards();
      stickToBottom = true;
      schedulePersist(true);
      flush();
      break;
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as PanelInbound | undefined;
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  try {
    onMessage(msg);
  } catch (err) {
    console.error('[Local Copilot] panel message failed', msg.type, err);
  }
});

// ---------------------------------------------------------------------------------------
// User interaction (event delegation: CSP forbids inline handlers)

function intAttr(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function openFileRef(el: HTMLElement): void {
  const path = el.dataset.path;
  if (!path) return;
  const line = intAttr(el.dataset.line);
  const endLine = intAttr(el.dataset.end);
  post({ type: 'open', path, ...(line !== undefined ? { line } : {}), ...(endLine !== undefined ? { endLine } : {}) });
}

function codeOf(button: HTMLElement): string {
  return button.closest('.code-wrap')?.querySelector('pre.code-block code')?.textContent ?? '';
}

function flashLabel(button: HTMLElement, text: string): void {
  const original = button.dataset.label ?? button.textContent ?? '';
  button.dataset.label = original;
  button.textContent = text;
  window.setTimeout(() => {
    if (button.isConnected) button.textContent = original;
  }, 1200);
}

function toggleFinding(item: HTMLElement, runId: string): void {
  const findingId = item.dataset.findingId;
  if (findingId === undefined) return;
  const key = findingKey(runId, findingId);
  const open = !expandedFindings.has(key);
  if (open) expandedFindings.add(key);
  else expandedFindings.delete(key);
  item.classList.toggle('is-open', open);
  item.querySelector('.finding-toggle')?.setAttribute('aria-expanded', String(open));
  const body = item.querySelector<HTMLElement>('.finding-body');
  if (body) {
    if (open && body.dataset.rendered !== '1') {
      const finding = objects<FindingView>(runs.get(runId)?.findings).find((f) => String(f.id) === findingId);
      body.innerHTML = finding ? renderFindingBody(finding) : '';
      body.dataset.rendered = '1';
    }
    body.hidden = !open;
  }
  schedulePersist();
}

function onAction(el: HTMLElement): void {
  const runId = el.closest<HTMLElement>('.run')?.dataset.runId;
  switch (el.dataset.act) {
    case 'stop':
      if (runId) post({ type: 'cancel', runId });
      break;
    case 'remove':
      if (runId) {
        post({ type: 'remove', runId });
        removeRun(runId); // optimistic: the host's runRemoved is then a no-op
      }
      break;
    case 'action': {
      const actionId = el.dataset.actionId;
      if (runId && actionId !== undefined) post({ type: 'action', runId, actionId });
      break;
    }
    case 'fix-finding': {
      const findingId = el.closest<HTMLElement>('.finding')?.dataset.findingId;
      if (runId && findingId !== undefined) post({ type: 'fixFinding', runId, findingId });
      break;
    }
    case 'toggle-finding': {
      const item = el.closest<HTMLElement>('.finding');
      if (runId && item) toggleFinding(item, runId);
      break;
    }
    case 'copy-code':
      post({ type: 'copy', text: codeOf(el) });
      flashLabel(el, 'Copied ✓');
      break;
    case 'insert-code':
      post({ type: 'insertCode', code: codeOf(el) });
      flashLabel(el, 'Inserted ✓');
      break;
    case 'clear-all':
      post({ type: 'clearAll' });
      break;
  }
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const ref = target.closest<HTMLElement>('a.file-ref');
  if (ref) {
    event.preventDefault();
    openFileRef(ref);
    return;
  }
  if (target.closest('a')) event.preventDefault(); // nothing else may navigate
  const actionEl = target.closest<HTMLElement>('[data-act]');
  if (actionEl && !(actionEl instanceof HTMLButtonElement && actionEl.disabled)) onAction(actionEl);
});

document.addEventListener('auxclick', (event) => {
  if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();
});

function autosize(input: HTMLTextAreaElement): void {
  // An empty box keeps its one-row CSS height: measuring it would count the (wrapped) placeholder.
  if (input.value === '') {
    input.style.height = '';
    input.style.overflowY = '';
    return;
  }
  input.style.height = 'auto';
  const wanted = input.scrollHeight + 2;
  input.style.height = `${Math.min(wanted, 160)}px`;
  input.style.overflowY = wanted > 160 ? 'auto' : '';
}

window.addEventListener('resize', () => autosize(askInput));

document.addEventListener('keydown', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement) || event.key !== 'Enter') return;
  if (event.shiftKey || event.isComposing || event.keyCode === 229) return; // newline / IME
  event.preventDefault();
  target.form?.requestSubmit();
});

document.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const input = form.querySelector('textarea');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (form === askForm) {
    post({ type: 'ask', text });
  } else {
    const runId = form.closest<HTMLElement>('.run')?.dataset.runId;
    if (!runId) return;
    post({ type: 'followUp', runId, text });
  }
  input.value = '';
  autosize(input);
  schedulePersist();
});

document.addEventListener('input', (event) => {
  if (event.target instanceof HTMLTextAreaElement) autosize(event.target);
  if (event.target === askInput) schedulePersist();
});

scroller.addEventListener(
  'scroll',
  () => {
    stickToBottom = nearBottom();
  },
  { passive: true },
);
scroller.addEventListener(
  'wheel',
  (event) => {
    if (event.deltaY < 0) stickToBottom = false; // reading back up: stop following the stream
  },
  { passive: true },
);

// ---------------------------------------------------------------------------------------
// Start

restoreState();
flush();
autosize(askInput);
scroller.scrollTop = scroller.scrollHeight;
post({ type: 'ready' });
