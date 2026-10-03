import * as vscode from 'vscode';

/** Thin wrapper over a LogOutputChannel. Code and prompts are only logged at trace level. */
export class Logger implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('Local Copilot', { log: true });

  info(message: string): void {
    this.channel.info(message);
  }

  warn(message: string): void {
    this.channel.warn(message);
  }

  error(message: string, err?: unknown): void {
    this.channel.error(err ? `${message}: ${err instanceof Error ? err.message : String(err)}` : message);
  }

  debug(message: string): void {
    this.channel.debug(message);
  }

  trace(message: string): void {
    this.channel.trace(message);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
