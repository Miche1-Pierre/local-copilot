// Safe, dependency-free Markdown → HTML for the webviews.
//
// The input is untrusted model output. Every character of it is HTML-escaped before it
// reaches the output: the renderer only ever emits its own fixed tags and attributes.
// Links are rendered as inert text ("text (url)"); the only clickable element produced is
// the workspace file reference (<a class="file-ref" href="#" data-path=…>), which the panel
// turns into an "open" message for the extension host. Nothing rendered here can make the
// webview load, fetch or navigate to anything.
//
// Called on every streamed delta, so it must tolerate partial input (an unclosed fence is
// still a code block, a half-written link stays plain text) and stay fast (one linear pass
// over the lines, one scan per paragraph).

const MAX_DEPTH = 8;

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
  const str = typeof s === 'string' ? s : s == null ? '' : String(s);
  return /[&<>"']/.test(str) ? str.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c) : str;
}

export function renderMarkdown(md: string): string {
  if (typeof md !== 'string' || md.length === 0) return '';
  let src = md;
  // NUL is reserved for the inline placeholders below; CommonMark replaces it anyway.
  if (src.indexOf('\u0000') >= 0) src = src.replace(/\u0000/g, '\uFFFD');
  if (src.indexOf('\r') >= 0) src = src.replace(/\r\n?/g, '\n');
  return renderBlocks(src.split('\n'), 0, false);
}

// ---------------------------------------------------------------------------------------
// Blocks

