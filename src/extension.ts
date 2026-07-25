import * as vscode from 'vscode';
import { ConfigService, isPathInsideRoot, resolveLocalUploadRoot, toErrorMessage } from './config';
import { ConfigPanel } from './configPanel';
import { Logger } from './logger';
import { RemoteFileViewProvider } from './remoteFileView';
import type { LoadedProfile, UploadResult } from './types';
import { TransferViewProvider } from './transferView';
import { Uploader } from './uploader';

class ExtensionController implements vscode.Disposable {
  private readonly configService: ConfigService;
  private readonly logger: Logger;
  private readonly uploader: Uploader;
  private readonly configPanel: ConfigPanel;
  private readonly transferView: TransferViewProvider;
  private readonly remoteFileView: RemoteFileViewProvider;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private uploadQueue: Promise<void> = Promise.resolve();
  private activeOperations = 0;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.configService = new ConfigService(context);
    this.logger = new Logger();
    this.uploader = new Uploader(this.logger);
    this.transferView = new TransferViewProvider(this.configService);
    this.remoteFileView = new RemoteFileViewProvider(this.configService, this.logger);
    this.configPanel = new ConfigPanel(
      context.extensionUri,
      this.configService,
      this.uploader,
      this.logger,
      async (folder) => {
        await this.refreshStatusBar(folder);
        this.transferView.refresh();
        this.remoteFileView.refresh();
      },
    );
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
    this.statusBar.command = 'sftpFtpUploader.selectProfile';

