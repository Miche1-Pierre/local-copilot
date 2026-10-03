#!/usr/bin/env node
// Benchmarks fill-in-the-middle models on YOUR code: latency and accuracy.
//
// It hides the end of real lines (single-line task) and the next lines after
// empty lines inside blocks (multi-line task), asks each model to fill them in,
// and compares with what you actually wrote.
//
//   node scripts/bench-models.mjs --dir <folder> [--ext .cs,.py] [--models a,b]
//                                 [--samples 40] [--endpoint http://127.0.0.1:11434]
//
// Local only: the endpoint must be a loopback address.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const endpoint = args.endpoint ?? 'http://127.0.0.1:11434';
const models = (args.models ?? 'qwen2.5-coder:3b-base,qwen2.5-coder:7b-base').split(',').map((s) => s.trim()).filter(Boolean);
const exts = (args.ext ?? '.cs,.py,.ts,.js,.go,.rs,.java').split(',').map((e) => e.trim().toLowerCase());
const samples = Number(args.samples ?? 40);
const root = args.dir ?? process.cwd();

assertLoopback(endpoint);

const SKIP_DIRS = new Set(['node_modules', '.git', 'Library', 'Temp', 'Logs', 'obj', 'bin', 'build', 'dist', 'out', '.vs', '.idea', '__pycache__', 'venv', '.venv', 'target', 'Packages', 'ThirdParty', 'Plugins']);
const QWEN_STOP = ['<|endoftext|>', '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|fim_pad|>', '<|repo_name|>', '<|file_sep|>', '<|im_start|>', '<|im_end|>'];
const PREFIX_CHARS = 5800; // ~1600 tokens, same budget as the extension
const SUFFIX_CHARS = 1500; // ~400 tokens
const CONTEXT_CHARS = 3600; // ~1000 tokens of another file

const files = collectFiles(root).filter((f) => exts.includes(extname(f).toLowerCase()));
if (files.length < 2) {
  console.error(`Not enough files with ${exts.join(', ')} under ${root}`);
  process.exit(1);
}
const rand = mulberry32(42);
const tasks = buildTasks(files, samples, rand);
console.log(`${files.length} files, ${tasks.length} tasks (${tasks.filter((t) => t.kind === 'line').length} line, ${tasks.filter((t) => t.kind === 'block').length} block) from ${root}\n`);

const results = [];
for (const model of models) {
  process.stdout.write(`warming ${model}… `);
  await generate(model, '<|fim_prefix|>x<|fim_suffix|><|fim_middle|>', 1, []);
  console.log('ok');
  const rows = [];
  for (const task of tasks) {
    const maxTokens = task.kind === 'line' ? 48 : 160;
    const stop = task.kind === 'line' ? [...QWEN_STOP, '\n'] : QWEN_STOP;
    const r = await generate(model, task.prompt, maxTokens, stop);
    const got = task.kind === 'line' ? r.text.split('\n')[0] : firstLines(r.text, task.expected.split('\n').length);
    rows.push({ ...r, kind: task.kind, exact: norm(got) === norm(task.expected), sim: similarity(norm(got), norm(task.expected)) });
  }
  results.push({ model, rows });
}

console.log('\nmodel                          task   n   exact   edit-sim   p50 ms   p95 ms   tok/s');
for (const { model, rows } of results) {
  for (const kind of ['line', 'block']) {
    const r = rows.filter((x) => x.kind === kind);
    if (!r.length) continue;
    const lat = r.map((x) => x.totalMs).sort((a, b) => a - b);
    const tps = r.filter((x) => x.evalMs > 0).map((x) => x.evalCount / (x.evalMs / 1000));
    console.log(
      `${model.padEnd(30)} ${kind.padEnd(6)} ${String(r.length).padStart(3)}   ${pct(r.filter((x) => x.exact).length / r.length).padStart(5)}   ${pct(avg(r.map((x) => x.sim))).padStart(8)}   ${String(pick(lat, 0.5)).padStart(6)}   ${String(pick(lat, 0.95)).padStart(6)}   ${avg(tps).toFixed(0).padStart(5)}`,
    );
  }
}