const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
const PARTIAL_FENCE = /^[ \t]*(?:`{1,2}|~{1,2})$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const TASK = /^\[([ xX])\](?:[ \t]+|$)/;
const TABLE_SEP_CELL = /^:?-+:?$/;
const BLANK = /^[ \t]*$/;
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i;

interface BlockResult {
  html: string;
  next: number;
}

/** `tight`: paragraphs are emitted without <p> (items of a tight list). */
function renderBlocks(lines: string[], depth: number, tight: boolean): string {
  if (depth > MAX_DEPTH) return plainParagraph(lines);
  let out = '';
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (BLANK.test(line)) {
      i++;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence) {
      const r = parseFence(lines, i, fence);
      out += r.html;
      i = r.next;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out += renderHeading(heading[1].length, heading[2] ?? '');
      i++;
      continue;
    }
    if (HR.test(line)) {
      out += '<hr>';
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const r = parseQuote(lines, i, depth);
      out += r.html;
      i = r.next;
      continue;
    }
    if (isTableStart(lines, i)) {
      const r = parseTable(lines, i);
      out += r.html;
      i = r.next;
      continue;
    }
    const marker = listMarker(line);
    if (marker) {
      const r = parseList(lines, i, marker, depth);
      out += r.html;
      i = r.next;
      continue;
    }
    const start = i++;
    while (i < n && !BLANK.test(lines[i]) && !interruptsParagraph(lines, i)) i++;
    out += renderParagraph(lines, start, i, tight);
  }
  return out;
}

function plainParagraph(lines: string[]): string {
  const text = lines.join('\n').trim();
  return text ? `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>` : '';
}

function renderParagraph(lines: string[], start: number, end: number, tight: boolean): string {
  let text = '';
  for (let k = start; k < end; k++) {
    let l = lines[k].trim();
    // CommonMark hard break "foo\" — every newline is rendered as <br> anyway.
    if (k < end - 1 && l.endsWith('\\') && !l.endsWith('\\\\')) l = l.slice(0, -1);
    text += k > start ? `\n${l}` : l;
  }
  // Model output relies on single newlines being visible, so keep them as line breaks.
  const html = renderInline(text).replace(/\n/g, '<br>');
  return tight ? html : `<p>${html}</p>`;
}

function interruptsParagraph(lines: string[], i: number): boolean {
  const line = lines[i];
  if (fenceOpen(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  const mk = listMarker(line);
  // As in CommonMark: an empty item or an ordered list not starting at 1 does not interrupt.
  if (mk) return mk.content.trim() !== '' && (!mk.ordered || mk.start === 1);
  return isTableStart(lines, i);
}

function isParagraphText(line: string): boolean {
  return !BLANK.test(line) && !fenceOpen(line) && !HEADING.test(line) && !HR.test(line) && !QUOTE.test(line) && !listMarker(line);
}

function renderHeading(level: number, raw: string): string {
  const text = raw.replace(/[ \t]+$/, '').replace(/(?:^|[ \t]+)#+$/, '');
  return `<h${level}>${renderInline(text)}</h${level}>`;
}

// --- fenced code ------------------------------------------------------------------------

interface Fence {
  indent: number;
  ch: string;
  len: number;
  info: string;
}

function fenceOpen(line: string): Fence | null {
  const m = FENCE_OPEN.exec(line);
  if (!m) return null;
  const marker = m[2];
  // ```foo``` on one line is inline code, not a fence.
  if (marker[0] === '`' && m[3].indexOf('`') >= 0) return null;
  return { indent: leadingWidth(m[1]), ch: marker[0], len: marker.length, info: m[3].trim() };
}

function isFenceClose(line: string, fence: Fence): boolean {
  const m = FENCE_CLOSE.exec(line);
  return m !== null && m[1][0] === fence.ch && m[1].length >= fence.len;
}

/** First word of the info string, reduced to a safe charset ("ts", "c++", "c#", "objective-c"). */
function fenceLang(info: string): string {
  const first = info.replace(/^[{.\s]+/, '').split(/[\s:{},;]/)[0] ?? '';
  return first.replace(/[^\w+#.-]/g, '').slice(0, 32);
}

function parseFence(lines: string[], start: number, fence: Fence): BlockResult {
  const body: string[] = [];
  let i = start + 1;
  let closed = false;
  for (; i < lines.length; i++) {
    if (isFenceClose(lines[i], fence)) {
      closed = true;
      i++;
      break;
    }
    body.push(fence.indent > 0 ? stripIndent(lines[i], fence.indent) : lines[i]);
  }
  if (!closed) {
    // Still streaming: hide a half-written closing fence and trailing blank lines.
    while (body.length > 0 && (BLANK.test(body[body.length - 1]) || PARTIAL_FENCE.test(body[body.length - 1]))) body.pop();
  }
  const lang = escapeHtml(fenceLang(fence.info));
  return { html: `<pre class="code-block" data-lang="${lang}"><code>${escapeHtml(body.join('\n'))}</code></pre>`, next: i };
}

// --- blockquote -------------------------------------------------------------------------

function parseQuote(lines: string[], start: number, depth: number): BlockResult {
  const inner: string[] = [];
  let i = start;
  while (i < lines.length && QUOTE.test(lines[i])) {
    inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
    i++;
  }
  // GitHub-style alerts: > [!WARNING]
  const alert = inner.length > 0 ? ALERT.exec(inner[0]) : null;
  if (alert) {
    const kind = alert[1].toLowerCase();
    const title = kind[0].toUpperCase() + kind.slice(1);
    const body = renderBlocks(inner.slice(1), depth + 1, false);
    return { html: `<blockquote class="callout callout-${kind}"><p class="callout-title">${title}</p>${body}</blockquote>`, next: i };
  }
  return { html: `<blockquote>${renderBlocks(inner, depth + 1, false)}</blockquote>`, next: i };
}

// --- tables (GFM) -----------------------------------------------------------------------

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cell += '|';
      i += 2;
      continue;
    }
    if (c === '`') {
      // A pipe inside a code span does not split the row.
      let j = i;
      while (j < s.length && s[j] === '`') j++;
      const close = s.indexOf(s.slice(i, j), j);
      const stop = close > 0 ? close + (j - i) : j;
      cell += s.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '|') {
      cells.push(cell.trim());
      cell = '';
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  cells.push(cell.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  if (i + 1 >= lines.length || lines[i].indexOf('|') < 0) return false;
  const sep = lines[i + 1];
  if (sep.indexOf('|') < 0 || sep.indexOf('-') < 0) return false;
  for (const cell of splitRow(sep)) if (!TABLE_SEP_CELL.test(cell)) return false;
  return true;
}

function alignClass(cell: string | undefined): string {
  if (!cell) return '';
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return ' class="al-c"';
  if (right) return ' class="al-r"';
  return '';
}

function parseTable(lines: string[], start: number): BlockResult {
  const header = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map(alignClass);
  // Lenient on the column count so a table being streamed renders before its separator row is complete.
  const cols = header.length;
  let html = '<div class="table-wrap"><table><thead><tr>';
  for (let c = 0; c < cols; c++) html += `<th${aligns[c] ?? ''}>${renderInline(header[c])}</th>`;
  html += '</tr></thead>';
  let body = '';
  let i = start + 2;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (BLANK.test(l) || l.indexOf('|') < 0 || fenceOpen(l) || QUOTE.test(l) || HEADING.test(l)) break;
    const cells = splitRow(l);
    body += '<tr>';
    for (let c = 0; c < cols; c++) body += `<td${aligns[c] ?? ''}>${renderInline(cells[c] ?? '')}</td>`;
    body += '</tr>';
  }
  if (body) html += `<tbody>${body}</tbody>`;
  return { html: `${html}</table></div>`, next: i };
}

