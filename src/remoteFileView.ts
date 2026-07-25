import * as path from 'node:path';
import * as vscode from 'vscode';
import { createRemoteClient } from './clients';
import type { RemoteFileEntry } from './clients/remoteClient';
import type { ConfigService } from './config';
import { toErrorMessage } from './config';
import type { Logger } from './logger';
import type { LoadedProfile } from './types';

class RemoteFileItem extends vscode.TreeItem {
  public constructor(
    label: string,
    public readonly remotePath: string,
    public readonly entryType: 'file' | 'directory' | 'link' | 'message',
    options: {
      description?: string;
      tooltip?: string;
      icon?: string;
      command?: string;
      expanded?: boolean;
    } = {},
  ) {
    super(
      label,
      entryType === 'directory'
        ? options.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.description = options.description;
    this.tooltip = options.tooltip;
    this.iconPath = new vscode.ThemeIcon(options.icon ?? iconForType(entryType));
    this.command = options.command
      ? { command: options.command, title: label }
      : undefined;
    this.contextValue = options.expanded && entryType === 'directory'
      ? 'remote-root'
      : `remote-${entryType}`;
  }
}

export class RemoteFileViewProvider
implements vscode.TreeDataProvider<RemoteFileItem>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<RemoteFileItem | undefined | void>();
  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(
    private readonly configService: ConfigService,
    private readonly logger: Logger,
  ) {}

  public refresh(): void {
    this.changeEmitter.fire();
  }

  public async deleteRemoteItem(item: unknown): Promise<void> {
    if (!(item instanceof RemoteFileItem)
      || !['file', 'directory', 'link'].includes(item.entryType)) {
      throw new Error('请选择需要删除的远程文件或目录。');
    }

    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      throw new Error('请先打开一个工作区。');
    }
    const loaded = await this.configService.load(folder);
    this.assertDeletablePath(loaded.profile.remotePath, item.remotePath);

    const isDirectory = item.entryType === 'directory';
    const warning = isDirectory
      ? `确定删除远端目录“${item.label}”吗？目录内的全部文件和子目录也会被永久删除。`
      : `确定删除远端文件“${item.label}”吗？此操作无法撤销。`;
    const confirmed = await vscode.window.showWarningMessage(
      warning,
      { modal: true },
      '删除',
    );
    if (confirmed !== '删除') {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在删除远端${isDirectory ? '目录' : '文件'}：${item.label}`,
        cancellable: false,
      },
      () => this.deleteEntry(loaded, item.remotePath, isDirectory),
    );
    this.logger.info(`已删除远端${isDirectory ? '目录' : '文件'}：${item.remotePath}`);
    this.refresh();
    void vscode.window.showInformationMessage(`已删除远端${isDirectory ? '目录' : '文件'}：${item.label}`);
  }

  public getTreeItem(element: RemoteFileItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: RemoteFileItem): Promise<RemoteFileItem[]> {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      return [messageItem('请先打开一个工作区', 'warning')];
    }

    let loaded: LoadedProfile;
    try {
      loaded = await this.configService.load(folder);
    } catch (error) {
      return [
        new RemoteFileItem('尚未配置远程连接', '', 'message', {
          description: toErrorMessage(error),
          icon: 'warning',
          command: 'sftpFtpUploader.openConfig',
        }),
      ];
    }

    if (!element) {
      return [
        new RemoteFileItem(
          loaded.profile.remotePath,
          loaded.profile.remotePath,
          'directory',
          {
            description: `${loaded.profile.name} · ${loaded.profile.protocol.toUpperCase()}`,
            tooltip: `${loaded.profile.host}:${loaded.profile.port}\n${loaded.profile.remotePath}`,
            icon: 'remote-explorer',
            expanded: true,
          },
        ),
      ];
    }

    if (element.entryType !== 'directory') {
      return [];
    }

    try {
      const entries = await this.listDirectory(loaded, element.remotePath);
      if (entries.length === 0) {
        return [messageItem('此目录为空', 'info')];
      }
      return entries.map((entry) => this.toTreeItem(entry));
    } catch (error) {
      const message = toErrorMessage(error);
      this.logger.error(`读取远程目录失败 ${element.remotePath}：${message}`);
      return [
        new RemoteFileItem('无法读取此目录', element.remotePath, 'message', {
          description: message,
          icon: 'error',
          command: 'sftpFtpUploader.refreshRemoteFiles',
        }),
      ];
    }
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  private async listDirectory(
    loaded: LoadedProfile,
    remotePath: string,
  ): Promise<RemoteFileEntry[]> {
    const client = createRemoteClient(loaded.profile.protocol);
    this.logger.info(`读取远程目录：${remotePath}（环境：${loaded.profile.name}）`);
    try {
      await client.connect(loaded.profile);
      const entries = await client.listDirectory(remotePath);
      return entries.sort((left, right) => {
        if (left.type === 'directory' && right.type !== 'directory') {
          return -1;
        }
        if (left.type !== 'directory' && right.type === 'directory') {
          return 1;
        }
        return left.name.localeCompare(right.name);
      });
    } finally {
      try {
        await client.disconnect();
      } catch (error) {
        this.logger.error(`关闭远程目录连接失败：${toErrorMessage(error)}`);
      }
    }
  }

  private async deleteEntry(
    loaded: LoadedProfile,
    remotePath: string,
    isDirectory: boolean,
  ): Promise<void> {
    const client = createRemoteClient(loaded.profile.protocol);
    try {
      await client.connect(loaded.profile);
      if (isDirectory) {
        await client.deleteDirectory(remotePath);
      } else {
        await client.deleteFile(remotePath);
      }
    } finally {
      try {
        await client.disconnect();
      } catch (error) {
        this.logger.error(`关闭远程删除连接失败：${toErrorMessage(error)}`);
      }
    }
  }

  private assertDeletablePath(remoteRoot: string, targetPath: string): void {
    const root = normalizeRemotePath(remoteRoot);
    const target = normalizeRemotePath(targetPath);
    const relativePath = path.posix.relative(root, target);
    const isInsideRoot = relativePath !== ''
      && relativePath !== '..'
      && !relativePath.startsWith('../')
      && !path.posix.isAbsolute(relativePath);
    if (!isInsideRoot) {
      throw new Error('只能删除远端部署路径内的文件或目录，不能删除部署根目录。');
    }
  }

  private toTreeItem(entry: RemoteFileEntry): RemoteFileItem {
    const modified = entry.modifiedAt
      ? new Date(entry.modifiedAt).toLocaleString('zh-CN', { hour12: false })
      : '未知';
    const description = entry.type === 'directory' ? undefined : formatBytes(entry.size);
    return new RemoteFileItem(entry.name, entry.path, entry.type, {
      description,
      tooltip: `${entry.path}\n大小：${formatBytes(entry.size)}\n修改时间：${modified}`,
    });
  }

  private currentWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    return (activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined)
      ?? vscode.workspace.workspaceFolders?.[0];
  }
}

function messageItem(label: string, icon: string): RemoteFileItem {
  return new RemoteFileItem(label, '', 'message', { icon });
}

function iconForType(type: RemoteFileItem['entryType']): string {
  if (type === 'directory') {
    return 'folder';
  }
  if (type === 'link') {
    return 'file-symlink-file';
  }
  if (type === 'file') {
    return 'file';
  }
  return 'info';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

function normalizeRemotePath(remotePath: string): string {
  const normalized = path.posix.normalize(remotePath.replace(/\\/g, '/'));
  if (normalized === '/') {
    return normalized;
  }
  return normalized.replace(/\/+$/, '');
}
