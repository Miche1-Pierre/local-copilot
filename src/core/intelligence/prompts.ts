// Prompt builders for the code intelligence tasks. Each returns chat messages;
// the context (related code, project summary) is assembled by the caller.

import type { TaskKind } from '../../webview/protocol';
import type { ChatMessage } from '../providers/types';
import { withLineNumbers } from '../util/text';

export const DEEP_TASKS: ReadonlySet<TaskKind> = new Set(['security', 'review', 'fix', 'codebase']);

export interface ContextSnippet {
  /** Workspace-relative path. */
  path: string;
  /** 1-based inclusive line range, when the snippet is a part of the file. */
  startLine?: number;
  endLine?: number;
  /** Why it is included ("defines PlayerHealth", "imported", "similar code"). */
  label?: string;
  languageId: string;
  text: string;
}

export interface CodeUnderAnalysis {
  path: string;
  languageId: string;
  /** 1-based first line of `code`. */
  startLine: number;
  code: string;
  /** e.g. "method TakeDamage in class PlayerHealth" */
  description?: string;
}

export interface PromptEnvironment {
  /** Answer language, e.g. "English" or "French". */
  language: string;
  projectSummary?: string;
  related: ContextSnippet[];
}

const FENCE: Record<string, string> = {
  csharp: 'csharp',
  typescript: 'ts',
  typescriptreact: 'tsx',
  javascript: 'js',
  javascriptreact: 'jsx',
  python: 'python',
  shellscript: 'bash',
  cpp: 'cpp',
  c: 'c',
};

export function fenceLang(languageId: string): string {
  return FENCE[languageId] ?? languageId;
}

function system(language: string, extra: string): ChatMessage {
  return {
    role: 'system',
    content: [
      'You are Local Copilot, a senior software engineer running entirely on the user\'s machine, inside their code editor.',
      'Be precise, concrete and concise. Never invent files, APIs or behaviour you cannot see; say so when something is uncertain.',
      `Write explanations in ${language} (code, identifiers and code comments stay as they are in the project).`,
      extra,
    ].join('\n'),
  };
}

function renderRelated(env: PromptEnvironment): string {
  const parts: string[] = [];
  if (env.projectSummary) parts.push(`## Project\n${env.projectSummary}`);
  if (env.related.length > 0) {
    parts.push('## Related code from the repository');
    for (const s of env.related) {
      const range = s.startLine ? `:${s.startLine}-${s.endLine ?? s.startLine}` : '';
      parts.push(`### ${s.path}${range}${s.label ? ` — ${s.label}` : ''}\n\`\`\`${fenceLang(s.languageId)}\n${s.text}\n\`\`\``);
    }
  }
  return parts.join('\n\n');
}

function renderTarget(target: CodeUnderAnalysis, numbered = true): string {
  const endLine = target.startLine + target.code.split('\n').length - 1;
  const body = numbered ? withLineNumbers(target.code, target.startLine) : target.code;
  return `## Code under analysis: ${target.path} lines ${target.startLine}-${endLine}${target.description ? ` (${target.description})` : ''}\n\`\`\`${fenceLang(target.languageId)}\n${body}\n\`\`\``;
}

function user(...sections: (string | undefined)[]): ChatMessage {
  return { role: 'user', content: sections.filter((s) => s && s.trim()).join('\n\n') };
}

export function explainPrompt(target: CodeUnderAnalysis, env: PromptEnvironment): ChatMessage[] {
  return [
    system(env.language, 'You explain code to a developer who is new to it.'),
    user(
      renderRelated(env),
      renderTarget(target),
      [
        'Explain the code under analysis. Structure:',
        '1. One sentence: what it is for.',
        '2. How it works, step by step, citing lines as L12 or L12-L20.',
        '3. Inputs, outputs and side effects (state changes, I/O, events).',
        '4. Pitfalls or edge cases worth knowing (only real ones).',
        'Use short Markdown sections. Stay under 300 words unless the code is long.',
      ].join('\n'),
    ),
  ];
}