// --- lists ------------------------------------------------------------------------------

interface ListMarker {
  indent: number;
  ordered: boolean;
  start: number;
  contentOffset: number;
  content: string;
}

function listMarker(line: string): ListMarker | null {
  const m = LIST_ITEM.exec(line);
  if (!m) return null;
  const indent = leadingWidth(m[1]);
  const marker = m[2];
  const gap = m[3] ? leadingWidth(m[3]) : 0;
  const content = m[4] ?? '';
  const ordered = marker.length > 1;
  const pad = content === '' || gap > 4 ? 1 : gap;
  return { indent, ordered, start: ordered ? parseInt(marker, 10) : 1, contentOffset: indent + marker.length + pad, content };
}

/**
 * Lenient list parsing: a line belongs to the current item when it is indented deeper than
 * the item's marker (models are inconsistent with 2/3/4-space nesting). Fenced code inside
 * an item swallows its lines whatever their indentation.
 */
function parseList(lines: string[], start: number, first: ListMarker, depth: number): BlockResult {
  const items: string[][] = [];
  let cur: string[] = [first.content];
  let marker = first;
  items.push(cur);
  let loose = false;
  let blank = false;
  let fence = fenceOpen(first.content);
  let para = isParagraphText(first.content);
  let i = start + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      cur.push(stripIndent(line, Math.min(leadingWidth(line), marker.contentOffset)));
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    if (BLANK.test(line)) {
      cur.push('');
      blank = true;
      para = false;
      continue;
    }
    const ind = leadingWidth(line);
    const mk = listMarker(line);
    if (mk && ind <= marker.indent) {
      if (mk.ordered !== first.ordered) break;
      if (blank) loose = true;
      cur = [mk.content];
      marker = mk;
      items.push(cur);
      blank = false;
      fence = fenceOpen(mk.content);
      para = isParagraphText(mk.content);
      continue;
    }
    const minIndent = blank ? Math.min(marker.contentOffset, marker.indent + 2) : marker.indent + 1;
    if (ind >= minIndent) {
      if (blank && !mk) loose = true;
      const stripped = stripIndent(line, Math.min(ind, marker.contentOffset));
      cur.push(stripped);
      blank = false;
      fence = fenceOpen(stripped);
      para = !fence && isParagraphText(stripped);
      continue;
    }
    if (!blank && para && !interruptsParagraph(lines, i)) {
      cur.push(line.trim()); // lazy paragraph continuation
      continue;
    }
    break;
  }

  const tag = first.ordered ? 'ol' : 'ul';
  let html = first.ordered && first.start !== 1 ? `<ol start="${first.start}">` : `<${tag}>`;
  for (const item of items) {
    while (item.length > 1 && BLANK.test(item[item.length - 1])) item.pop();
    const task = TASK.exec(item[0]);
    let prefix = '';
    if (task) {
      const done = task[1] !== ' ';
      prefix = `<span class="task-box${done ? ' done' : ''}" aria-hidden="true">${done ? '☑' : '☐'}</span> `;
      item[0] = item[0].slice(task[0].length);
    }
    html += `<li${task ? ' class="task-item"' : ''}>${prefix}${renderBlocks(item, depth + 1, !loose)}</li>`;
  }
  return { html: `${html}</${tag}>`, next: i };
}

