// Dashboard webview: privacy status, models, recommendations, memory, index, local metrics
// and quick settings.
//
// The host sends the full DashboardState on every change. Each section is rendered to an
// HTML string and only sections whose HTML changed are replaced; focus (and an edit in
// progress), open <details> and the scroll position survive a re-render. Every string that
// comes from the state is escaped: model names, errors and server text are untrusted.

import type { DashboardInbound, DashboardOutbound, DashboardState, ModelView, QuickSettingKey, RecommendationView, Role, RoleView } from './protocol';
import { escapeHtml } from './markdown';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };

const vscode = acquireVsCodeApi();

function post(msg: DashboardOutbound): void {
  vscode.postMessage(msg);
}

// ---------------------------------------------------------------------------------------
// Formatting

const esc = (value: unknown): string => escapeHtml(value == null ? '' : String(value));

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Own-property lookup: keys come from the host and are never trusted as map keys. */
function own<T>(map: Record<string, T>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Array entries that are objects (a malformed entry must not break a whole section). */
function objects<T>(list: unknown): T[] {
  return Array.isArray(list) ? (list.filter((x) => x !== null && typeof x === 'object') as T[]) : [];
}

function strings(list: unknown): unknown[] {
  return Array.isArray(list) ? list.filter((x) => x != null && x !== '') : [];
}

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function count(v: number | undefined): string {
  return isNum(v) ? integer.format(v) : '—';
}

function plural(v: number | undefined, word: string): string {
  return `${count(v)} ${word}${v === 1 ? '' : 's'}`;
}

function gb(v: number | undefined): string {
  return isNum(v) ? `${v.toFixed(1)} GB` : '—';
}

function ms(v: number | undefined): string {
  if (!isNum(v)) return '—';
  return v < 10_000 ? `${integer.format(Math.round(v))} ms` : `${(v / 1000).toFixed(1)} s`;
}

function percent(rate: number | undefined): string {
  return isNum(rate) ? `${Math.round(rate * 100)}%` : '—';
}

function tps(v: number | undefined): string {
  return isNum(v) ? `${integer.format(Math.round(v))} tok/s` : '—';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function clockTime(ts: number): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatUntil(until: string): string {
  const t = Date.parse(until);
  if (!Number.isFinite(t)) return until;
  const diff = t - Date.now();
  if (diff > 30 * 86_400_000) return 'kept loaded';
  if (diff <= 0) return 'unloading';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'unloads in < 1 min';
  if (minutes < 90) return `unloads in ${minutes} min`;
  const d = new Date(t);
  return `unloads at ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return endpoint;
  }
}

function progressBar(value: number | undefined, label: string): string {
  if (!isNum(value)) {
    return `<div class="progress indeterminate" role="progressbar" aria-label="${esc(label)}"><div class="progress-fill"></div></div>`;
  }
  const p = Math.max(0, Math.min(100, value));
  return (
    `<div class="progress" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p)}">` +
    `<div class="progress-fill" style="width:${p.toFixed(1)}%"></div></div>`
  );
}

function callout(kind: 'warning' | 'error' | 'info', html: string): string {
  const icon = kind === 'error' ? '✕' : kind === 'warning' ? '⚠' : 'ⓘ';
  return `<div class="callout callout-${kind}"><span class="callout-icon" aria-hidden="true">${icon}</span><div>${html}</div></div>`;
}

// ---------------------------------------------------------------------------------------
// UI state that is not part of DashboardState

const ROLES: { role: Role; label: string; hint: string }[] = [
  { role: 'autocomplete', label: 'Autocomplete', hint: 'fast, fill-in-the-middle' },
  { role: 'chat', label: 'Code intelligence', hint: 'explain, review, security, tests, refactor' },
  { role: 'embeddings', label: 'Embeddings', hint: 'semantic codebase search' },
];

const ROLE_SHORT: Record<Role, string> = { autocomplete: 'autocomplete', chat: 'code intelligence', embeddings: 'embeddings' };

function isRole(v: unknown): v is Role {
  return v === 'autocomplete' || v === 'chat' || v === 'embeddings';
}

let state: DashboardState | null = null;
const testResults: Partial<Record<Role, { ok: boolean; message: string }>> = {};
const testing = new Map<Role, number>();
/** Pull clicked, not yet visible in state.pulls. */
const pendingPulls = new Map<string, number>();
const detailsOpen = new Map<string, boolean>();
const lastHtml = new Map<string, string>();

function isOpen(key: string, fallback: boolean): boolean {
  return detailsOpen.get(key) ?? fallback;
}

// ---------------------------------------------------------------------------------------
// Sections

const BIND_LABELS: Record<string, string> = {
  loopback: 'loopback only',
  'all-interfaces': 'all network interfaces',
  network: 'a network address',
  unknown: 'unknown',
};

