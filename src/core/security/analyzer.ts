// First stage of the security review: run the static rules, ignore matches in
// comments (and, for most rules, inside string literals), and rank sinks by the
// taint that reaches them. The result is shown at once and handed to the model.

import { CharKind, maskCode } from '../index/scanner';
import { CALLABLE_KINDS, extractSymbols, symbolAt, type SymbolInfo } from '../index/symbols';
import { SECURITY_RULES, type Confidence, type SecurityRule, type Severity } from './rules';
import { computeFunctionTaint, findTaintedVariable, type FunctionTaint, type TaintSource } from './taint';

export type { Confidence, Severity } from './rules';

export interface StaticFinding {
  /** `${ruleId}:${line}` */
  id: string;
  ruleId: string;
  title: string;
  cwe: string;
  severity: Severity;
  confidence: Confidence;
  /** 0-based. */
  line: number;
  column: number;
  endColumn: number;
  excerpt: string;
  message: string;
  recommendation: string;
  taint?: { source: TaintSource; variable: string; functionName?: string };
}

const MAX_LINE = 2000;
const ORDER: Severity[] = ['low', 'medium', 'high', 'critical'];

export function severityRank(s: Severity): number {
  return ORDER.indexOf(s) + 1;
}

function raise(s: Severity): Severity {
  return ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(s) + 1)];
}

function rulesFor(languageId: string): SecurityRule[] {
  return SECURITY_RULES.filter((r) => r.languages === '*' || r.languages.includes(languageId));
}

export function analyzeStatic(text: string, languageId: string, range?: { startLine: number; endLine: number }): StaticFinding[] {
  const src = text.replace(/\r\n?/g, '\n');
  const rules = rulesFor(languageId);
  if (rules.length === 0) return [];
  const lines = src.split('\n');
  const { kinds } = maskCode(src, languageId);
  const lineStarts: number[] = [];
  let offset = 0;
  for (const l of lines) {
    lineStarts.push(offset);
    offset += l.length + 1;
  }

  let symbols: SymbolInfo[] | undefined;
  const taints = new Map<number, FunctionTaint>();
  const taintAt = (line: number): { fn?: SymbolInfo; taint: FunctionTaint } => {
    symbols ??= extractSymbols(src, languageId);
    const fn = symbolAt(symbols, line, CALLABLE_KINDS);
    if (!fn) return { taint: { tainted: new Map() } };
    let t = taints.get(fn.startLine);
    if (!t) {
      t = computeFunctionTaint(src, languageId, fn.declLine, fn.endLine, fn.signature, fn.name);
      taints.set(fn.startLine, t);
    }
    return { fn, taint: t };
  };

  const from = Math.max(0, range?.startLine ?? 0);
  const to = Math.min(lines.length - 1, range?.endLine ?? lines.length - 1);
  const out: StaticFinding[] = [];
  for (let i = from; i <= to; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const line = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw;
    for (const rule of rules) {
      const m = rule.pattern.exec(line);
      if (!m) continue;
      // Skip leading whitespace/punctuation the pattern consumed to find where the match really starts.
      const lead = m[0].length - m[0].trimStart().length;
      const kind = kinds[lineStarts[i] + m.index + lead];
      if (kind === CharKind.Comment) continue;
      if (!rule.inStrings && (kind === CharKind.StringContent || kind === CharKind.StringDelimiter)) continue;
      if (rule.unless?.test(line)) continue;
      if (rule.requires && !rule.requires.test(line)) continue;

      let severity = rule.severity;
      let confidence: Confidence = rule.precise ? 'high' : 'medium';
      let taint: StaticFinding['taint'];
      if (rule.sink || rule.requiresTaint) {
        const { fn, taint: ft } = taintAt(i);
        const hit = findTaintedVariable(line, ft, languageId);
        if (!hit && rule.requiresTaint) continue;
        if (hit) taint = { ...hit, functionName: fn?.name };
        confidence = hit?.source === 'user-input' ? 'high' : hit ? 'medium' : 'low';
        if (hit?.source === 'user-input') severity = raise(severity);
      }
      out.push({
        id: `${rule.id}:${i}`,
        ruleId: rule.id,
        title: rule.title,
        cwe: rule.cwe,
        severity,
        confidence,
        line: i,
        column: m.index + lead,
        endColumn: m.index + m[0].length,
        excerpt: raw.trim().slice(0, 200),
        message: rule.message,
        recommendation: rule.recommendation,
        taint,
      });
    }
  }
  return out.sort((a, b) => a.line - b.line || severityRank(b.severity) - severityRank(a.severity));
}

/** Compact list for the model, ids S1…Sn in the same order as `findings`. */
export function formatFindingsForPrompt(findings: StaticFinding[]): string {
  return findings
    .map((f, i) => {
      const flow = f.taint ? ` · data from ${f.taint.source === 'user-input' ? 'user input' : 'a parameter'} \`${f.taint.variable}\`` : '';
      return `[S${i + 1}] line ${f.line + 1} · ${f.cwe} · ${f.title} · severity ${f.severity}, confidence ${f.confidence} · \`${f.excerpt}\`${flow}`;
    })
    .join('\n');
}
