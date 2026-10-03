// When to ask for a completion, and whether to aim for one line or a block.

import { commentSyntaxFor, familyOf } from '../index/languages';

export interface LineContext {
  /** Text of the current line before the cursor. */
  linePrefix: string;
  /** Text of the current line after the cursor. */
  lineSuffix: string;
  /** Lines before the current one, nearest LAST. */
  previousLines: string[];
  /** Lines after the current one, nearest FIRST. */
  nextLines: string[];
  languageId: string;
}

export type CompletionMode = 'single' | 'multi';
export type MultilineSetting = 'auto' | 'always' | 'never';

/** After the cursor we only tolerate closing punctuation: suggestions in the middle of real code are noise. */
const CLOSING_ONLY = /^[\s)\]}>"'`;,.:]*$/;
const BLOCK_OPENER = /(\{|\(|\[|:|=>|->|\bthen|\bdo|\bbegin)\s*$/;

export function isMiddleOfLine(lineSuffix: string): boolean {
  return !CLOSING_ONLY.test(lineSuffix);
}

export type TriggerDecision = { trigger: true } | { trigger: false; reason: string };

export function shouldTrigger(ctx: LineContext, explicit: boolean): TriggerDecision {
  if (explicit) return { trigger: true };
  if (isMiddleOfLine(ctx.lineSuffix)) return { trigger: false, reason: 'middle-of-line' };
  return { trigger: true };
}

export function isCommentLine(line: string, languageId: string): boolean {
  const t = line.trim();
  if (!t) return false;
  const syn = commentSyntaxFor(languageId);
  if (syn.line && t.startsWith(syn.line)) return true;
  if (syn.blockStart && t.startsWith(syn.blockStart)) return true;
  if (familyOf(languageId) === 'c-like' && (t.startsWith('*') || t.endsWith('*/'))) return true;
  return false;
}

export function previousNonEmpty(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i];
  return undefined;
}

/** Cursor on an empty line right under a comment: the comment is probably an instruction. */
export function isAfterComment(ctx: LineContext): boolean {
  if (ctx.linePrefix.trim() !== '' || ctx.lineSuffix.trim() !== '') return false;
  const prev = previousNonEmpty(ctx.previousLines);
  return prev !== undefined && isCommentLine(prev, ctx.languageId);
}

export function chooseMode(ctx: LineContext, setting: MultilineSetting): CompletionMode {
  if (setting === 'always') return 'multi';
  if (setting === 'never') return 'single';
  if (ctx.lineSuffix.trim() !== '') return 'single';
  const prefix = ctx.linePrefix.trimEnd();
  if (prefix.trim() === '') return 'multi';
  if (BLOCK_OPENER.test(prefix)) return 'multi';
  return 'single';
}