function renderPrivacy(s: DashboardState): string {
  // The most important card: render whatever is known rather than an error.
  const c = s.connection ?? { provider: '', endpoint: '', reachable: false, localOnly: { ok: false, detail: 'No connection information yet.' } };
  const host = hostOf(String(c.endpoint ?? ''));
  const lo = c.localOnly ?? { ok: false, detail: '' };
  const status = lo.ok
    ? `<div class="privacy-status ok"><span class="privacy-icon" aria-hidden="true">🔒</span><div>` +
      `<div class="privacy-title">Local only — ${esc(host)}</div>` +
      `${lo.detail && lo.detail !== host ? `<div class="muted">${esc(lo.detail)}</div>` : ''}</div></div>`
    : `<div class="privacy-status bad" role="alert"><span class="privacy-icon" aria-hidden="true">⛔</span><div>` +
      `<div class="privacy-kicker">Requests refused</div>` +
      `<div class="privacy-title">${esc(lo.detail || 'The endpoint is not a loopback address.')}</div></div></div>`;

  const reach = c.reachable
    ? '<span class="dot dot-ok" aria-hidden="true"></span>Reachable'
    : `<span class="dot dot-bad" aria-hidden="true"></span>Unreachable${c.error ? ` — <span class="error-text">${esc(c.error)}</span>` : ''}`;
  const e = s.exposure ?? { bind: 'unknown', bindValue: '', warnings: [] };
  const exposed = e.bind === 'all-interfaces' || e.bind === 'network';
  const bind = `<span class="${exposed ? 'warn-text' : ''}">${esc(own(BIND_LABELS, e.bind) ?? e.bind)}</span> · <code>${esc(e.bindValue)}</code>`;
  const cloud =
    e.cloudDisabled === true
      ? '<span class="ok-text">yes ✓</span>'
      : e.cloudDisabled === false
        ? '<span class="warn-text">no</span>'
        : '<span class="muted">unknown</span>';

  const warnings = strings(e.warnings).map((w) => callout('warning', esc(w))).join('');
  return (
    `<h2>Privacy &amp; connection</h2>${status}` +
    '<dl class="kv">' +
    `<dt>Provider</dt><dd>${esc(c.provider)}</dd>` +
    `<dt>Endpoint</dt><dd><code>${esc(c.endpoint)}</code></dd>` +
    `<dt>Server version</dt><dd>${c.version ? esc(c.version) : '<span class="muted">—</span>'}</dd>` +
    `<dt>Server</dt><dd>${reach}</dd>` +
    `<dt>Server bind</dt><dd>${bind}</dd>` +
    `<dt>Cloud disabled</dt><dd>${cloud}</dd>` +
    '</dl>' +
    warnings +
    '<div class="card-actions">' +
    '<button type="button" class="btn btn-primary" data-act="verify" data-key="verify">Verify local-only</button>' +
    '<button type="button" class="btn btn-secondary" data-act="refresh" data-key="refresh">Refresh</button>' +
    '<button type="button" class="btn btn-secondary" data-act="logs" data-key="logs">Logs</button>' +
    '</div>'
  );
}

/** undefined when the server did not report capabilities. */
function suits(m: ModelView, role: Role): boolean | undefined {
  const caps = strings(m.capabilities).map((c) => String(c).toLowerCase());
  if (caps.length === 0) return undefined;
  const embedding = caps.includes('embedding');
  if (role === 'embeddings') return embedding;
  if (role === 'autocomplete') return !embedding && (caps.includes('insert') || caps.includes('completion'));
  return !embedding && caps.includes('completion');
}

function modelOptions(role: Role, current: string, installed: ModelView[]): string {
  const local = installed.filter((m) => !m.remote);
  const option = (m: ModelView): string =>
    `<option value="${esc(m.name)}"${m.name === current ? ' selected' : ''}>${esc(m.name)}${m.parameterSize ? ` · ${esc(m.parameterSize)}` : ''}</option>`;
  let html = '';
  if (!local.some((m) => m.name === current)) {
    const remote = installed.some((m) => m.name === current && m.remote);
    const note = !current ? '' : remote ? ' (cloud — refused)' : ' (not installed)';
    html += `<option value="${esc(current)}" selected disabled>${esc(current || 'Choose a model…')}${note}</option>`;
  }
  const fit = local.filter((m) => suits(m, role) !== false);
  const other = local.filter((m) => suits(m, role) === false);
  if (fit.length > 0 && other.length > 0) {
    html += `<optgroup label="Suited to ${esc(ROLE_SHORT[role])}">${fit.map(option).join('')}</optgroup>`;
    html += `<optgroup label="Other installed models">${other.map(option).join('')}</optgroup>`;
  } else {
    html += local.map(option).join('');
  }
  if (local.length === 0) html += '<option disabled>No local model installed</option>';
  return html;
}