// --- indentation helpers ----------------------------------------------------------------

/** Visual width of the leading whitespace (tab stops of 4). */
function leadingWidth(s: string): number {
  let w = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === 0x20) w++;
    else if (c === 0x09) w += 4 - (w % 4);
    else break;
  }
  return w;
}

/** Removes up to `cols` columns of leading whitespace, splitting a tab when needed. */
function stripIndent(line: string, cols: number): string {
  let w = 0;
  let k = 0;
  while (k < line.length && w < cols) {
    const c = line.charCodeAt(k);
    if (c === 0x20) {
      w++;
      k++;
    } else if (c === 0x09) {
      const tab = 4 - (w % 4);
      if (w + tab > cols) return ' '.repeat(w + tab - cols) + line.slice(k + 1);
      w += tab;
      k++;
    } else break;
  }
  return line.slice(k);
}

// ---------------------------------------------------------------------------------------
// Inlines
//
// One left-to-right scan handles backslash escapes, code spans and links; their rendered
// HTML is parked in `slots` and replaced by NUL-delimited placeholders. The remaining raw
// text then goes through the file-reference / URL pass (also parked in slots), is escaped,
// gets emphasis, and finally the placeholders are restored.

function placeholder(slots: string[], html: string): string {
  return `\u0000${slots.push(html) - 1}\u0000`;
}

function restoreSlots(html: string, slots: string[]): string {
  return slots.length === 0 ? html : html.replace(/\u0000(\d+)\u0000/g, (_m, d: string) => slots[Number(d)] ?? '');
}

function isAsciiPunct(c: number): boolean {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

function renderInline(src: string, allowLinks = true): string {
  if (src === '') return '';
  const slots: string[] = [];
  const put = (html: string): string => placeholder(slots, html);
  let noCloser: Map<number, number> | undefined;
  let text = '';
  let last = 0;
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 0x5c) {
      // backslash escape
      if (i + 1 < n && isAsciiPunct(src.charCodeAt(i + 1))) {
        text += src.slice(last, i) + put(escapeHtml(src[i + 1]));
        i += 2;
        last = i;
      } else i++;
      continue;
    }
    if (c === 0x60) {
      // code span
      let j = i + 1;
      while (j < n && src.charCodeAt(j) === 0x60) j++;
      const run = j - i;
      noCloser ??= new Map();
      const close = findBacktickCloser(src, j, run, noCloser);
      if (close < 0) {
        i = j; // unmatched backticks are literal
        continue;
      }
      let code = src.slice(j, close).replace(/\n/g, ' ');
      if (code.length >= 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim() !== '') code = code.slice(1, -1);
      text += src.slice(last, i) + put(`<code>${linkifyHtml(code)}</code>`);
      i = close + run;
      last = i;
      continue;
    }
    if (allowLinks && (c === 0x5b || (c === 0x21 && src.charCodeAt(i + 1) === 0x5b))) {
      const image = c === 0x21;
      const link = parseLink(src, image ? i + 1 : i);
      if (link) {
        text += src.slice(last, i) + put(renderLink(link, image));
        i = link.end;
        last = i;
        continue;
      }
    }
    i++;
  }
  text += src.slice(last);
  return restoreSlots(emphasis(linkify(text, put)), slots);
}