// ---------------------------------------------------------------------------

function buildTasks(allFiles, count, rnd) {
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 50) {
    const file = allFiles[Math.floor(rnd() * allFiles.length)];
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    if (lines.length < 20) continue;
    const other = allFiles[Math.floor(rnd() * allFiles.length)];
    const context = other === file ? '' : readFileSync(other, 'utf8').replace(/\r\n/g, '\n').slice(0, CONTEXT_CHARS);
    const i = 5 + Math.floor(rnd() * (lines.length - 10));
    const line = lines[i];
    const lineStart = lines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
    const wantBlock = out.length % 3 === 2;
    if (!wantBlock) {
      const content = line.trim();
      if (content.length < 12 || /^(\/\/|#|\*|\/\*)/.test(content)) continue;
      const indent = line.length - line.trimStart().length;
      const cut = indent + Math.max(3, Math.floor(content.length * (0.3 + rnd() * 0.4)));
      const prefix = text.slice(Math.max(0, lineStart + cut - PREFIX_CHARS), lineStart + cut);
      const suffix = text.slice(lineStart + line.length, lineStart + line.length + SUFFIX_CHARS);
      out.push({ kind: 'line', expected: line.slice(cut), prompt: qwenPrompt(file, other, context, prefix, suffix) });
    } else {
      if (line.trim() !== '' || !lines[i + 1]?.trim() || !lines[i + 2]?.trim()) continue;
      const indentBelow = lines[i + 1].length - lines[i + 1].trimStart().length;
      if (indentBelow === 0) continue;
      const expectedLines = lines.slice(i + 1, i + 4).filter((l) => l.trim());
      const cursor = lineStart + line.length;
      const prefix = text.slice(Math.max(0, cursor - PREFIX_CHARS), cursor) + '\n' + ' '.repeat(indentBelow);
      const after = lines.slice(i + 1 + expectedLines.length).join('\n');
      out.push({ kind: 'block', expected: expectedLines.map((l) => l.trimEnd()).join('\n').trimStart(), prompt: qwenPrompt(file, other, context, prefix, '\n' + after.slice(0, SUFFIX_CHARS)) });
    }
  }
  return out;
}

function qwenPrompt(file, other, context, prefix, suffix) {
  const rel = relative(root, file).replace(/\\/g, '/');
  let p = `<|repo_name|>${basename(root)}\n`;
  if (context) p += `<|file_sep|>${relative(root, other).replace(/\\/g, '/')}\n${context}\n`;
  return `${p}<|file_sep|>${rel}\n<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
}

async function generate(model, prompt, maxTokens, stop) {
  const t0 = performance.now();
  const res = await fetch(`${endpoint}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    redirect: 'error',
    body: JSON.stringify({ model, prompt, raw: true, stream: false, keep_alive: '10m', options: { num_ctx: 4096, num_predict: maxTokens, temperature: 0.1, top_p: 0.9, stop } }),
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${await res.text()}`);
  const j = await res.json();
  return { text: j.response ?? '', totalMs: Math.round(performance.now() - t0), evalCount: j.eval_count ?? 0, evalMs: (j.eval_duration ?? 0) / 1e6 };
}

function collectFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) collectFiles(full, acc);
    else if (st.size < 200_000) acc.push(full);
  }
  return acc;
}

function firstLines(text, n) {
  return text.replace(/^\n+/, '').split('\n').filter((l) => l.trim()).slice(0, n).map((l) => l.trimEnd()).join('\n').trimStart();
}
function norm(s) {
  return s.replace(/\s+/g, ' ').trim();
}
function similarity(a, b) {
  if (!a && !b) return 1;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}
function levenshtein(a, b) {
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
function pick(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
function avg(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function pct(x) {
  return `${(x * 100).toFixed(0)}%`;
}
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? 'true' : argv[++i];
  }
  return out;
}
function assertLoopback(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (!(host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host))) {
    console.error(`Refusing non-loopback endpoint ${url}: this tool is local-only.`);
    process.exit(2);
  }
}
