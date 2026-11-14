import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { TextDecoder } from 'node:util';
import * as vscode from 'vscode';
import type { RemoteFileEntry } from './clients/remoteClient';
import { toErrorMessage, type ConfigService } from './config';
import type { RemoteFileActions, RemoteFileItem } from './remoteFileActions';
import type { RemoteFileScope, RemoteFileSystem } from './remoteFileSystem';

type PanelTarget = { name: string; endpoint: string; workspace: string };

export class RemoteFilesPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private folder: vscode.WorkspaceFolder | undefined;
  private rootUri: vscode.Uri | undefined;
  private otherRootUri: vscode.Uri | undefined;
  private target: PanelTarget | undefined;
  private scope: RemoteFileScope = 'deployment';
  private rootPath = '/';
  private directory = '/';
  private rows: RemoteFileEntry[] = [];
  private connected = false;
  private busy = false;
  private error: string | undefined;
  private revision = 0;
  private pendingTargetRefresh = false;
  private pendingDirectoryRefresh = false;
  private readonly panelDisposables: vscode.Disposable[] = [];
  private readonly fileChanges: vscode.Disposable;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly config: ConfigService,
    private readonly fileSystem: RemoteFileSystem,
    private readonly actions: RemoteFileActions,
  ) {
    const onFileChange = (events: readonly vscode.FileChangeEvent[]): void => {
      if (!events.some(({ uri }) => uri.authority === this.rootUri?.authority || uri.authority === this.otherRootUri?.authority)) {
        return;
      }
      this.pendingDirectoryRefresh = true;
      if (this.panel?.visible && this.connected && !this.busy) {
        void this.runBusy(() => this.readDirectory(this.directory));
      }
    };
    this.fileChanges = vscode.Disposable.from(
      fileSystem.onDidChangeFile(onFileChange),
      fileSystem.onDidChangeServerFile(onFileChange),
    );
  }

  public async show(): Promise<void> {
    if (this.reveal()) return;
    const folder = this.config.getActiveWorkspaceFolder();
    if (!folder) throw new Error('请先打开一个工作区。');
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const template = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, 'serverFiles.html'));
    if (this.reveal()) return;
    const panel = vscode.window.createWebviewPanel(
      'sftpFtpUploader.serverFilesPanel', '远程文件', vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
    );
    this.panel = panel;
    this.folder = folder;
    this.panelDisposables.push(
      panel.webview.onDidReceiveMessage((value: unknown) => {
        if (this.panel === panel) void this.handleMessage(value);
      }),
      panel.onDidChangeViewState(({ webviewPanel }) => {
        if (webviewPanel.visible) {
          this.postState();
          if (this.connected && this.pendingDirectoryRefresh && !this.busy) {
            void this.runBusy(() => this.readDirectory(this.directory));
          }
        }
      }),
      panel.onDidDispose(() => {
        if (this.panel === panel) this.reset();
      }),
    );
    panel.webview.html = Buffer.from(template).toString('utf8')
      .replaceAll('{{cspSource}}', () => panel.webview.cspSource)
      .replaceAll('{{nonce}}', randomBytes(16).toString('hex'))
      .replaceAll('{{styleUri}}', () => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'serverFiles.css')).toString())
      .replaceAll('{{scriptUri}}', () => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'serverFiles.js')).toString());
  }

  public refresh(): void {
    if (!this.panel) return;
    if (this.busy) {
      this.pendingTargetRefresh = true;
    } else {
      void this.runBusy(() => this.reloadCurrentDirectory());
    }
  }

  public async refreshDirectory(): Promise<void> {
    await this.show();
    await this.runBusy(() => this.reloadCurrentDirectory(true));
  }

  public dispose(): void {
    const panel = this.panel;
    this.reset();
    panel?.dispose();
    this.fileChanges.dispose();
  }

  private reveal(): boolean {
    if (!this.panel) return false;
    this.panel.reveal(vscode.ViewColumn.One);
    return true;
  }

  private reset(): void {
    this.revision += 1;
    this.panel = undefined;
    this.folder = undefined;
    this.rootUri = undefined;
    this.otherRootUri = undefined;
    this.target = undefined;
    this.scope = 'deployment';
    this.rootPath = '/';
    this.rows = [];
    this.directory = '/';
    this.connected = false;
    this.busy = false;
    this.error = undefined;
    this.pendingTargetRefresh = false;
    this.pendingDirectoryRefresh = false;
    for (const disposable of this.panelDisposables.splice(0)) disposable.dispose();
  }

  private async refreshTarget(): Promise<void> {
    const request = ++this.revision;
    try {
      const folder = this.folder && vscode.workspace.workspaceFolders?.find((item) => item.uri.toString() === this.folder?.uri.toString());
      if (!folder) throw new Error('连接所属的工作区已关闭。');
      const loaded = await this.config.load(folder, undefined, { resolveLoginSecrets: false });
      if (request !== this.revision || !this.panel) return;
      const rootPath = this.scope === 'server' ? '/' : posix.normalize(loaded.profile.remotePath).replace(/\/$/, '') || '/';
      const root = this.fileSystem.rootUri(loaded, this.scope);
      this.otherRootUri = this.fileSystem.rootUri(loaded, this.scope === 'server' ? 'deployment' : 'server');
      if (root.toString() !== this.rootUri?.toString()) {
        this.rootUri = root;
        this.rootPath = rootPath;
        this.directory = rootPath;
        this.rows = [];
        this.connected = false;
        this.pendingDirectoryRefresh = false;
        this.clearPreview();
      }
      this.target = {
        name: loaded.profile.name,
        endpoint: `${loaded.profile.username}@${loaded.profile.host}:${loaded.profile.port}`,
        workspace: folder.name,
      };
      this.error = undefined;
    } catch (error) {
      if (request !== this.revision || !this.panel) return;
      this.error = toErrorMessage(error);
      this.rootUri = undefined;
      this.otherRootUri = undefined;
      this.rootPath = '/';
      this.directory = '/';
      this.target = undefined;
      this.connected = false;
      this.rows = [];
      this.clearPreview();
    }
    this.postState();
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || !('type' in value)) return;
    const panel = this.panel;
    if (value.type === 'ready') {
      if (this.busy) this.postState();
      else await this.runBusy(() => this.reloadCurrentDirectory());
      return;
    }
    if (this.busy) return;
    if (value.type === 'configure') {
      try {
        await vscode.commands.executeCommand('sftpFtpUploader.openConfig', this.folder?.uri);
      } catch (error) {
        if (this.panel !== panel) return;
        this.error = toErrorMessage(error);
        this.postState();
      }
      return;
    }
    await this.runBusy(async () => {
      if (value.type === 'connect' || value.type === 'refresh') {
        await this.reloadCurrentDirectory(true);
        return;
      }
      if (value.type === 'scope') {
        if (!('scope' in value) || (value.scope !== 'deployment' && value.scope !== 'server') || value.scope === this.scope) return;
        this.scope = value.scope;
        await this.reloadCurrentDirectory();
        return;
      }
      if (!this.connected || !this.rootUri) throw new Error('请先连接并浏览服务器目录。');
      switch (value.type) {
        case 'up':
          if (this.directory !== this.rootPath) await this.readDirectory(posix.dirname(this.directory));
          break;
        case 'navigate':
          if ('path' in value && typeof value.path === 'string') await this.readDirectory(value.path);
          break;
        case 'preview':
          if ('path' in value && typeof value.path === 'string') await this.preview(value.path);
          break;
        case 'open':
          if ('path' in value && typeof value.path === 'string') {
            await this.actions.openRemoteFile(this.itemForPath(value.path, 'file'));
          }
          break;
        case 'createFile':
        case 'createDirectory':
          await this.actions.createRemoteItem(this.directoryItem(), value.type === 'createFile' ? 'file' : 'directory');
          if (this.panel !== panel) return;
          await this.readDirectory(this.directory);
          break;
        case 'rename':
          if ('path' in value && typeof value.path === 'string') {
            await this.actions.renameRemoteItem(this.itemForPath(value.path));
            if (this.panel !== panel) return;
            await this.readDirectory(this.directory);
          }
          break;
        case 'upload':
          await this.actions.uploadFiles(this.directoryItem());
          if (this.panel !== panel) return;
          await this.readDirectory(this.directory);
          break;
        case 'replace':
          if ('path' in value && typeof value.path === 'string') {
            await this.actions.uploadFiles(this.itemForPath(value.path, 'file'), true);
            if (this.panel !== panel) return;
            this.clearPreview();
            await this.readDirectory(this.directory);
          }
          break;
        case 'delete':
          if ('path' in value && typeof value.path === 'string') {
            await this.actions.deleteRemoteItem(this.itemForPath(value.path));
            if (this.panel !== panel) return;
            this.clearPreview();
            await this.readDirectory(this.directory);
          }
          break;
      }
    });
  }

  private async runBusy(action: () => Promise<void>): Promise<void> {
    if (!this.panel || this.busy) return;
    const panel = this.panel;
    this.busy = true;
    this.error = undefined;
    this.postState();
    try {
      await action();
    } catch (error) {
      if (this.panel !== panel) return;
      this.error = toErrorMessage(error);
    } finally {
      if (this.panel === panel) {
        this.busy = false;
        this.postState();
        if (this.pendingTargetRefresh) {
          this.pendingTargetRefresh = false;
          await this.runBusy(() => this.reloadCurrentDirectory());
          return;
        }
        if (this.pendingDirectoryRefresh && this.connected && panel.visible) {
          this.pendingDirectoryRefresh = false;
          await this.runBusy(() => this.readDirectory(this.directory));
        }
      }
    }
  }

  private async reloadCurrentDirectory(force = false): Promise<void> {
    const panel = this.panel;
    await this.refreshTarget();
    if (this.panel === panel && this.rootUri && (force || !this.connected || this.pendingDirectoryRefresh)) {
      await this.readDirectory(this.directory);
    }
  }

  private async readDirectory(remotePath: string): Promise<void> {
    const uri = this.uriForPath(remotePath);
    const root = this.rootUri;
    const panel = this.panel;
    this.pendingDirectoryRefresh = false;
    const entries = await this.fileSystem.listEntries(uri);
    if (this.panel !== panel || this.rootUri !== root) return;
    this.rows = entries.sort((left, right) => Number(right.type === 'directory') - Number(left.type === 'directory')
      || left.name.localeCompare(right.name));
    this.directory = uri.path === '/' ? this.rootPath : posix.join(this.rootPath, uri.path.slice(1));
    this.connected = true;
    this.error = undefined;
    this.clearPreview();
    this.postState();
  }

  private uriForPath(remotePath: string): vscode.Uri {
    const root = this.rootUri;
    if (!root) throw new Error('请先配置服务器连接。');
    const path = remotePath.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    if (path === this.rootPath) return root;

    const relativeRoot = this.rootPath === '.';
    const prefix = this.rootPath === '/' ? '/' : `${this.rootPath}/`;
    if (relativeRoot ? path.startsWith('/') : !path.startsWith(prefix)) {
      throw new Error(`请输入 ${this.rootPath} 范围内的路径。`);
    }
    const relative = relativeRoot ? path.replace(/^\.\//, '') : path.slice(prefix.length);
    let uri = root;
    for (const name of relative.split('/')) {
      uri = this.fileSystem.childUri(uri, name);
    }
    return uri;
  }

  private itemForPath(remotePath: string, requiredType?: 'file'): RemoteFileItem {
    const entry = this.rows.find((row) => row.path === remotePath);
    if (!entry || (requiredType && entry.type !== requiredType)) throw new Error('项目已变化，请刷新目录后重新选择。');
    return { label: entry.name, remotePath: entry.path, entryType: entry.type, remoteUri: this.uriForPath(entry.path) };
  }

  private directoryItem(): RemoteFileItem {
    return {
      label: posix.basename(this.directory) || '/',
      remotePath: this.directory,
      entryType: 'directory',
      remoteUri: this.uriForPath(this.directory),
    };
  }

  private async preview(remotePath: string): Promise<void> {
    const item = this.itemForPath(remotePath, 'file');
    const panel = this.panel;
    const root = this.rootUri;
    try {
      const bytes = await this.fileSystem.previewFile(item.remoteUri);
      if (this.panel === panel && this.rootUri === root && this.rows.some((row) => row.path === remotePath)) {
        this.post({ type: 'preview', path: remotePath, content: decodeText(bytes) });
      }
    } catch (error) {
      if (this.panel === panel && this.rootUri === root) {
        this.post({ type: 'preview', path: remotePath, error: toErrorMessage(error) });
      }
    }
  }

  private clearPreview(): void {
    this.post({ type: 'preview', path: '' });
  }

  private postState(): void {
    this.post({
      type: 'state', target: this.target, path: this.directory, scope: this.scope, rootPath: this.rootPath,
      connected: this.connected, busy: this.busy, error: this.error, rows: this.rows,
    });
  }

  private post(value: unknown): void {
    if (this.panel) void this.panel.webview.postMessage(value);
  }
}

function decodeText(bytes: Uint8Array): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  try {
    const content = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (/[\x00-\x08\x0b\x0e-\x1f]/.test(content)) throw new Error('binary');
    return content;
  } catch {
    throw new Error('无法以文本预览该文件，可点击“在编辑器打开”查看。');
  }
}
