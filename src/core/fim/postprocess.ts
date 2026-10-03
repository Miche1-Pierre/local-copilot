// Turns raw model output into a suggestion that fits the document: strips special
// tokens, stops at the end of the current block, removes what the suffix already
// contains, and reconciles closing punctuation after the cursor.

import { indentWidth } from '../util/text';
import type { CompletionMode } from './heuristics';
import { ALL_SPECIAL_MARKERS } from './templates';

export interface PostProcessContext {
  mode: CompletionMode;
  linePrefix: string;
  lineSuffix: string;
  /** Lines after the current line, nearest first. */
  nextLines: string[];
  /** Lines before the current line, nearest last. */
  previousLines: string[];
  maxLines: number;
}

export interface ProcessedCompletion {
  text: string;
  /** The suggestion already contains the rest of the current line: replace up to end of line. */
  replaceLineSuffix: boolean;
}

const OPENS_BLOCK = /(\{|\(|\[|:|=>|->|\bthen|\bdo|\bbegin)\s*(\/\/.*|#.*)?$/;
const STARTS_WITH_CLOSER = /^\s*(\}|\)|\]|end\b|done\b|fi\b|esac\b|until\b)/;

export function stripSpecialTokens(raw: string): string {
  const text = raw.replace(/\r\n?/g, '\n');
  let cut = text.length;
  for (const marker of ALL_SPECIAL_MARKERS) {
    const i = text.indexOf(marker);
    if (i >= 0 && i < cut) cut = i;
  }
  return text.slice(0, cut);
}

function firstNonEmpty(lines: string[]): string | undefined {
  return lines.find((l) => l.trim().length > 0);
}

interface BlockCut {
  lines: string[];
  /** True when the completion was cut because it left the current block or hit maxLines. */
  truncated: boolean;
}

/**
 * Keeps the lines of a multi-line completion that belong to the current block.
 * `lines[0]` is the text inserted on the cursor line; the rest are new lines.
 */
export function cutAtBlockEnd(lines: string[], ctx: PostProcessContext, completeLinesOnly = false): BlockCut {
  const firstFull = ctx.linePrefix + lines[0];
  const opens = firstFull.trim().length > 0 && OPENS_BLOCK.test(firstFull.trimEnd());
  const anchorIndent = firstFull.trim().length > 0 ? indentWidth(firstFull) : undefined;
  const suffixHead = firstNonEmpty(ctx.nextLines);
  // Lines that already follow the cursor: the model re-typing them means it is done.
  const upcoming = new Set(ctx.nextLines.filter((l) => l.trim().length >= 10).slice(0, 8).map((l) => l.trim()));
  // Does the suffix already close a block at this indentation with the same bracket?
  const suffixCloses = (line: string) => {
    const ind = indentWidth(line);
    const ch = line.trim()[0];
    return ctx.nextLines.some((l) => l.trim().length > 0 && indentWidth(l) === ind && l.trim()[0] === ch);
  };
  const out = [lines[0]];
  let baseIndent = anchorIndent;
  const limit = completeLinesOnly ? lines.length - 1 : lines.length;
  for (let i = 1; i < limit; i++) {
    if (out.length >= ctx.maxLines) return { lines: out, truncated: true };
    const line = lines[i];
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    if (upcoming.has(line.trim())) return { lines: out, truncated: true };
    const ind = indentWidth(line);
    if (baseIndent === undefined) {
      // Cursor was on an empty line and the first line was empty too: the first real line sets the level.
      baseIndent = ind;
      out.push(line);
      continue;
    }
    const closer = STARTS_WITH_CLOSER.test(line);
    if (opens) {
      if (ind > baseIndent) {
        out.push(line);
        continue;
      }
      // Back at the opener's level: keep the closer of the block we opened, then stop.
      if (closer && !(suffixHead && suffixHead.trim() === line.trim() && indentWidth(suffixHead) === ind)) out.push(line);
      return { lines: out, truncated: true };
    }
    if (ind >= baseIndent) {
      out.push(line);
      continue;
    }
    // Dedent below the cursor's block: keep the closer only if nothing below closes that block already.
    if (closer && !suffixCloses(line)) out.push(line);
    return { lines: out, truncated: true };
  }
  return { lines: out, truncated: false };
}

/** Streaming helper: true once the completed lines already leave the current block. */
export function shouldStopEarly(accumulated: string, ctx: PostProcessContext): boolean {
  if (ctx.mode === 'single') {
    const nl = accumulated.indexOf('\n');
    return nl >= 0 && (accumulated.slice(0, nl).trim().length > 0 || ctx.linePrefix.trim().length > 0);
  }
  if (accumulated.indexOf('\n') < 0) return false;
  const lines = stripSpecialTokens(accumulated).split('\n');
  return cutAtBlockEnd(lines, ctx, true).truncated;
}

/** Longest k such that `text` ends with the first k characters of `tail`. */
function overlapWithTail(text: string, tail: string): number {
  for (let k = Math.min(text.length, tail.length); k > 0; k--) {
    if (text.endsWith(tail.slice(0, k))) return k;
  }
  return 0;
}

export function postProcessCompletion(raw: string, ctx: PostProcessContext): ProcessedCompletion | undefined {
  let text = stripSpecialTokens(raw);
  if (!text.trim()) return undefined;
  const cursorLineEmpty = ctx.linePrefix.trim().length === 0;

  let lines: string[];
  if (ctx.mode === 'single') {
    if (text.startsWith('\n')) return undefined;
    lines = [text.split('\n')[0]];
  } else {
    lines = text.split('\n');
    if (lines.length > 1 && lines[0].trim() === '' && !cursorLineEmpty && !OPENS_BLOCK.test(ctx.linePrefix.trimEnd())) {
      // The model wants to start a new statement after a complete line: not our call.
      return undefined;
    }
    lines = cutAtBlockEnd(lines, ctx).lines;
    // Drop trailing lines that duplicate what already follows the cursor.
    const nextNonEmpty = ctx.nextLines.filter((l) => l.trim());
    while (lines.length > 1) {
      const last = lines[lines.length - 1];
      if (!last.trim()) {
        lines.pop();
        continue;
      }
      const dupAt = nextNonEmpty.findIndex((l) => l.trim() === last.trim());
      if (dupAt === 0 && STARTS_WITH_CLOSER.test(last)) {
        lines.pop();
        continue;
      }
      break;
    }
  }

  lines = lines.map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
  text = lines.join('\n');
  if (!text.trim()) return undefined;

  // Regurgitation: the model re-typed the line that already follows the cursor.
  const nextLine = firstNonEmpty(ctx.nextLines);
  const firstContent = firstNonEmpty(lines);
  if (cursorLineEmpty && nextLine && firstContent && firstContent.trim() === nextLine.trim() && nextLine.trim().length > 3) return undefined;
  // Repetition of the previous line (a classic small-model loop).
  const prevLine = ctx.previousLines[ctx.previousLines.length - 1];
  if (lines.length === 1 && prevLine && (ctx.linePrefix + text).trim() === prevLine.trim() && prevLine.trim().length > 8) return undefined;

  // Closing punctuation after the cursor (e.g. "foo(|)"): reuse it instead of duplicating it.
  const tail = ctx.lineSuffix.trim();
  if (tail) {
    if (lines.length > 1) {
      text = lines[0];
      lines = [text];
    }
    const k = overlapWithTail(text.trimEnd(), tail);
    if (k === tail.length) return { text: text.trimEnd(), replaceLineSuffix: true };
    if (k > 0) text = text.trimEnd().slice(0, -k);
    if (!text.trim()) return undefined;
  }
  return { text, replaceLineSuffix: false };
}
