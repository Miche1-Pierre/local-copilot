// Comment directives: "// Review the function below for security issues",
// "# Explique ce code", "// Write tests for this class"… and generation
// instructions ("// Create a function that validates a French SIRET number").

import type { TaskKind } from '../../webview/protocol';
import { commentLines, maskCode } from '../index/scanner';

export type DirectiveKind = Extract<TaskKind, 'security' | 'review' | 'explain' | 'tests' | 'refactor' | 'document' | 'fix' | 'generate'>;

export interface Directive {
  kind: DirectiveKind;
  /** First and last line (0-based) of the comment block holding the directive. */
  startLine: number;
  endLine: number;
  /** Comment text without markers, lines joined with spaces. */
  text: string;
}

const EXPLICIT_PREFIX = /^@?(local|copilot|lc|ai)\s*[:,]?\s+/i;

// Unicode-aware word boundaries: \b does not understand "sécurité".
const SECURITY_WORDS = /(?<![\p{L}\p{N}_])(security|secure|vulnerab\p{L}*|exploit\p{L}*|injection|xss|csrf|ssrf|owasp|cwe|s[ée]curit[ée]|vuln[ée]rab\p{L}*|failles?)(?![\p{L}\p{N}_])/iu;
const ANALYSIS_VERBS = /^(please\s+)?(review|check|audit|analy[sz]e|scan|find|look|inspect|verify|is\s+(this|it)|v[ée]rifie\w*|analyse\w*|audite\w*|cherche\w*|trouve\w*|relis|relire|examine\w*|contr[ôo]le\w*|est-ce)/i;

const RULES: { kind: DirectiveKind; re: RegExp }[] = [
  { kind: 'tests', re: /^(please\s+)?((write|generate|create|add)\s+(some\s+)?(unit\s+)?tests?|tests?\s+for)\b|^([ée]cris|g[ée]n[èe]re|cr[ée]e|ajoute)\s+(des\s+|les\s+)?tests?\b/i },
  { kind: 'review', re: /^(please\s+)?(code\s+)?review\b|^(relis|relire|revois|fais\s+une\s+revue|revue\s+de\s+code)\b/i },
  { kind: 'explain', re: /^(please\s+)?(explain|what\s+does\s+(this|the\s+\w+\s+below)\s+do)\b|^(explique|que\s+fait)\b/i },
  { kind: 'refactor', re: /^(please\s+)?(refactor|simplify|clean\s*up|restructure|rewrite)\b|^(refactorise|refactore|simplifie|nettoie|r[ée][ée]cris)\b/i },
  { kind: 'document', re: /^(please\s+)?(document\b|add\s+(a\s+)?(doc|docs|documentation|docstring|doc\s*comment))|^(documente|ajoute\s+(la\s+)?(doc|documentation))\b/i },
  { kind: 'fix', re: /^(please\s+)?(fix|debug)\b|^why\s+(is|does)\s+this\s+(fail|crash|throw|break)|^(corrige|r[ée]pare|d[ée]bogue|pourquoi\s+([çc]a|cela)\s+(plante|[ée]choue))\b/i },
];

/** Verbs that start an implementation instruction (EN/FR). */
const GENERATE_VERBS =
  /^(please\s+)?(implement|create|write|add|make|compute|calculate|return|build|generate|parse|validate|convert|sort|filter|load|save|fetch|send|handle|find|get|set|update|delete|remove|initiali[sz]e|init|todo:?\s*implement|impl[ée]mente|cr[ée]e|[ée]cris|ajoute|calcule|retourne|renvoie|construis|g[ée]n[èe]re|valide|convertis|trie|filtre|charge|sauvegarde|enregistre|envoie|g[èe]re|trouve|r[ée]cup[èe]re|mets?\s+[àa]\s+jour|supprime|initialise|fais)\b/i;

/** Classifies a comment as an analysis directive. Plain explanatory comments return undefined. */
export function classifyComment(raw: string): DirectiveKind | undefined {
  let text = raw.trim();
  const explicit = EXPLICIT_PREFIX.test(text);
  text = text.replace(EXPLICIT_PREFIX, '');
  if (SECURITY_WORDS.test(text) && (ANALYSIS_VERBS.test(text) || explicit)) return 'security';
  for (const r of RULES) if (r.re.test(text)) return r.kind;
  if (explicit) return 'generate';
  return undefined;
}

export function looksLikeGenerationInstruction(raw: string): boolean {
  const text = raw.trim().replace(EXPLICIT_PREFIX, '');
  return GENERATE_VERBS.test(text) && text.split(/\s+/).length >= 3;
}

/** Groups consecutive full-line comments into blocks. */
function commentBlocks(text: string, languageId: string): { startLine: number; endLine: number; text: string }[] {
  const mask = maskCode(text, languageId);
  const lines = commentLines(text, languageId, mask).filter((c) => c.fullLine);
  const blocks: { startLine: number; endLine: number; parts: string[] }[] = [];
  for (const c of lines) {
    const last = blocks[blocks.length - 1];
    if (last && c.line === last.endLine + 1) {
      last.endLine = c.line;
      last.parts.push(c.text);
    } else {
      blocks.push({ startLine: c.line, endLine: c.line, parts: [c.text] });
    }
  }
  return blocks.map((b) => ({ startLine: b.startLine, endLine: b.endLine, text: b.parts.join(' ').replace(/\s+/g, ' ').trim() }));
}

/**
 * Directives worth a CodeLens: analysis requests anywhere, and generation
 * instructions that have no code under them yet.
 */
export function findDirectives(text: string, languageId: string): Directive[] {
  const lines = text.split('\n');
  const out: Directive[] = [];
  for (const block of commentBlocks(text, languageId)) {
    if (!block.text || block.text.length > 400) continue;
    const kind = classifyComment(block.text);
    if (kind && kind !== 'generate') {
      out.push({ kind, ...block });
      continue;
    }
    const next = lines[block.endLine + 1];
    const nothingBelow = next === undefined || next.trim() === '' || /^\s*[}\])]/.test(next);
    if ((kind === 'generate' || looksLikeGenerationInstruction(block.text)) && nothingBelow) out.push({ kind: 'generate', ...block });
  }
  return out;
}

/** The directive whose comment block contains `line`, or ends right above it (cursor on the empty line below). */
export function directiveAt(text: string, languageId: string, line: number): Directive | undefined {
  const lines = text.split('\n');
  for (const block of commentBlocks(text, languageId)) {
    const below = block.endLine + 1;
    const cursorBelow = line === below && (lines[line] ?? '').trim() === '';
    if ((line >= block.startLine && line <= block.endLine) || cursorBelow) {
      const kind = classifyComment(block.text) ?? (looksLikeGenerationInstruction(block.text) || cursorBelow ? 'generate' : undefined);
      if (kind) return { kind, ...block };
    }
  }
  return undefined;
}