const FIM_CLASS: Record<string, string> = { good: 'chip-ok', possible: 'chip-warn', none: 'chip-bad' };

function renderTestResult(role: Role): string {
  if (testing.has(role)) return '<div class="test-result pending" role="status"><span class="spinner" aria-hidden="true"></span> Testing…</div>';
  const r = testResults[role];
  if (!r) return '';
  return `<div class="test-result ${r.ok ? 'ok' : 'error'}" role="status">${r.ok ? '✓' : '✕'} ${esc(r.message)}</div>`;
}

function renderRole(info: (typeof ROLES)[number], view: RoleView | undefined, installed: ModelView[]): string {
  const current = view?.model ?? '';
  const id = `role-${info.role}`;
  const chips: string[] = [];
  if (current) chips.push(view?.installed ? '<span class="chip chip-ok">installed</span>' : '<span class="chip chip-warn">not installed</span>');
  if (info.role === 'autocomplete' && view?.fimSupport) {
    chips.push(`<span class="chip ${own(FIM_CLASS, view.fimSupport) ?? ''}" title="Fill-in-the-middle support">FIM: ${esc(view.fimSupport)}</span>`);
  }
  const notes: string[] = [];
  if (view?.warning) notes.push(callout('warning', esc(view.warning)));
  else if (info.role === 'autocomplete' && view?.fimSupport === 'none') {
    notes.push(
      callout(
        'warning',
        'This model has no fill-in-the-middle support. Chat / instruct models make poor autocomplete: they tend to explain or repeat code instead of completing it. Prefer a <strong>base</strong> code model such as <code>qwen2.5-coder:3b-base</code>.',
      ),
    );
  }
  if (view && current && !view.installed) notes.push(callout('info', 'Not installed on the server: pull it below or pick an installed model.'));
  const busy = testing.has(info.role);
  return (
    '<div class="role-row">' +
    `<div class="role-info"><div class="role-name">${info.label}</div><div class="muted small">${info.hint}</div></div>` +
    `<div class="role-model"><code>${esc(current || 'not set')}</code>${chips.join('')}</div>` +
    '<div class="role-controls">' +
    `<label class="visually-hidden" for="${id}">Model for ${info.label}</label>` +
    `<select id="${id}" data-key="${id}" data-role-select="${info.role}">${modelOptions(info.role, current, installed)}</select>` +
    `<button type="button" class="btn btn-secondary" data-act="test" data-role="${info.role}" data-key="test-${info.role}"${busy ? ' disabled' : ''}>Test</button>` +
    '</div>' +
    notes.join('') +
    renderTestResult(info.role) +
    '</div>'
  );
}

function renderInstalled(models: ModelView[]): string {
  if (models.length === 0) return '<p class="muted">No model is installed on the server yet: pull one of the recommendations below.</p>';
  const rows = models
    .map((m) => {
      const caps = strings(m.capabilities).map((c) => `<span class="chip">${esc(c)}</span>`).join('') || '<span class="muted">—</span>';
      const roles = strings(m.roles).map((r) => `<span class="chip chip-role">${esc(own(ROLE_SHORT, r) ?? r)}</span>`).join('') || '<span class="muted">—</span>';
      const badge = m.remote ? ' <span class="badge badge-danger" title="Served by a remote backend: never used">cloud — refused</span>' : '';
      return (
        `<tr${m.remote ? ' class="is-remote"' : ''}>` +
        `<td><code>${esc(m.name)}</code>${badge}</td>` +
        `<td class="num">${gb(m.sizeGB)}</td>` +
        `<td>${esc(m.parameterSize ?? '—')}</td>` +
        `<td>${esc(m.quantization ?? '—')}</td>` +
        `<td>${caps}</td>` +
        `<td>${roles}</td>` +
        '</tr>'
      );
    })
    .join('');
  return (
    `<details class="section-details" data-key="installed"${isOpen('installed', true) ? ' open' : ''}>` +
    `<summary>Installed models (${models.length})</summary>` +
    '<div class="table-wrap"><table class="data-table"><thead><tr>' +
    '<th>Name</th><th class="num">Size</th><th>Params</th><th>Quant</th><th>Capabilities</th><th>Roles</th>' +
    `</tr></thead><tbody>${rows}</tbody></table></div></details>`
  );
}

function renderModels(s: DashboardState): string {
  const installed = objects<ModelView>(s.installed);
  let html = '<h2>Models</h2><div class="role-list">';
  for (const info of ROLES) html += renderRole(info, s.roles?.[info.role], installed);
  return `${html}</div>${renderInstalled(installed)}`;
}

