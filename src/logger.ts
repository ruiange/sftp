import * as vscode from 'vscode';

export class Logger implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('SFTP / FTP Uploader');

  public info(message: string): void {
    this.channel.appendLine(`[${timestamp()}] ${message}`);
  }

  public error(message: string): void {
    this.channel.appendLine(`[${timestamp()}] [错误] ${message}`);
  }

  public show(): void {
    this.channel.show(true);
  }

  public dispose(): void {
    this.channel.dispose();
  }
}

function timestamp(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}
