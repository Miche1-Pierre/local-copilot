// Guards the "zero cloud" property: no source file may contain a network
// address other than loopback, and nothing may use telemetry APIs.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

function files(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, acc);
    else if (/\.(ts|js|mjs|css|html)$/.test(name)) acc.push(full);
  }
  return acc;
}

const sources = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'media'))];
const URL_RE = /\b(?:https?|wss?):\/\/([^\s'"`)<>/:]+)/g;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

describe('no network egress in the extension sources', () => {
  it('only references loopback URLs', () => {
    const offenders: string[] = [];
    for (const f of sources) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(URL_RE)) if (!LOOPBACK.has(m[1])) offenders.push(`${f}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('uses no telemetry API and no WebSocket/XHR', () => {
    const forbidden = /createTelemetryLogger|TelemetryReporter|applicationinsights|new WebSocket|XMLHttpRequest|navigator\.sendBeacon/;
    const offenders = sources.filter((f) => forbidden.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('routes every HTTP call through the policy-checked client', () => {
    const offenders = sources.filter((f) => !f.endsWith(join('providers', 'http.ts')) && /\bfetch\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