type Pull = DashboardState['pulls'][number];

function activePull(pulls: Pull[], model: string): Pull | undefined {
  return pulls.find((p) => p.model === model && !p.done && !p.error);
}

function renderReco(info: (typeof ROLES)[number], r: RecommendationView | undefined, pulls: Pull[]): string {
  if (!r) return '';
  let action: string;
  if (r.installed) action = '<span class="chip chip-ok">Installed ✓</span>';
  else if (activePull(pulls, r.model) || pendingPulls.has(r.model)) action = '<button type="button" class="btn btn-secondary" disabled>Pulling…</button>';
  else {
    action =
      `<button type="button" class="btn btn-primary" data-act="pull" data-model="${esc(r.model)}" data-key="pull-${esc(r.model)}"` +
      ` title="Your local Ollama server downloads it from its registry">Pull${isNum(r.sizeGB) ? ` (${gb(r.sizeGB)})` : ''}</button>`;
  }
  return (
    '<div class="reco">' +
    `<div class="reco-role">${info.label}</div>` +
    `<div class="reco-model"><code>${esc(r.model)}</code>${isNum(r.sizeGB) ? ` <span class="muted">${gb(r.sizeGB)}</span>` : ''}</div>` +
    `<p class="reco-reason">${esc(r.reason)}</p>` +
    `<div class="reco-action">${action}</div>` +
    '</div>'
  );
}

function renderPulls(pulls: Pull[]): string {
  if (pulls.length === 0) return '';
  const items = pulls
    .map((p) => {
      const pct = isNum(p.percent) ? Math.max(0, Math.min(100, p.percent)) : undefined;
      const phase = p.error ? 'error' : p.done ? 'done' : 'active';
      const head =
        `<div class="pull-head"><code>${esc(p.model)}</code><span class="muted pull-status">${esc(p.status)}</span>` +
        (phase === 'active' && pct !== undefined ? `<span class="pull-pct">${Math.round(pct)}%</span>` : '') +
        (phase === 'active'
          ? `<button type="button" class="btn btn-secondary btn-small" data-act="cancel-pull" data-model="${esc(p.model)}" data-key="cancel-${esc(p.model)}">Cancel</button>`
          : '') +
        '</div>';
      const body =
        phase === 'active'
          ? progressBar(pct, `Downloading ${p.model}`)
          : phase === 'error'
            ? `<div class="error-text">✕ ${esc(p.error)}</div>`
            : '<div class="ok-text">✓ Pulled</div>';
      return `<li class="pull pull-${phase}">${head}${body}</li>`;
    })
    .join('');
  return `<h3>Downloads</h3><ul class="pull-list">${items}</ul>`;
}