export function reviewPrompt(target: CodeUnderAnalysis, env: PromptEnvironment, recentChanges?: string): ChatMessage[] {
  return [
    system(env.language, 'You review code like a meticulous senior reviewer and answer in JSON.'),
    user(
      renderRelated(env),
      recentChanges ? `## Uncommitted changes in this file (git diff)\n\`\`\`diff\n${recentChanges}\n\`\`\`` : undefined,
      renderTarget(target),
      [
        'Review the code under analysis. Report only real, actionable problems: bugs, logic errors, null/undefined risks,',
        'race conditions, resource leaks, wrong error handling, performance traps, misleading names or structure that hides a bug.',
        'No pure style nitpicks. If the code is fine, return an empty "findings" array and say so in "summary".',
        'For each finding: "line" = the number in the left margin, "excerpt" = that line\'s code copied exactly,',
        '"explanation" = why it is a problem (concrete scenario), "suggestion" = the fix (short code if useful).',
        'Answer with JSON only: {"summary": string, "findings": [{"line", "endLine", "severity": "info|warning|error",',
        '"category": "bug|performance|readability|maintainability|security|design", "title", "explanation", "suggestion", "excerpt"}]}',
      ].join('\n'),
    ),
  ];
}

export function securityPrompt(target: CodeUnderAnalysis, env: PromptEnvironment, staticFindings: string): ChatMessage[] {
  return [
    system(env.language, 'You are an application security expert (OWASP, CWE). You answer in JSON.'),
    user(
      renderRelated(env),
      renderTarget(target),
      staticFindings
        ? `## Findings of the static analyzer (ids S1, S2…)\n${staticFindings}`
        : '## Findings of the static analyzer\n(none)',
      [
        'Audit the code under analysis for vulnerabilities: injection (SQL, OS command, code), broken authentication or',
        'authorization, insecure deserialization, path traversal, SSRF, XSS, hard-coded secrets, weak cryptography,',
        'race conditions/TOCTOU, unsafe file or network handling, missing input validation, sensitive data exposure.',
        '1. For EACH static finding give a verdict in "staticVerdicts": "confirmed", "false_positive" or "uncertain", with a one-line reason',
        '   (is the data really attacker-controlled? is it already sanitised or parameterised?).',
        '2. In "findings", list only ADDITIONAL real vulnerabilities the static analyzer missed (do not repeat static ones).',
        '   "line" = number in the left margin, "excerpt" = that line\'s code copied exactly, "explanation" = the attack scenario,',
        '   "suggestion" = the concrete fix, "cwe" = e.g. "CWE-89", "confidence" = low|medium|high.',
        'Do not report generic best practices without a concrete risk in THIS code. An empty "findings" array is a valid answer.',
        'Answer with JSON only: {"summary": string, "staticVerdicts": [{"id","verdict","reason"}], "findings": [...]}',
      ].join('\n'),
    ),
  ];
}

export function testsPrompt(target: CodeUnderAnalysis, env: PromptEnvironment, framework: string): ChatMessage[] {
  return [
    system(env.language, 'You write focused, runnable unit tests.'),
    user(
      renderRelated(env),
      renderTarget(target, false),
      [
        `Write unit tests for the code under analysis with ${framework}.`,
        'Cover the main behaviour, edge cases and error paths; one behaviour per test; descriptive test names.',
        'Mock only real external dependencies. Do not test private details you cannot reach.',
        'Output ONE complete test file (imports/usings included) in a single fenced code block whose first line is a comment',
        'with the suggested file path. After the block, at most 3 short bullets: how to run, what is mocked, what is not covered.',
      ].join('\n'),
    ),
  ];
}

export function refactorPrompt(target: CodeUnderAnalysis, env: PromptEnvironment, instruction: string): ChatMessage[] {
  return [
    system(env.language, 'You refactor code safely, preserving behaviour.'),
    user(
      renderRelated(env),
      renderTarget(target, false),
      [
        `Refactor the code under analysis. Goal: ${instruction}`,
        'Keep its behaviour, its public API and its indentation (the result replaces those exact lines).',
        'Output ONLY the full replacement code in a single fenced code block, then one sentence listing the changes.',
      ].join('\n'),
    ),
  ];
}

export function fixPrompt(target: CodeUnderAnalysis, env: PromptEnvironment, problem: string): ChatMessage[] {
  return [
    system(env.language, 'You debug code: find the root cause, then fix it minimally.'),
    user(
      renderRelated(env),
      renderTarget(target),
      `## Problem\n${problem || 'No error message was given: find what is most likely broken in this code.'}`,
      [
        'Explain the root cause in 2-4 sentences (cite lines as L12).',
        'Then output the corrected version of the code under analysis (the same lines, full replacement, no line numbers)',
        'in a single fenced code block. Change as little as possible.',
      ].join('\n'),
    ),
  ];
}

