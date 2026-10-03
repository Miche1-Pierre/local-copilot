#!/usr/bin/env node
// Scans the BUILT bundles (what actually ships in the .vsix) for network
// addresses. Anything other than loopback fails the check.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const URL_RE = /\b(?:https?|wss?):\/\/([^\s'"`)<>/:\\]+)/g;
const roots = ['dist', 'media'];
let offenders = 0;
let scanned = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(js|css|html|json)$/.test(name) && !name.endsWith('.map')) check(full);
  }
}

function check(file) {
  scanned++;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(URL_RE)) {
    if (LOOPBACK.has(m[1])) continue;
    offenders++;
    console.error(`✗ ${file}: ${m[0]}`);
  }
}

for (const r of roots) {
  try {
    walk(r);
  } catch {
    console.error(`(missing ${r}/ — run npm run build first)`);
    process.exitCode = 1;
  }
}
if (offenders > 0) {
  console.error(`\n${offenders} non-loopback address(es) found in the shipped files.`);
  process.exit(1);
}
console.log(`✓ ${scanned} shipped files scanned: only loopback addresses.`);
