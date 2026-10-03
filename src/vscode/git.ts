import { execFile } from 'node:child_process';
import * as vscode from 'vscode';

/** Uncommitted changes of one file (local `git diff`), or undefined. Never touches the network. */
export function gitDiff(uri: vscode.Uri, maxLines = 150): Promise<string | undefined> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder || uri.scheme !== 'file' || !vscode.workspace.isTrusted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('git', ['--no-pager', 'diff', '--no-color', '-U2', '--', uri.fsPath], { cwd: folder.uri.fsPath, timeout: 3000, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(undefined);
      const lines = stdout.split('\n');
      resolve(lines.length > maxLines ? `${lines.slice(0, maxLines).join('\n')}\n… (diff truncated)` : stdout);
    });
  });
}
