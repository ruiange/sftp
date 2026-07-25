import * as vscode from 'vscode';
import type { ConfigService } from './config';

class TransferItem extends vscode.TreeItem {
  public constructor(
    label: string,
    options: {
      description?: string;
      icon?: string;
      tooltip?: string;
      command?: string;
      children?: TransferItem[];
    } = {},
  ) {
    super(
      label,
      options.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    this.description = options.description;
    this.tooltip = options.tooltip;
    this.iconPath = options.icon ? new vscode.ThemeIcon(options.icon) : undefined;
    this.command = options.command
      ? { command: options.command, title: label }
      : undefined;
    this.children = options.children;
  }

  public readonly children?: TransferItem[];
}

export class TransferViewProvider implements vscode.TreeDataProvider<TransferItem>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<TransferItem | undefined | void>();
  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly configService: ConfigService) {}

  public refresh(): void {
    this.changeEmitter.fire();
  }

  public getTreeItem(element: TransferItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: TransferItem): Promise<TransferItem[]> {
    if (element?.children) {
      return element.children;
    }
    if (element) {
      return [];
    }

    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      return [
        new TransferItem('尚未打开工作区', {
          icon: 'warning',
          tooltip: '打开一个文件夹后即可配置上传连接。',
        }),
      ];
    }

    const connectionItems: TransferItem[] = [];
    try {
      const config = await this.configService.readConfig(folder);
      const activeName = this.configService.getActiveProfileName(folder, config);
      const profile = config.profiles[activeName];
      const port = profile.port ?? (profile.protocol === 'sftp' ? 22 : profile.secure === 'implicit' ? 990 : 21);
      connectionItems.push(
        new TransferItem(activeName, {
          description: `${profile.protocol.toUpperCase()} · ${profile.host}:${port}`,
          icon: 'server-environment',
          tooltip: `当前环境：${activeName}\n路径映射：${profile.localPath ?? '.'} → ${profile.remotePath}\n点击切换环境`,
          command: 'sftpFtpUploader.selectProfile',
        }),
        new TransferItem(profile.localPath ?? '.', {
          description: '项目上传目录',
          icon: 'folder',
          tooltip: `工作区内：${profile.localPath ?? '.'}`,
        }),
        new TransferItem(profile.remotePath, {
          description: '远程目录',
          icon: 'remote-explorer',
          tooltip: profile.remotePath,
        }),
      );
    } catch {
      connectionItems.push(
        new TransferItem('尚未配置连接', {
          description: '点击开始配置',
          icon: 'warning',
          command: 'sftpFtpUploader.openConfig',
        }),
      );
    }

    return [
      new TransferItem('当前连接', { children: connectionItems }),
      new TransferItem('快捷操作', {
        children: [
          action('打开配置页面', 'settings-gear', 'sftpFtpUploader.openConfig'),
          action('上传当前文件', 'cloud-upload', 'sftpFtpUploader.uploadCurrentFile'),
          action('上传整个工作区', 'folder-opened', 'sftpFtpUploader.uploadWorkspace'),
          action('切换上传环境', 'arrow-swap', 'sftpFtpUploader.selectProfile'),
          action('测试当前连接', 'plug', 'sftpFtpUploader.testConnection'),
          action('显示上传日志', 'output', 'sftpFtpUploader.showOutput'),
        ],
      }),
    ];
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  private currentWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    return (activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined)
      ?? vscode.workspace.workspaceFolders?.[0];
  }
}

function action(label: string, icon: string, command: string): TransferItem {
  return new TransferItem(label, { icon, command });
}