const DOC_STYLE: Record<string, string> = {
  csharp: 'C# XML documentation comments (/// <summary>, <param>, <returns>)',
  typescript: 'TSDoc /** … */ with @param and @returns',
  typescriptreact: 'TSDoc /** … */ with @param and @returns',
  javascript: 'JSDoc /** … */ with @param {type} and @returns',
  javascriptreact: 'JSDoc /** … */',
  python: 'a PEP 257 docstring (Google style: Args, Returns, Raises), triple double quotes',
  java: 'Javadoc /** … */ with @param, @return, @throws',
  kotlin: 'KDoc /** … */',
  go: 'Go doc comment (// FunctionName …)',
  rust: 'rustdoc /// comments with # Examples when useful',
  cpp: 'Doxygen /** … */ with @brief, @param, @return',
  c: 'Doxygen /** … */',
  php: 'PHPDoc /** … */',
  swift: 'Swift /// markup comments',
};

export function documentPrompt(target: CodeUnderAnalysis, env: PromptEnvironment, indent: string): ChatMessage[] {
  const style = DOC_STYLE[target.languageId] ?? 'the idiomatic documentation comment format of this language';
  return [
    system(env.language, 'You write accurate, useful documentation comments.'),
    user(
      renderRelated(env),
      renderTarget(target, false),
      [
        `Write the documentation comment for the code under analysis using ${style}.`,
        'Describe intent, parameters, return value, side effects and thrown errors; no filler.',
        `Indent every line with exactly ${JSON.stringify(indent)}.`,
        'Output ONLY the comment (not the code) in a single fenced code block.',
      ].join('\n'),
    ),
  ];
}

export function generatePrompt(opts: {
  path: string;
  languageId: string;
  before: string;
  after: string;
  instruction: string;
  indent: string;
  env: PromptEnvironment;
}): ChatMessage[] {
  const lang = fenceLang(opts.languageId);
  return [
    system(opts.env.language, 'You write the code that implements an instruction, exactly at the cursor.'),
    user(
      renderRelated(opts.env),
      `## File ${opts.path} (the cursor is at <CURSOR>)\n\`\`\`${lang}\n${opts.before}<CURSOR>${opts.after}\n\`\`\``,
      `## Instruction\n${opts.instruction}`,
      [
        'Write the code to insert at <CURSOR> that implements the instruction.',
        `It will be inserted as-is; use the indentation ${JSON.stringify(opts.indent)} for its first level.`,
        'Match the surrounding style and naming. Do not repeat code that already exists before or after the cursor.',
        'Use only APIs visible in the context or in the language/framework standard library.',
        'Output ONLY the code to insert, in a single fenced code block. No explanation.',
      ].join('\n'),
    ),
  ];
}

export interface CodebaseExcerpt {
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  languageId: string;
  text: string;
}

export function codebasePrompt(question: string, excerpts: CodebaseExcerpt[], env: PromptEnvironment, fileTree?: string): ChatMessage[] {
  const blocks = excerpts.map(
    (e, i) =>
      `### [${i + 1}] ${e.path}:${e.startLine}-${e.endLine}${e.symbol ? ` (${e.symbol})` : ''}\n\`\`\`${fenceLang(e.languageId)}\n${e.text}\n\`\`\``,
  );
  return [
    system(env.language, 'You answer questions about the user\'s repository from retrieved excerpts.'),
    user(
      env.projectSummary ? `## Repository\n${env.projectSummary}` : undefined,
      fileTree ? `## Main folders\n${fileTree}` : undefined,
      `## Retrieved excerpts\n${blocks.join('\n\n') || '(no matching code found)'}`,
      `## Question\n${question}`,
      [
        'Answer from the excerpts. Cite each claim with its location written as `path/to/file.ext:start-end`',
        '(paths and lines from the excerpt headers). If the excerpts are not enough, say what is missing and where',
        'to look next. Structure the answer with short sections or bullets.',
      ].join('\n'),
    ),
  ];
}

export function followUpMessages(history: ChatMessage[], question: string): ChatMessage[] {
  return [...history, { role: 'user', content: question }];
}
