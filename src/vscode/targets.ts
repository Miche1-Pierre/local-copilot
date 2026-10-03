// Which code does a command act on? Selection, else the directive's block,
// else the function/class around the cursor (from the language server when
// available, from our own symbol scanner otherwise), else a window.

import * as vscode from 'vscode';
import { CALLABLE_KINDS, extractSymbols, symbolAt, TYPE_KINDS, type SymbolInfo } from '../core/index/symbols';
import { sleep } from '../core/util/async';

export interface CodeTarget {
  document: vscode.TextDocument;
  /** Whole lines. */
  range: vscode.Range;
  /** "method TakeDamage", "selection", "lines 10-40"… */
  description: string;
  symbolName?: string;
}

const CALLABLE_VSCODE = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);
const TYPE_VSCODE = new Set([vscode.SymbolKind.Class, vscode.SymbolKind.Struct, vscode.SymbolKind.Interface, vscode.SymbolKind.Enum]);

function fullLines(document: vscode.TextDocument, startLine: number, endLine: number): vscode.Range {
  const end = Math.min(document.lineCount - 1, Math.max(startLine, endLine));
  return new vscode.Range(startLine, 0, end, document.lineAt(end).text.length);
}

async function languageServerSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[] | undefined> {
  const request = Promise.resolve(
    vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', document.uri),
  ).catch(() => undefined);
  const result = await Promise.race([request, sleep(1500).then(() => undefined)]);
  if (!result || result.length === 0 || !('children' in result[0])) return undefined;
  return result as vscode.DocumentSymbol[];
}

function innermost(symbols: vscode.DocumentSymbol[], pos: vscode.Position, kinds: Set<vscode.SymbolKind>): vscode.DocumentSymbol | undefined {
  let best: vscode.DocumentSymbol | undefined;
  const walk = (list: vscode.DocumentSymbol[]) => {
    for (const s of list) {
      if (!s.range.contains(pos)) continue;
      if (kinds.has(s.kind)) best = s;
      walk(s.children);
    }
  };
  walk(symbols);
  return best;
}

function describe(kind: string, name: string): string {
  return `${kind} ${name}`;
}

/** Target for an explicit command at the editor's selection/cursor. */
export async function resolveTarget(editor: vscode.TextEditor, opts: { preferType?: boolean } = {}): Promise<CodeTarget> {
  const { document, selection } = editor;
  if (!selection.isEmpty) {
    const r = fullLines(document, selection.start.line, selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line - 1 : selection.end.line);
    return { document, range: r, description: `selection, lines ${r.start.line + 1}-${r.end.line + 1}` };
  }
  return targetAtLine(document, selection.active, opts);
}

export async function targetAtLine(document: vscode.TextDocument, pos: vscode.Position, opts: { preferType?: boolean } = {}): Promise<CodeTarget> {
  const ls = await languageServerSymbols(document);
  if (ls) {
    const kinds = opts.preferType ? TYPE_VSCODE : CALLABLE_VSCODE;
    const sym = innermost(ls, pos, kinds) ?? innermost(ls, pos, opts.preferType ? CALLABLE_VSCODE : TYPE_VSCODE);
    if (sym) {
      const kind = vscode.SymbolKind[sym.kind].toLowerCase();
      return { document, range: fullLines(document, sym.range.start.line, sym.range.end.line), description: describe(kind, sym.name), symbolName: sym.name };
    }
  }
  const symbols = extractSymbols(document.getText().replace(/\r\n/g, '\n'), document.languageId);
  const own = symbolAt(symbols, pos.line, opts.preferType ? TYPE_KINDS : CALLABLE_KINDS) ?? symbolAt(symbols, pos.line, opts.preferType ? CALLABLE_KINDS : TYPE_KINDS);
  if (own && own.kind !== 'namespace') return fromSymbol(document, own);
  if (document.lineCount <= 400) return { document, range: fullLines(document, 0, document.lineCount - 1), description: 'whole file' };
  const start = Math.max(0, pos.line - 40);
  const end = Math.min(document.lineCount - 1, pos.line + 40);
  return { document, range: fullLines(document, start, end), description: `lines ${start + 1}-${end + 1}` };
}

/** The code a directive comment refers to: the declaration right below it, else the block below. */
export async function targetBelow(document: vscode.TextDocument, commentEndLine: number): Promise<CodeTarget> {
  let line = commentEndLine + 1;
  while (line < document.lineCount && document.lineAt(line).text.trim() === '') line++;
  if (line >= document.lineCount) return targetAtLine(document, new vscode.Position(commentEndLine, 0));
  const symbols = extractSymbols(document.getText().replace(/\r\n/g, '\n'), document.languageId);
  const starting = symbols
    .filter((s) => s.startLine <= line && s.declLine >= line && s.kind !== 'namespace')
    .sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine))[0];
  if (starting) return fromSymbol(document, starting);
  const ls = await languageServerSymbols(document);
  if (ls) {
    const pos = new vscode.Position(line, document.lineAt(line).firstNonWhitespaceCharacterIndex);
    const sym = innermost(ls, pos, CALLABLE_VSCODE) ?? innermost(ls, pos, TYPE_VSCODE);
    if (sym && sym.range.start.line >= commentEndLine) {
      return { document, range: fullLines(document, sym.range.start.line, sym.range.end.line), description: describe(vscode.SymbolKind[sym.kind].toLowerCase(), sym.name), symbolName: sym.name };
    }
  }
  let end = line;
  while (end + 1 < document.lineCount && document.lineAt(end + 1).text.trim() !== '' && end - line < 60) end++;
  return { document, range: fullLines(document, line, end), description: `lines ${line + 1}-${end + 1}` };
}

function fromSymbol(document: vscode.TextDocument, s: SymbolInfo): CodeTarget {
  return { document, range: fullLines(document, s.startLine, s.endLine), description: describe(s.kind, s.container ? `${s.container}.${s.name}` : s.name), symbolName: s.name };
}