function renderRecommendations(s: DashboardState): string {
  const pulls = objects<Pull>(s.pulls);
  let html = '<h2>Recommended for this machine</h2>';
  const hw = s.hardware;
  if (hw) {
    html += `<p class="hardware">${esc(hw.summary)}</p>`;
    const gpus = objects<{ name: string; vramGB: number }>(hw.gpus).map((g) => `<li>${esc(g.name)} · ${gb(g.vramGB)} VRAM</li>`).join('') || '<li>No dedicated GPU detected</li>';
    html +=
      `<details class="section-details" data-key="hardware"${isOpen('hardware', false) ? ' open' : ''}><summary>Hardware details</summary>` +
      `<ul class="plain-list">${gpus}<li>${gb(hw.ramGB)} RAM</li>${hw.cpu ? `<li>${esc(hw.cpu)}</li>` : ''}</ul></details>`;
  }
  const reco = s.recommendation;
  if (reco) {
    html += '<div class="reco-grid">';
    for (const info of ROLES) html += renderReco(info, reco[info.role], pulls);
    html += '</div>';
    html +=
      '<p class="muted small pull-note">Pull asks your local Ollama server to download the model from its registry; ' +
      'this extension itself never contacts the network.</p>';
    const notes = strings(reco.notes);
    if (notes.length) html += `<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
  } else {
    html += '<p class="muted">No recommendation yet (hardware detection has not finished).</p>';
  }
  return html + renderPulls(pulls);
}

function renderLoaded(s: DashboardState): string {
  const loaded = objects<DashboardState['loaded'][number]>(s.loaded);
  let html = '<h2>Loaded in memory</h2>';
  if (loaded.length === 0) return `${html}<p class="muted">No model is loaded. Models load on first use and unload after their keep-alive.</p>`;
  html += '<ul class="loaded-list">';
  for (const m of loaded) {
    const size = isNum(m.sizeGB) ? m.sizeGB : 0;
    const vram = isNum(m.vramGB) ? m.vramGB : 0;
    const share = size > 0 ? Math.min(100, (vram / size) * 100) : 0;
    const partial = size > 0 && vram + 0.01 < size;
    const meta = [
      isNum(m.contextLength) ? `<span class="muted">ctx ${count(m.contextLength)}</span>` : '',
      m.until ? `<span class="muted">${esc(formatUntil(m.until))}</span>` : '',
    ].join('');
    html +=
      '<li class="loaded">' +
      `<div class="loaded-head"><code>${esc(m.name)}</code>${meta}</div>` +
      progressBar(share, `Share of ${m.name} in GPU memory`) +
      `<div class="small">${gb(vram)} GPU / ${gb(size)} total${partial ? ' · <span class="warn-text">partially on CPU</span>' : ''}</div>` +
      '</li>';
  }
  return `${html}</ul>`;
}

const INDEX_STATUS: Record<string, { label: string; tone: string }> = {
  idle: { label: 'Ready', tone: 'ok' },
  indexing: { label: 'Indexing…', tone: 'busy' },
  embedding: { label: 'Computing embeddings…', tone: 'busy' },
  disabled: { label: 'Disabled', tone: 'off' },
  error: { label: 'Error', tone: 'bad' },
};

function renderIndex(s: DashboardState): string {
  const ix = s.index;
  const status = !ix.enabled ? INDEX_STATUS.disabled : (own(INDEX_STATUS, ix.status) ?? { label: String(ix.status), tone: 'off' });
  const dot = status.tone === 'busy' ? '<span class="spinner" aria-hidden="true"></span>' : `<span class="dot dot-${status.tone}" aria-hidden="true"></span>`;
  let html =
    '<h2>Codebase index</h2>' +
    `<div class="index-status">${dot}<strong>${esc(status.label)}</strong></div>` +
    '<div class="stat-row">' +
    `<div class="stat"><div class="stat-value">${count(ix.files)}</div><div class="stat-label">files</div></div>` +
    `<div class="stat"><div class="stat-value">${count(ix.symbols)}</div><div class="stat-label">symbols</div></div>` +
    `<div class="stat"><div class="stat-value">${count(ix.chunks)}</div><div class="stat-label">chunks</div></div>` +
    '</div>';
  if (!s.settings.embeddingsEnabled) {
    html += '<p class="muted small">Embeddings are off: codebase questions use keyword and symbol search only.</p>';
  } else if (isNum(ix.chunks) && ix.chunks > 0) {
    const share = Math.min(100, (ix.embedded / ix.chunks) * 100);
    html +=
      '<div class="embed-progress">' +
      `<div class="small">Embeddings: ${count(ix.embedded)} / ${count(ix.chunks)} chunks (${Math.floor(share)}%)</div>` +
      `${progressBar(share, 'Embedded chunks')}</div>`;
  }
  if (ix.message) html += `<p class="${ix.status === 'error' ? 'error-text' : 'muted'} small">${esc(ix.message)}</p>`;
  html +=
    '<div class="card-actions">' +
    `<button type="button" class="btn btn-secondary" data-act="rebuild-index" data-key="rebuild-index"${ix.enabled ? '' : ' disabled title="The index is disabled in the settings"'}>Rebuild index</button>` +
    '</div>';
  return html;
}

function tile(label: string, value: string, sub: string): string {
  return `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div><div class="tile-sub">${sub}</div></div>`;
}

const OUTCOME_CLASS: Record<string, string> = { ok: 'chip-ok', cached: 'chip-info', empty: '', cancelled: 'chip-warn', error: 'chip-bad' };

function renderPerformance(s: DashboardState): string {
  const { inline, chat, embeddings, recent } = s.metrics;
  const acceptance = isNum(inline.acceptanceRate) ? inline.acceptanceRate : inline.shown > 0 ? inline.accepted / inline.shown : undefined;
  const tiles =
    tile('Inline latency', `p50 ${ms(inline.p50Ms)}`, `p95 ${ms(inline.p95Ms)}`) +
    tile('Acceptance', percent(acceptance), `${count(inline.accepted)} accepted / ${count(inline.shown)} shown`) +
    tile('Cache hits', count(inline.cacheHits), `of ${count(inline.requests)} inline requests`) +
    tile('Inline speed', tps(inline.avgTokensPerSecond), 'average generation') +
    tile('Errors / cancelled', `${count(inline.errors)} / ${count(inline.cancelled)}`, 'inline requests') +
    tile('Chat latency', `p50 ${ms(chat.p50Ms)}`, `first token ${ms(chat.avgFirstTokenMs)} avg`) +
    tile('Chat speed', tps(chat.avgTokensPerSecond), `${plural(chat.requests, 'request')} · ${plural(chat.errors, 'error')}`) +
    tile('Embeddings', plural(embeddings.vectors, 'vector'), `${plural(embeddings.requests, 'request')} · ${plural(embeddings.errors, 'error')}`);

  const rows = objects<DashboardState['metrics']['recent'][number]>(recent)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 15)
    .map(
      (r) =>
        '<tr>' +
        `<td class="mono">${clockTime(r.ts)}</td>` +
        `<td>${esc(r.kind)}</td>` +
        `<td><code>${esc(r.model)}</code></td>` +
        `<td class="num">${isNum(r.ms) ? integer.format(Math.round(r.ms)) : '—'}</td>` +
        `<td class="num">${isNum(r.tokens) ? integer.format(r.tokens) : '—'}</td>` +
        `<td class="num">${isNum(r.tps) ? integer.format(Math.round(r.tps)) : '—'}</td>` +
        `<td><span class="chip ${own(OUTCOME_CLASS, r.outcome) ?? ''}">${esc(r.outcome)}</span></td>` +
        '</tr>',
    )
    .join('');
  const table = rows
    ? `<details class="section-details" data-key="recent"${isOpen('recent', true) ? ' open' : ''}><summary>Recent requests</summary>` +
      '<div class="table-wrap"><table class="data-table compact"><thead><tr>' +
      '<th>Time</th><th>Kind</th><th>Model</th><th class="num">ms</th><th class="num">Tokens</th><th class="num">tok/s</th><th>Outcome</th>' +
      `</tr></thead><tbody>${rows}</tbody></table></div></details>`
    : '<p class="muted">No request recorded yet.</p>';
  return (
    '<h2>Performance <span class="h-note">stored locally, never sent</span></h2>' +
    `<div class="tiles">${tiles}</div>${table}` +
    '<div class="card-actions"><button type="button" class="btn btn-secondary" data-act="clear-metrics" data-key="clear-metrics">Clear metrics</button></div>'
  );
}

const MULTILINE_OPTIONS: { value: DashboardState['settings']['multiline']; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Multi-line after a block opener, an empty line or a comment; single line in the middle of a statement.' },
  { value: 'always', label: 'Always', hint: 'Always ask for multi-line completions (slower, more to review).' },
  { value: 'never', label: 'Never', hint: 'Single-line completions only (fastest).' },
];

const REASONING_OPTIONS: { value: DashboardState['settings']['reasoning']; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Never ask thinking models to reason first (fastest).' },
  { value: 'deep', label: 'Deep tasks', hint: 'Reason only for security review, code review, fix and codebase questions.' },
  { value: 'always', label: 'Always', hint: 'Reason for every task (slowest).' },
];

const SELECT_HINTS: Record<string, { value: string; hint: string }[]> = { multiline: MULTILINE_OPTIONS, reasoning: REASONING_OPTIONS };

function settingToggle(key: QuickSettingKey, label: string, hint: string, checked: boolean): string {
  return (
    '<div class="setting">' +
    `<label class="switch"><input type="checkbox" role="switch" data-setting="${key}" data-key="set-${key}"${checked ? ' checked' : ''}>` +
    `<span class="switch-track" aria-hidden="true"></span><span class="setting-label">${label}</span></label>` +
    `<p class="setting-hint muted">${hint}</p>` +
    '</div>'
  );
}

function settingSelect(key: QuickSettingKey, label: string, options: { value: string; label: string; hint: string }[], value: string): string {
  const current = options.find((o) => o.value === value);
  return (
    '<div class="setting">' +
    `<label class="setting-label" for="set-${key}">${label}</label>` +
    `<select id="set-${key}" data-setting="${key}" data-key="set-${key}">` +
    options.map((o) => `<option value="${o.value}"${o.value === value ? ' selected' : ''}>${o.label}</option>`).join('') +
    '</select>' +
    `<p class="setting-hint muted" data-hint-for="${key}">${current ? current.hint : ''}</p>` +
    '</div>'
  );
}

function renderSettings(s: DashboardState): string {
  const st = s.settings;
  return (
    '<h2>Quick settings</h2>' +
    settingToggle('autocompleteEnabled', 'Inline completion', 'Ghost-text suggestions while you type.', st.autocompleteEnabled) +
    settingToggle('embeddingsEnabled', 'Semantic search', 'Compute local embeddings in the background for codebase questions.', st.embeddingsEnabled) +
    settingToggle(
      'securityLlmReview',
      'AI security review',
      'After the static rules, ask the local model to confirm findings and look for more. Off: static rules only (instant).',
      st.securityLlmReview,
    ) +
    settingSelect('multiline', 'Multi-line completions', MULTILINE_OPTIONS, st.multiline) +
    settingSelect('reasoning', 'Reasoning', REASONING_OPTIONS, st.reasoning) +
    '<div class="setting">' +
    '<label class="setting-label" for="set-debounceMs">Debounce</label>' +
    '<div class="setting-inline">' +
    `<input type="number" id="set-debounceMs" data-setting="debounceMs" data-key="set-debounceMs" min="0" max="2000" step="10" value="${isNum(st.debounceMs) ? Math.round(st.debounceMs) : 0}">` +
    '<span class="muted">ms</span></div>' +
    '<p class="setting-hint muted">Pause after the last keystroke before asking the model (0–2000).</p>' +
    '</div>' +
    '<div class="card-actions"><button type="button" class="btn btn-secondary" data-act="open-settings" data-key="open-settings">All settings…</button></div>'
  );
}

const SECTIONS: { id: string; title: string; render: (s: DashboardState) => string }[] = [
  { id: 'sec-privacy', title: 'Privacy &amp; connection', render: renderPrivacy },
  { id: 'sec-settings', title: 'Quick settings', render: renderSettings },
  { id: 'sec-models', title: 'Models', render: renderModels },
  { id: 'sec-reco', title: 'Recommended for this machine', render: renderRecommendations },
  { id: 'sec-loaded', title: 'Loaded in memory', render: renderLoaded },
  { id: 'sec-index', title: 'Codebase index', render: renderIndex },
  { id: 'sec-perf', title: 'Performance', render: renderPerformance },
];

// ---------------------------------------------------------------------------------------
// Shell and rendering

const root = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
root.innerHTML =
  '<div class="dash">' +
  '<header class="dash-header"><h1>Local Copilot</h1>' +
  '<p class="muted">Models, privacy and performance. Nothing on this page leaves your machine.</p></header>' +
  '<div class="toasts" id="toasts"></div>' +
  '<p class="dash-loading muted" id="loading">Loading…</p>' +
  '<div class="dash-grid" id="grid" hidden>' +
  '<section class="card" id="sec-privacy"></section>' +
  '<section class="card" id="sec-settings"></section>' +
  '<section class="card card-wide" id="sec-models"></section>' +
  '<section class="card card-wide" id="sec-reco"></section>' +
  '<section class="card" id="sec-loaded"></section>' +
  '<section class="card" id="sec-index"></section>' +
  '<section class="card card-wide" id="sec-perf"></section>' +
  '</div></div>';

const grid = document.getElementById('grid') as HTMLElement;
const loading = document.getElementById('loading') as HTMLElement;
const toasts = document.getElementById('toasts') as HTMLElement;

interface FocusSnapshot {
  key: string;
  value?: string;
  start?: number | null;
  end?: number | null;
}

function captureFocus(): FocusSnapshot | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !el.dataset.key) return null;
  const snap: FocusSnapshot = { key: el.dataset.key };
  if (el instanceof HTMLInputElement && (el.type === 'number' || el.type === 'text')) {
    snap.value = el.value;
    try {
      snap.start = el.selectionStart;
      snap.end = el.selectionEnd;
    } catch {
      // number inputs have no selection API
    }
  }
  return snap;
}

function restoreFocus(snap: FocusSnapshot | null): void {
  if (!snap) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.isConnected && active.dataset.key === snap.key) return;
  const el = document.querySelector<HTMLElement>(`[data-key="${CSS.escape(snap.key)}"]`);
  if (!el || (el instanceof HTMLButtonElement && el.disabled)) return;
  if (snap.value !== undefined && el instanceof HTMLInputElement && el.value !== snap.value) {
    el.value = snap.value; // keep an edit in progress
    try {
      if (snap.start != null && snap.end != null) el.setSelectionRange(snap.start, snap.end);
    } catch {
      // not supported for this input type
    }
  }
  el.focus({ preventScroll: true });
}

function render(): void {
  if (!state) return;
  const now = Date.now();
  for (const [model, at] of pendingPulls) {
    if (now - at > 15_000 || objects<Pull>(state.pulls).some((p) => p.model === model)) pendingPulls.delete(model);
  }
  loading.hidden = true;
  grid.hidden = false;
  const scrolling = document.scrollingElement ?? document.documentElement;
  const top = scrolling.scrollTop;
  const focus = captureFocus();
  for (const section of SECTIONS) {
    const el = document.getElementById(section.id);
    if (!el) continue;
    let html: string;
    try {
      html = section.render(state);
    } catch (err) {
      html = `<h2>${section.title}</h2>${callout('error', `This section could not be displayed: ${esc(err instanceof Error ? err.message : err)}`)}`;
    }
    if (lastHtml.get(section.id) !== html) {
      el.innerHTML = html;
      lastHtml.set(section.id, html);
    }
  }
  restoreFocus(focus);
  scrolling.scrollTop = top;
}

/** After a user change, re-render the section from the next state even if it looks unchanged. */
function invalidate(el: Element): void {
  const section = el.closest('section.card');
  if (section) lastHtml.delete(section.id);
}

function showToast(kind: 'info' | 'error', message: string): void {
  const el = document.createElement('div');
  el.className = `toast toast-${kind === 'error' ? 'error' : 'info'}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML =
    `<span class="toast-icon" aria-hidden="true">${kind === 'error' ? '✕' : 'ⓘ'}</span>` +
    `<span class="toast-message">${esc(message)}</span>` +
    '<button type="button" class="icon-btn" data-act="dismiss-toast" aria-label="Dismiss" title="Dismiss">×</button>';
  toasts.appendChild(el);
  while (toasts.children.length > 3) toasts.firstElementChild?.remove();
  window.setTimeout(() => el.remove(), 4000);
}

// ---------------------------------------------------------------------------------------
// Messages and events

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as DashboardInbound | undefined;
  if (!msg || typeof msg !== 'object') return;
  try {
    switch (msg.type) {
      case 'state':
        if (msg.state && typeof msg.state === 'object') {
          state = msg.state;
          render();
        }
        break;
      case 'testResult':
        if (!isRole(msg.role)) break;
        testing.delete(msg.role);
        testResults[msg.role] = { ok: msg.ok === true, message: String(msg.message ?? '') };
        render();
        break;
      case 'toast':
        showToast(msg.kind, String(msg.message ?? ''));
        break;
    }
  } catch (err) {
    console.error('[Local Copilot] dashboard message failed', err);
  }
});

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('a')) event.preventDefault();
  const el = target.closest<HTMLElement>('[data-act]');
  if (!el || (el instanceof HTMLButtonElement && el.disabled)) return;
  switch (el.dataset.act) {
    case 'verify':
      post({ type: 'verifyLocalOnly' });
      break;
    case 'refresh':
      post({ type: 'refresh' });
      break;
    case 'logs':
      post({ type: 'openLogs' });
      break;
    case 'test': {
      const role = el.dataset.role;
      if (!isRole(role)) break;
      const started = Date.now();
      testing.set(role, started);
      delete testResults[role];
      post({ type: 'testModel', role });
      render();
      window.setTimeout(() => {
        if (testing.get(role) !== started) return;
        testing.delete(role); // no answer: let the user try again
        render();
      }, 120_000);
      break;
    }
    case 'pull': {
      const model = el.dataset.model;
      if (!model) break;
      pendingPulls.set(model, Date.now());
      post({ type: 'pull', model });
      render();
      window.setTimeout(render, 15_500);
      break;
    }
    case 'cancel-pull': {
      const model = el.dataset.model;
      if (model) post({ type: 'cancelPull', model });
      break;
    }
    case 'rebuild-index':
      post({ type: 'rebuildIndex' });
      break;
    case 'clear-metrics':
      post({ type: 'clearMetrics' });
      break;
    case 'open-settings':
      post({ type: 'openSettings' });
      break;
    case 'dismiss-toast':
      el.closest('.toast')?.remove();
      break;
  }
});

