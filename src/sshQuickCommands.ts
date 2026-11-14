import { randomBytes, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { toErrorMessage } from './config';
import { createSshTerminal, type SshTerminalSession } from './sshTerminal';
import type { ResolvedProfile } from './types';

const LIBRARY_KEY = 'sshQuickCommands';
const MAX_COMMAND_BYTES = 16_384;
const MAX_NAME_LENGTH = 80;
const MAX_BACKGROUND_OUTPUT = 512_000;
const COMMAND_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
const PANEL_TYPE = 'sftpFtpUploader.sshSession';

type SavedCommand = { id: string; name: string; command: string };
type Operation = 'execute' | 'save' | 'delete';
type SessionTab = {
  id: string;
  panel: vscode.WebviewPanel;
  session: SshTerminalSession;
  listeners: vscode.Disposable[];
  started: boolean;
  closed: boolean;
  disposed: boolean;
  collapsed: boolean;
  backgroundOutput: string[];
  backgroundOutputLength: number;
  backgroundOutputTruncated: boolean;
  backgroundResult?: object;
};

export class SshQuickCommands implements vscode.Disposable {
  private readonly tabs = new Set<SessionTab>();
  private libraryQueue = Promise.resolve();
  private disposed = false;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async openTerminal(profile: ResolvedProfile, colorizeLogs: boolean): Promise<void> {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const xterm = vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@xterm', 'xterm');
    const fitAddon = vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@xterm', 'addon-fit');
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, 'sshQuickCommands.html'));
    if (this.disposed) return;

    let tab: SessionTab;
    const session = createSshTerminal(profile, this.context.globalState, colorizeLogs, {
      onOutput: (data) => this.postOutput(tab, data),
      onStateChange: () => this.postState(tab),
      onClose: (message) => {
        if (tab.disposed) return;
        tab.closed = true;
        const detail = (message || 'SSH 会话已结束。').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
        this.postOutput(tab, `\r\n${detail}\r\n`);
      },
    });

    const panel = vscode.window.createWebviewPanel(PANEL_TYPE, `SSH · ${profile.name}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media, xterm, fitAddon],
    });
    panel.iconPath = new vscode.ThemeIcon('terminal');
    tab = {
      id: randomUUID(), panel, session, listeners: [], started: false,
      closed: false, disposed: false, collapsed: true,
      backgroundOutput: [], backgroundOutputLength: 0, backgroundOutputTruncated: false,
    };
    this.tabs.add(tab);
    tab.listeners.push(
      panel.webview.onDidReceiveMessage((value: unknown) => void this.handleMessage(tab, value)),
      panel.onDidChangeViewState(() => {
        if (panel.visible) this.restoreView(tab);
      }),
      panel.onDidDispose(() => this.closeTab(tab)),
    );

    const nonce = randomBytes(16).toString('hex');
    const resource = (root: vscode.Uri, ...parts: string[]) =>
      panel.webview.asWebviewUri(vscode.Uri.joinPath(root, ...parts)).toString();
    panel.webview.html = Buffer.from(bytes).toString('utf8')
      .replaceAll('{{cspSource}}', () => panel.webview.cspSource)
      .replaceAll('{{nonce}}', nonce)
      .replaceAll('{{styleUri}}', () => resource(media, 'sshQuickCommands.css'))
      .replaceAll('{{scriptUri}}', () => resource(media, 'sshQuickCommands.js'))
      .replaceAll('{{xtermCssUri}}', () => resource(xterm, 'css', 'xterm.css'))
      .replaceAll('{{xtermScriptUri}}', () => resource(xterm, 'lib', 'xterm.js'))
      .replaceAll('{{fitScriptUri}}', () => resource(fitAddon, 'lib', 'addon-fit.js'));
  }

  public show(): void {
    const tabs = [...this.tabs];
    const tab = tabs.find((item) => item.panel.active) ?? tabs.reverse().find((item) => !item.closed);
    if (!tab) {
      void vscode.window.showInformationMessage('请先从 SSH 终端列表打开一个会话。');
      return;
    }
    tab.collapsed = false;
    tab.panel.reveal();
    this.postState(tab);
  }

  public dispose(): void {
    this.disposed = true;
    for (const tab of this.tabs) {
      this.closeTab(tab);
      tab.panel.dispose();
    }
  }

  private closeTab(tab: SessionTab): void {
    if (tab.disposed) return;
    tab.disposed = true;
    this.tabs.delete(tab);
    for (const listener of tab.listeners) listener.dispose();
    tab.session.close();
  }

  private getCommands(): SavedCommand[] {
    return this.context.workspaceState.get<SavedCommand[]>(LIBRARY_KEY, []);
  }

  private postState(tab: SessionTab): void {
    const connected = tab.session.isConnected();
    this.post(tab, {
      type: 'state',
      collapsed: tab.collapsed,
      title: tab.panel.title,
      endpoint: tab.session.endpoint,
      connected,
      closed: tab.closed,
      activeSessionId: connected ? tab.id : undefined,
      commands: this.getCommands(),
    });
  }

  private async handleMessage(tab: SessionTab, value: unknown): Promise<void> {
    if (tab.disposed || !value || typeof value !== 'object' || !('type' in value)) return;
    const operation = value.type;
    if (operation === 'ready' || operation === 'resize') {
      const dimensions = getDimensions(value);
      if (operation === 'ready') {
        this.postState(tab);
        if (!tab.started) {
          tab.started = true;
          tab.session.open(dimensions);
        }
      } else if (dimensions) {
        tab.session.setDimensions(dimensions);
      }
      return;
    }
    if (operation === 'input') {
      if ('data' in value && typeof value.data === 'string') tab.session.handleInput(value.data);
      return;
    }
    if (operation === 'show' || operation === 'hide') {
      tab.collapsed = operation === 'hide';
      this.postState(tab);
      return;
    }
    if (operation !== 'execute' && operation !== 'save' && operation !== 'delete') return;

    try {
      if (operation === 'execute') {
        if (!('sessionId' in value) || value.sessionId !== tab.id || !tab.session.isConnected()) {
          throw new Error('当前 SSH 会话尚未连接或已断开。');
        }
        await tab.session.sendCommand(readCommand('command' in value ? value.command : undefined));
        this.postResult(tab, operation, true, '命令已发送。');
        return;
      }

      const change = this.libraryQueue.then(() => this.updateLibrary(tab, operation, value));
      this.libraryQueue = change.catch(() => undefined);
      await change;
    } catch (error) {
      this.postResult(tab, operation, false, toErrorMessage(error));
    }
  }

  private async updateLibrary(tab: SessionTab, operation: 'save' | 'delete', value: object): Promise<void> {
    if (tab.disposed) return;
    const commands = this.getCommands();
    const id = 'id' in value && typeof value.id === 'string' ? value.id : undefined;
    const existing = commands.find((entry) => entry.id === id);

    if (operation === 'save') {
      const command = readCommand('command' in value ? value.command : undefined);
      const name = 'name' in value && typeof value.name === 'string' ? value.name.trim() : '';
      if (!name || name.length > MAX_NAME_LENGTH || /[\x00-\x1f\x7f-\x9f]/.test(name)) {
        throw new Error('请输入 1 到 80 个字符的命令名称。');
      }
      if (id && !existing) throw new Error('该快捷命令已不存在。');
      const saved = { id: existing?.id ?? randomUUID(), name, command };
      const updated = existing ? commands.map((entry) => entry.id === id ? saved : entry) : [...commands, saved];
      await this.context.workspaceState.update(LIBRARY_KEY, updated);
      this.refreshLibrary();
      this.postResult(tab, operation, true, '已保存到当前工作区的命令库。', saved.id);
      return;
    }

    if (!existing) throw new Error('该快捷命令已不存在。');
    const choice = await vscode.window.showWarningMessage(`删除快捷命令「${existing.name}」？`, { modal: true }, '删除');
    if (choice !== '删除' || tab.disposed) {
      this.postResult(tab, operation, false, '已取消删除。');
      return;
    }
    await this.context.workspaceState.update(LIBRARY_KEY, commands.filter((entry) => entry.id !== existing.id));
    this.refreshLibrary();
    this.postResult(tab, operation, true, '快捷命令已删除。');
  }

  private refreshLibrary(): void {
    for (const tab of this.tabs) this.postState(tab);
  }

  private postResult(tab: SessionTab, operation: Operation, ok: boolean, message: string, commandId?: string): void {
    if (tab.disposed) return;
    const result = { type: 'result', operation, ok, message, commandId };
    if (tab.panel.visible) this.post(tab, result);
    else tab.backgroundResult = result;
  }

  private postOutput(tab: SessionTab, data: string): void {
    if (tab.disposed || !data) return;
    if (tab.panel.visible) {
      this.post(tab, { type: 'output', data });
      return;
    }

    tab.backgroundOutput.push(data);
    tab.backgroundOutputLength += data.length;
    while (tab.backgroundOutputLength > MAX_BACKGROUND_OUTPUT && tab.backgroundOutput.length > 1) {
      tab.backgroundOutputLength -= tab.backgroundOutput.shift()!.length;
      tab.backgroundOutputTruncated = true;
    }
  }

  private restoreView(tab: SessionTab): void {
    if (tab.backgroundOutput.length) {
      const notice = tab.backgroundOutputTruncated ? '\r\n[部分后台输出已省略]\r\n' : '';
      this.postOutput(tab, notice + tab.backgroundOutput.join(''));
      tab.backgroundOutput = [];
      tab.backgroundOutputLength = 0;
      tab.backgroundOutputTruncated = false;
    }
    this.postState(tab);
    if (tab.backgroundResult) {
      this.post(tab, tab.backgroundResult);
      tab.backgroundResult = undefined;
    }
  }

  private post(tab: SessionTab, value: object): void {
    if (!tab.disposed) void tab.panel.webview.postMessage(value);
  }
}

function getDimensions(value: object): vscode.TerminalDimensions | undefined {
  if (!('cols' in value) || !('rows' in value) || typeof value.cols !== 'number' || typeof value.rows !== 'number'
    || !Number.isInteger(value.cols) || !Number.isInteger(value.rows)
    || value.cols < 2 || value.cols > 1_000 || value.rows < 1 || value.rows > 1_000) return undefined;
  return { columns: value.cols, rows: value.rows };
}

function readCommand(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请输入要发送的命令。');
  if (Buffer.byteLength(value, 'utf8') > MAX_COMMAND_BYTES || COMMAND_CONTROLS.test(value)) {
    throw new Error('命令须在 16 KB 以内，且不能含终端控制字符。');
  }
  return value.replace(/\r\n?/g, '\n');
}