/** Index of the next backtick run of exactly `run` characters at or after `from`, or -1. */
function findBacktickCloser(src: string, from: number, run: number, noCloser: Map<number, number>): number {
  const known = noCloser.get(run);
  if (known !== undefined && from >= known) return -1;
  let k = from;
  for (;;) {
    const idx = src.indexOf('`', k);
    if (idx < 0) {
      noCloser.set(run, known === undefined ? from : Math.min(known, from));
      return -1;
    }
    let e = idx + 1;
    while (e < src.length && src.charCodeAt(e) === 0x60) e++;
    if (e - idx === run) return idx;
    k = e;
  }
}

// --- links: rendered as inert text --------------------------------------------------------

interface ParsedLink {
  text: string;
  url: string;
  end: number;
}

function skipSpaces(src: string, i: number): number {
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
  return i;
}

function parseLink(src: string, open: number): ParsedLink | null {
  const n = src.length;
  let depth = 0;
  let close = -1;
  const limit = Math.min(n, open + 1000);
  for (let i = open; i < limit; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x5c) i++;
    else if (c === 0x5b) depth++;
    else if (c === 0x5d && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0 || src.charCodeAt(close + 1) !== 0x28) return null;
  let j = skipSpaces(src, close + 2);
  let url: string;
  if (src[j] === '<') {
    const e = src.indexOf('>', j + 1);
    if (e < 0 || src.slice(j + 1, e).indexOf('\n') >= 0) return null;
    url = src.slice(j + 1, e);
    j = e + 1;
  } else {
    const s = j;
    let parens = 0;
    const lim = Math.min(n, j + 2048);
    for (; j < lim; j++) {
      const c = src.charCodeAt(j);
      if (c === 0x5c && j + 1 < n) j++;
      else if (c === 0x28) parens++;
      else if (c === 0x29) {
        if (parens === 0) break;
        parens--;
      } else if (c <= 0x20) break;
    }
    url = src.slice(s, j);
  }
  j = skipSpaces(src, j);
  const q = src[j];
  if (q === '"' || q === "'" || (q === '(' && url !== '')) {
    const e = src.indexOf(q === '(' ? ')' : q, j + 1);
    if (e < 0) return null;
    j = skipSpaces(src, e + 1);
  }
  if (src[j] !== ')') return null;
  return { text: src.slice(open + 1, close), url, end: j + 1 };
}