function isSettingKey(v: unknown): v is QuickSettingKey {
  return (
    v === 'autocompleteEnabled' || v === 'multiline' || v === 'debounceMs' || v === 'reasoning' || v === 'embeddingsEnabled' || v === 'securityLlmReview'
  );
}

document.addEventListener('change', (event) => {
  const t = event.target;
  if (t instanceof HTMLSelectElement && t.dataset.roleSelect) {
    const role = t.dataset.roleSelect;
    if (isRole(role) && t.value) post({ type: 'setRole', role, model: t.value });
    invalidate(t);
    return;
  }
  if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement)) return;
  const key = t.dataset.setting;
  if (!isSettingKey(key)) return;
  if (t instanceof HTMLSelectElement) {
    post({ type: 'setSetting', key, value: t.value });
    const hint = document.querySelector(`[data-hint-for="${key}"]`);
    const option = SELECT_HINTS[key]?.find((o) => o.value === t.value);
    if (hint && option) hint.textContent = option.hint;
  } else if (t.type === 'checkbox') {
    post({ type: 'setSetting', key, value: t.checked });
  } else if (t.type === 'number') {
    const n = Math.round(Number(t.value));
    if (t.value.trim() === '' || !Number.isFinite(n)) {
      t.value = String(state?.settings.debounceMs ?? 0); // invalid: revert
      return;
    }
    const value = Math.max(0, Math.min(2000, n));
    t.value = String(value);
    post({ type: 'setSetting', key, value });
  }
  invalidate(t);
});

document.addEventListener(
  'toggle',
  (event) => {
    const t = event.target;
    if (t instanceof HTMLDetailsElement && t.dataset.key) detailsOpen.set(t.dataset.key, t.open);
  },
  true,
);

post({ type: 'ready' });