    this.registerCommands();
    this.disposables.push(
      this.logger,
      this.configPanel,
      this.transferView,
      this.remoteFileView,
      this.statusBar,
      vscode.window.registerTreeDataProvider('sftpFtpUploader.controlView', this.transferView),
      vscode.window.registerTreeDataProvider('sftpFtpUploader.remoteFilesView', this.remoteFileView),
      vscode.workspace.onDidSaveTextDocument((document) => void this.handleSave(document)),
      vscode.window.onDidChangeActiveTextEditor(() => {
        void this.refreshStatusBar();
        this.transferView.refresh();
        this.remoteFileView.refresh();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.refreshStatusBar();
        this.transferView.refresh();
        this.remoteFileView.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('sftpFtpUploader')) {
          void this.refreshStatusBar();
          this.transferView.refresh();
          this.remoteFileView.refresh();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.fsPath.endsWith(this.configService.configFileName)) {
          void this.refreshStatusBar();
          this.transferView.refresh();
          this.remoteFileView.refresh();
        }
      }),
    );

    void this.refreshStatusBar();
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private registerCommands(): void {
    const register = (command: string, callback: (...args: unknown[]) => unknown): void => {
      this.disposables.push(vscode.commands.registerCommand(command, callback));
    };

    register('sftpFtpUploader.upload', (resource, selectedResources) =>
      this.runCommand(() => this.uploadResourcesFromExplorer(resource, selectedResources)));
    register('sftpFtpUploader.uploadCurrentFile', () =>
      this.runCommand(() => this.uploadCurrentFile()));
    register('sftpFtpUploader.uploadWorkspace', (resource) =>
      this.runCommand(() => this.uploadWorkspace(asUri(resource))));
    register('sftpFtpUploader.initialize', () =>
      this.runCommand(() => this.initialize()));
    register('sftpFtpUploader.openConfig', () =>
      this.runCommand(() => this.openConfig()));
    register('sftpFtpUploader.editConfigJson', () =>
      this.runCommand(() => this.editConfigJson()));
    register('sftpFtpUploader.selectProfile', () =>
      this.runCommand(() => this.selectProfile()));
    register('sftpFtpUploader.testConnection', () =>
      this.runCommand(() => this.testConnection()));
    register('sftpFtpUploader.showOutput', () => this.logger.show());
    register('sftpFtpUploader.refreshRemoteFiles', () => this.remoteFileView.refresh());
    register('sftpFtpUploader.deleteRemoteItem', (item) =>
      this.runCommand(() => this.remoteFileView.deleteRemoteItem(item)));
  }

  private async uploadResourcesFromExplorer(resource: unknown, selectedResources: unknown): Promise<void> {
    const selected = asUriArray(selectedResources);
    const primary = asUri(resource);
    const resources = selected.length > 0 ? selected : primary ? [primary] : [];
    if (resources.length === 0) {
      await this.uploadCurrentFile();
      return;
    }
    await this.enqueueUpload(() => this.uploadResources(resources, true));
  }

  private async uploadCurrentFile(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
      throw new Error('当前没有可上传的本地文件。');
    }
    await this.enqueueUpload(() => this.uploadResources([uri], true));
  }

  private async uploadWorkspace(resource?: vscode.Uri): Promise<void> {
    const folder = await this.configService.chooseWorkspaceFolder(resource);
    if (!folder) {
      return;
    }
    const loaded = await this.configService.load(folder);
    const uploadRoot = resolveLocalUploadRoot(folder.uri.fsPath, loaded.profile.localPath);
    await this.enqueueUpload(() => this.uploadResources([vscode.Uri.file(uploadRoot)], true));
  }

  private async uploadResources(resources: vscode.Uri[], manual: boolean): Promise<void> {
    const grouped = new Map<string, { folder: vscode.WorkspaceFolder; resources: vscode.Uri[] }>();
    for (const resource of resources) {
      const folder = vscode.workspace.getWorkspaceFolder(resource);
      if (!folder) {
        throw new Error(`文件不在已打开的工作区内：${resource.fsPath}`);
      }
      const key = folder.uri.toString();
      const group = grouped.get(key) ?? { folder, resources: [] };
      group.resources.push(resource);
      grouped.set(key, group);
    }

    const operation = async (
      progress: vscode.Progress<{ message?: string; increment?: number }>,
      token: vscode.CancellationToken,
    ): Promise<UploadResult> => {
      const total: UploadResult = { uploaded: 0, skipped: 0, bytes: 0 };
      for (const group of grouped.values()) {
        if (token.isCancellationRequested) {
          break;
        }
        const loaded = await this.configService.load(group.folder);
        const result = await this.uploader.upload(loaded, group.resources, progress, token);
        total.uploaded += result.uploaded;
        total.skipped += result.skipped;
        total.bytes += result.bytes;
      }
      return total;
    };

    const result = await vscode.window.withProgress(
      {
        location: manual ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
        title: 'SFTP / FTP 上传',
        cancellable: manual,
      },
      operation,
    );

    if (manual) {
      const message = result.uploaded === 0
        ? `没有需要上传的文件${result.skipped > 0 ? `，已跳过 ${result.skipped} 项` : ''}。`
        : `上传完成：${result.uploaded} 个文件，共 ${formatBytes(result.bytes)}${result.skipped > 0 ? `，跳过 ${result.skipped} 项` : ''}。`;
      if (result.uploaded === 0 || this.showSuccessNotification) {
        void vscode.window.showInformationMessage(message);
      }
    }
  }

  private async handleSave(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') {
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
      return;
    }

    try {
      const loaded = await this.configService.load(folder);
      if (!loaded.profile.uploadOnSave) {
        return;
      }
      const uploadRoot = resolveLocalUploadRoot(folder.uri.fsPath, loaded.profile.localPath);
      if (!isPathInsideRoot(uploadRoot, document.uri.fsPath)) {
        return;
      }
      await this.enqueueUpload(() => this.uploadResources([document.uri], false));
    } catch (error) {
      const message = toErrorMessage(error);
      this.logger.error(`保存时自动上传失败：${message}`);
      vscode.window.setStatusBarMessage(`$(error) 自动上传失败：${message}`, 5_000);
    }
  }

  private async initialize(): Promise<void> {
    const folder = await this.configService.chooseWorkspaceFolder();
    if (!folder) {
      return;
    }
    await this.configService.initialize(folder);
    await this.configPanel.show(folder);
    await this.refreshStatusBar(folder);
    this.transferView.refresh();
    this.remoteFileView.refresh();
  }

  private async openConfig(): Promise<void> {
    const folder = await this.configService.chooseWorkspaceFolder(vscode.window.activeTextEditor?.document.uri);
    if (!folder) {
      return;
    }
    await this.configPanel.show(folder);
  }

  private async editConfigJson(): Promise<void> {
    const folder = await this.configService.chooseWorkspaceFolder(vscode.window.activeTextEditor?.document.uri);
    if (!folder) {
      return;
    }
    await this.configService.openConfig(folder);
  }

  private async selectProfile(): Promise<void> {
    const folder = await this.configService.chooseWorkspaceFolder(vscode.window.activeTextEditor?.document.uri);
    if (!folder) {
      return;
    }
    const profile = await this.configService.selectProfile(folder);
    if (profile) {
      void vscode.window.showInformationMessage(`已切换到上传环境：${profile.name}`);
      await this.refreshStatusBar(folder);
      this.transferView.refresh();
      this.remoteFileView.refresh();
    }
  }

  private async testConnection(): Promise<void> {
    const folder = await this.configService.chooseWorkspaceFolder(vscode.window.activeTextEditor?.document.uri);
    if (!folder) {
      return;
    }
    const loaded = await this.configService.load(folder);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在测试 ${loaded.profile.name} 连接…`,
        cancellable: false,
      },
      () => this.uploader.testConnection(loaded),
    );
    void vscode.window.showInformationMessage(
      `${loaded.profile.protocol.toUpperCase()} 连接测试成功：${loaded.profile.host}:${loaded.profile.port}`,
    );
  }

  private async refreshStatusBar(preferredFolder?: vscode.WorkspaceFolder): Promise<void> {
    if (!vscode.workspace.getConfiguration('sftpFtpUploader').get<boolean>('showStatusBar', true)) {
      this.statusBar.hide();
      return;
    }

    const folder = preferredFolder
      ?? (vscode.window.activeTextEditor
        ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
        : undefined)
      ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.statusBar.hide();
      return;
    }

    try {
      const loaded = await this.configService.load(folder);
      this.setStatusBarProfile(loaded);
    } catch {
      this.statusBar.text = '$(cloud-upload) SFTP / FTP：未配置';
      this.statusBar.tooltip = '点击初始化或选择上传配置';
      this.statusBar.command = 'sftpFtpUploader.openConfig';
    }
    this.statusBar.show();
  }

  private setStatusBarProfile(loaded: LoadedProfile): void {
    const busy = this.activeOperations > 0 ? '$(sync~spin)' : '$(cloud-upload)';
    this.statusBar.text = `${busy} ${loaded.profile.name}`;
    this.statusBar.tooltip = [
      `${loaded.profile.protocol.toUpperCase()} ${loaded.profile.host}:${loaded.profile.port}`,
      `路径映射：${loaded.profile.localPath} → ${loaded.profile.remotePath}`,
      loaded.profile.uploadOnSave ? '保存时自动上传：已开启' : '保存时自动上传：已关闭',
      '点击切换上传环境',
    ].join('\n');
    this.statusBar.command = 'sftpFtpUploader.selectProfile';
  }

  private async enqueueUpload<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.uploadQueue.then(operation, operation);
    this.uploadQueue = run.then(() => undefined, () => undefined);
    this.activeOperations += 1;
    await this.refreshStatusBar();
    try {
      return await run;
    } finally {
      this.activeOperations -= 1;
      await this.refreshStatusBar();
    }
  }

  private async runCommand(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      const message = toErrorMessage(error);
      this.logger.error(message);
      const actions = message.includes('未找到配置文件')
        ? ['初始化配置', '查看日志']
        : ['查看日志'];
      const action = await vscode.window.showErrorMessage(`SFTP / FTP：${message}`, ...actions);
      if (action === '初始化配置') {
        await this.initialize();
        return;
      }
      if (action === '查看日志') {
        this.logger.show();
      }
    }
  }

  private get showSuccessNotification(): boolean {
    return vscode.workspace
      .getConfiguration('sftpFtpUploader')
      .get<boolean>('showSuccessNotification', true);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new ExtensionController(context);
  context.subscriptions.push(controller);
}

export function deactivate(): void {}

function asUri(value: unknown): vscode.Uri | undefined {
  return value instanceof vscode.Uri ? value : undefined;
}

function asUriArray(value: unknown): vscode.Uri[] {
  return Array.isArray(value) ? value.filter((item): item is vscode.Uri => item instanceof vscode.Uri) : [];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}