function renderLink(link: ParsedLink, image: boolean): string {
  const url = link.url.replace(/\\([!-/:-@[-`{-~])/g, '$1').trim();
  const label = renderInline(link.text, false);
  const prefix = image ? 'image: ' : '';
  if (url === '') return `<span class="ext-link">${prefix}${label}</span>`;
  // The URL is shown, never followed. A workspace-relative file reference still becomes a file-ref.
  const shown = linkifyHtml(url);
  if (!image && link.text.trim() === url) return `<span class="ext-link">${shown}</span>`;
  return `<span class="ext-link">${prefix}${label}${label ? ' ' : ''}(${shown})</span>`;
}

// --- file references (and URLs, which are protected from them) ---------------------------

const KNOWN_EXT = new Set(
  (
    'ts tsx mts cts js jsx mjs cjs py pyi pyx rb php java kt kts scala groovy gradle go rs c h cc cpp cxx hpp hh hxx ' +
    'cs csx fs fsi fsx vb swift m mm dart lua r jl pl pm sh bash zsh fish ps1 psm1 psd1 bat cmd sql html htm css scss ' +
    'sass less vue svelte astro json jsonc json5 yaml yml toml xml ini cfg conf md mdx rst txt proto graphql gql tf hcl ' +
    'mk cmake ex exs erl hrl hs elm clj cljs edn ml mli nim zig sol shader hlsl glsl cginc compute uss uxml asmdef ' +
    'razor cshtml csproj sln props targets ipynb vcxproj xaml'
  ).split(' '),
);

// group 1: URL (left untouched, shielded from file-ref detection and emphasis)
const URL_SRC = String.raw`((?:\b[A-Za-z][A-Za-z0-9+.-]{1,30}:\/\/|\bwww\.)[^\s\u0000<>"'\x60]*)`;
// group 2: path, group 3: extension. Not preceded by a path character (no match inside
// URLs, absolute paths or longer tokens).
const PATH_SRC = String.raw`(?<![\w.\/\\:@~%+$-])((?:[\w.-]+\/)*[\w.-]*[\w-]\.([A-Za-z][A-Za-z0-9]{0,9}))`;
// :12 :12-30 :12:5 | #L12 #L12-L30 | " (line 12)" " (lines 12-30)" | (12,5) (MSBuild / Unity console)
const LINE_SRC = String.raw`(?::(\d{1,7})(?:[-\u2013](\d{1,7}))?(?::\d{1,5})?|#L(\d{1,7})(?:-L?(\d{1,7}))?|[ \u00a0]?\((?:[Ll]ines?|[Ll]n\.?|[Ll]\.)[ \u00a0]?(\d{1,7})(?:[ \u00a0]?[-\u2013][ \u00a0]?(\d{1,7}))?\)|\((\d{1,7})(?:, ?\d{1,5})?\))(?!\w|\.\d)`;
const REF_RE = new RegExp(`${URL_SRC}|${PATH_SRC}${LINE_SRC}`, 'g');

function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (ch === ')') {
      const s = url.slice(0, end);
      if (s.split(')').length > s.split('(').length) {
        end--;
        continue;
      }
      break;
    }
    if (".,;:!?*_~'\"]}".indexOf(ch) >= 0) {
      end--;
      continue;
    }
    break;
  }
  return url.slice(0, end);
}

function fileRefHtml(m: RegExpExecArray): string | null {
  const path = m[2];
  if (path === undefined || m[3] === undefined) return null;
  if (path.indexOf('/') < 0 && !KNOWN_EXT.has(m[3].toLowerCase())) return null;
  if (path.indexOf('//') >= 0) return null;
  // Unmatched groups are undefined at runtime even though RegExpExecArray types them as string.
  const line: string | undefined = m[4] ?? m[6] ?? m[8] ?? m[10];
  if (line === undefined) return null;
  let end: string | undefined = m[5] ?? m[7] ?? m[9];
  if (end !== undefined && Number(end) < Number(line)) end = undefined;
  const clean = path.replace(/^(?:\.\/)+/, '');
  const where = end !== undefined ? `lines ${line}-${end}` : `line ${line}`;
  return (
    `<a class="file-ref" href="#" data-path="${escapeHtml(clean)}" data-line="${line}"` +
    `${end !== undefined ? ` data-end="${end}"` : ''} title="Open ${escapeHtml(clean)} at ${where}">${escapeHtml(m[0])}</a>`
  );
}

/**
 * Escapes `text` (raw, may contain placeholders) and parks file references and URLs in
 * slots through `put`, so later passes never touch them.
 */
function linkify(text: string, put: (html: string) => string): string {
  // Every file reference and URL contains a dot.
  if (text.indexOf('.') < 0) return escapeHtml(text);
  let out = '';
  let last = 0;
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(text)) !== null) {
    let raw = m[0];
    let html: string | null;
    if (m[1] !== undefined) {
      raw = trimUrl(raw);
      if (raw === '') continue;
      REF_RE.lastIndex = m.index + raw.length;
      html = escapeHtml(raw);
    } else {
      html = fileRefHtml(m);
    }
    if (html === null) continue;
    out += escapeHtml(text.slice(last, m.index)) + put(html);
    last = m.index + raw.length;
  }
  return out + escapeHtml(text.slice(last));
}

/** linkify() for text that gets no further inline processing (code spans, link URLs). */
function linkifyHtml(text: string): string {
  if (text.indexOf('.') < 0) return escapeHtml(text);
  const slots: string[] = [];
  return restoreSlots(
    linkify(text, (html) => placeholder(slots, html)),
    slots,
  );
}

// --- emphasis (CommonMark delimiter runs, simplified) -------------------------------------

interface Delim {
  ch: number;
  len: number;
  orig: number;
  part: number;
  open: boolean;
  close: boolean;
  active: boolean;
  openTags: string;
  closeTags: string;
}

function isSpaceCode(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || (c >= 0x2000 && c <= 0x200a) || c === 0x3000;
}

const UNICODE_PUNCT = /[\p{P}\p{S}]/u;

function isPunctCode(c: number): boolean {
  if (c < 128) return isAsciiPunct(c);
  return UNICODE_PUNCT.test(String.fromCharCode(c));
}

/** Applies *em*, **strong**, _em_, __strong__ and ~~del~~ to escaped text with placeholders. */
function emphasis(s: string): string {
  if (!/[*_~]/.test(s)) return s;
  const parts: string[] = [];
  const delims: Delim[] = [];
  const re = /\*+|_+|~+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const run = m[0];
    const from = m.index;
    const to = from + run.length;
    if (from > last) parts.push(s.slice(last, from));
    last = to;
    const ch = run.charCodeAt(0);
    if (ch === 0x7e && run.length !== 2) {
      parts.push(run);
      continue;
    }
    const before = from > 0 ? s.charCodeAt(from - 1) : 0x20;
    const after = to < s.length ? s.charCodeAt(to) : 0x20;
    const spaceBefore = isSpaceCode(before);
    const spaceAfter = isSpaceCode(after);
    const punctBefore = isPunctCode(before);
    const punctAfter = isPunctCode(after);
    const left = !spaceAfter && (!punctAfter || spaceBefore || punctBefore);
    const right = !spaceBefore && (!punctBefore || spaceAfter || punctAfter);
    // "_" never opens or closes inside a word (snake_case_names stay intact).
    const open = ch === 0x5f ? left && (!right || punctBefore) : left;
    const close = ch === 0x5f ? right && (!left || punctAfter) : right;
    if (open || close) {
      delims.push({ ch, len: run.length, orig: run.length, part: parts.length, open, close, active: true, openTags: '', closeTags: '' });
    }
    parts.push(run);
  }
  if (delims.length < 2) return s;
  if (last < s.length) parts.push(s.slice(last));
  matchDelimiters(delims);
  for (const d of delims) parts[d.part] = d.closeTags + String.fromCharCode(d.ch).repeat(d.len) + d.openTags;
  return parts.join('');
}

function matchDelimiters(delims: Delim[]): void {
  const floors = new Map<number, number>();
  for (let c = 0; c < delims.length; c++) {
    const closer = delims[c];
    if (!closer.close || !closer.active) continue;
    const key = closer.ch * 8 + (closer.open ? 4 : 0) + (closer.orig % 3);
    const floor = floors.get(key) ?? -1;
    let found = -1;
    for (let o = c - 1; o > floor; o--) {
      const op = delims[o];
      if (!op.active || !op.open || op.ch !== closer.ch) continue;
      // CommonMark "rule of 3"
      if (closer.ch !== 0x7e && (op.close || closer.open) && (op.orig + closer.orig) % 3 === 0 && (op.orig % 3 !== 0 || closer.orig % 3 !== 0)) continue;
      found = o;
      break;
    }
    if (found < 0) {
      floors.set(key, c - 1);
      if (!closer.open) closer.active = false;
      continue;
    }
    const op = delims[found];
    const use = closer.ch === 0x7e ? 2 : op.len >= 2 && closer.len >= 2 ? 2 : 1;
    const tag = closer.ch === 0x7e ? 'del' : use === 2 ? 'strong' : 'em';
    op.len -= use;
    closer.len -= use;
    op.openTags = `<${tag}>${op.openTags}`;
    closer.closeTags += `</${tag}>`;
    for (let k = found + 1; k < c; k++) delims[k].active = false;
    if (op.len === 0) op.active = false;
    if (closer.len === 0) closer.active = false;
    else c--; // the rest of this run may close an outer opener
  }
}
