import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConfigService, isPathInsideRoot, toErrorMessage } from './config';
import type { Logger } from './logger';
import type { ExtensionConfigFile } from './types';
import type { Uploader } from './uploader';

interface WebviewMessage {
  type?: string;
  config?: unknown;
  profileName?: unknown;
  revision?: unknown;
}

export class ConfigPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private folder: vscode.WorkspaceFolder | undefined;
  private messageDisposable: vscode.Disposable | undefined;
  private writeQueue = Promise.resolve();
  private deletionRevision = 0;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly configService: ConfigService,
    private readonly uploader: Uploader,
    private readonly logger: Logger,
    private readonly onConfigSaved: (folder: vscode.WorkspaceFolder) => Promise<void>,
  ) {}

  public async show(folder: vscode.WorkspaceFolder): Promise<void> {
    if (this.panel && this.folder?.uri.toString() === folder.uri.toString()) {
      this.panel.reveal(vscode.ViewColumn.One);
      await this.postState();
      return;
    }

    this.panel?.dispose();
    this.folder = folder;
    this.panel = vscode.window.createWebviewPanel(
      'sftpFtpUploader.configPanel',
      `传输配置 · ${folder.name}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      },
    );
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.messageDisposable = this.panel.webview.onDidReceiveMessage((message: WebviewMessage) =>
      void this.handleMessage(message));
    this.panel.onDidDispose(() => {
      this.messageDisposable?.dispose();
      this.messageDisposable = undefined;
      this.panel = undefined;
      this.folder = undefined;
    });
  }

  public dispose(): void {
    this.messageDisposable?.dispose();
    this.panel?.dispose();
  }

  public async deleteSavedProfile(folderUri: vscode.Uri, profileName: string): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(folderUri);
    if (!folder || folder.uri.toString() !== folderUri.toString()) {
      throw new Error('该服务器所属的工作区已关闭。');
    }
    if (!await this.confirmDelete(folder, profileName)) {
      return;
    }

    await this.enqueueWrite(async () => {
      await this.configService.deleteProfile(folder, profileName);
      if (this.folder?.uri.toString() === folderUri.toString()) {
        await this.post({ type: 'profileDeleted', profileName, revision: ++this.deletionRevision });
      }
      await this.onConfigSaved(folder);
    });
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (!this.panel || !this.folder || typeof message.type !== 'string') {
      return;
    }

    try {
      switch (message.type) {
        case 'ready':
        case 'reload':
          await this.postState();
          break;
        case 'save':
          await this.save(message);
          break;
        case 'confirmDelete':
          await this.confirmDraftDeletion(message.profileName);
          break;
        case 'test':
          await this.test(message.config, message.profileName);
          break;
        case 'openJson':
          await this.configService.openConfig(this.folder);
          break;
        case 'pickPrivateKey':
          await this.pickPrivateKey(message.profileName);
          break;
        case 'pickLocalPath':
          await this.pickLocalPath(message.profileName);
          break;
      }
    } catch (error) {
      const text = toErrorMessage(error);
      this.logger.error(`配置页面：${text}`);
      await this.post({ type: 'operationError', operation: message.type, message: text });
    }
  }

  private async save(message: WebviewMessage): Promise<void> {
    const panel = this.panel;
    const folder = this.folder!;
    const config = message.config as ExtensionConfigFile;
    const profileName = typeof message.profileName === 'string' ? message.profileName : '';
    await this.enqueueWrite(async () => {
      if (panel !== this.panel) return;
      if (message.revision !== this.deletionRevision) {
        throw new Error('服务器列表已更新，请再次保存配置。');
      }
      await this.configService.saveConfig(folder, config);
      const activeProfile = Object.hasOwn(config.profiles, profileName) ? profileName : undefined;
      await this.configService.setActiveProfile(folder, activeProfile);
      await this.onConfigSaved(folder);
      this.logger.info(`已从配置页面保存：${this.configService.getConfigUri(folder).fsPath}`);
      if (panel === this.panel) {
        await this.post({ type: 'saved', savedAt: new Date().toISOString(), profileName });
      }
    });
  }

  private async confirmDraftDeletion(profileName: unknown): Promise<void> {
    const panel = this.panel;
    if (typeof profileName === 'string' && profileName && await this.confirmDelete(this.folder!, profileName) && panel === this.panel) {
      await this.post({ type: 'deleteConfirmed', profileName });
    }
  }

  private async confirmDelete(folder: vscode.WorkspaceFolder, profileName: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      `删除工作区「${folder.name}」中的环境「${profileName}」？`,
      { modal: true },
      '删除环境',
    );
    return choice === '删除环境';
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async test(configValue: unknown, profileNameValue: unknown): Promise<void> {
    const config = configValue as ExtensionConfigFile;
    const profileName = typeof profileNameValue === 'string' ? profileNameValue : '';
    await this.post({ type: 'testing', profileName });
    try {
      const loaded = this.configService.createLoadedProfile(this.folder!, config, profileName);
      await this.uploader.testConnection(loaded);
      await this.post({
        type: 'testResult',
        ok: true,
        profileName,
        message: `${loaded.profile.protocol.toUpperCase()} ${loaded.profile.host}:${loaded.profile.port} 连接成功`,
      });
    } catch (error) {
      const text = toErrorMessage(error);
      this.logger.error(`连接测试失败：${text}`);
      await this.post({ type: 'testResult', ok: false, profileName, message: text });
    }
  }

  private async pickPrivateKey(profileNameValue: unknown): Promise<void> {
    const profileName = typeof profileNameValue === 'string' ? profileNameValue : '';
    const selected = await vscode.window.showOpenDialog({
      title: '选择 SFTP 私钥',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: '选择私钥',
    });
    if (selected?.[0]) {
      await this.post({ type: 'privateKeyPicked', profileName, path: selected[0].fsPath });
    }
  }

  private async pickLocalPath(profileNameValue: unknown): Promise<void> {
    const profileName = typeof profileNameValue === 'string' ? profileNameValue : '';
    const selected = await vscode.window.showOpenDialog({
      title: '选择项目上传目录',
      defaultUri: this.folder!.uri,
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '使用此目录',
    });
    if (!selected?.[0]) {
      return;
    }
    if (!isPathInsideRoot(this.folder!.uri.fsPath, selected[0].fsPath)) {
      throw new Error('项目上传目录必须位于当前工作区内。');
    }
    const relativePath = path.relative(this.folder!.uri.fsPath, selected[0].fsPath)
      .split(path.sep)
      .join('/');
    await this.post({
      type: 'localPathPicked',
      profileName,
      path: relativePath || '.',
    });
  }

  private async postState(): Promise<void> {
    const folder = this.folder;
    const panel = this.panel;
    if (!folder) return;
    await this.enqueueWrite(async () => {
      if (panel !== this.panel) return;
      const config = await this.configService.readConfig(folder, true);
      if (panel !== this.panel) return;
      await this.post({
        type: 'state',
        config,
        activeProfile: this.configService.getActiveProfileName(folder, config),
        workspaceName: folder.name,
        configPath: this.configService.getConfigUri(folder).fsPath,
        revision: this.deletionRevision,
      });
    });
  }

  private async post(message: unknown): Promise<void> {
    await this.panel?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'config.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'config.js'));
    return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <title>SFTP / FTP 配置</title>
  </head>
  <body>
    <div id="app" class="app-shell" aria-busy="true">
      <div class="boot-screen">
        <span class="boot-pulse"></span>
        <p>正在读取传输配置…</p>
      </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
