import { lstat } from 'node:fs/promises';
import { posix } from 'node:path';
import * as vscode from 'vscode';
import type { RemoteFileEntry } from './clients/remoteClient';
import { toErrorMessage } from './config';
import type { Logger } from './logger';
import {
  isRemoteName, REMOTE_FILE_SCHEME, REMOTE_SERVER_FILE_SCHEME,
  type RemoteFileSystem,
} from './remoteFileSystem';
import type { LoadedProfile } from './types';

export type RemoteFileItem = {
  label: string;
  remotePath: string;
  entryType: RemoteFileEntry['type'];
  remoteUri: vscode.Uri;
};

export class RemoteFileActions {
  public constructor(
    private readonly logger: Logger,
    private readonly fileSystem: RemoteFileSystem,
  ) {}

  public async openRemoteFile(item: RemoteFileItem): Promise<void> {
    if (item.entryType !== 'file') {
      throw new Error('请选择要打开的远程文件。');
    }
    await this.loadItemProfile(item);
    await vscode.commands.executeCommand('vscode.open', item.remoteUri, { preview: false });
  }

  public async createRemoteItem(item: RemoteFileItem, kind: 'file' | 'directory'): Promise<void> {
    if (item.entryType !== 'directory') {
      throw new Error('请选择新建项目所在的远程目录。');
    }
    ensureWritable(item.remoteUri);
    await this.loadItemProfile(item);
    const label = kind === 'file' ? '文件' : '目录';
    const name = await promptName(`新建远程${label}`, `在 ${item.remotePath} 中输入${label}名`);
    if (!name) {
      return;
    }
    const uri = this.fileSystem.childUri(item.remoteUri, name);
    if (kind === 'directory') {
      await this.fileSystem.createDirectory(uri);
    } else {
      await this.fileSystem.writeFile(uri, new Uint8Array(), { create: true, overwrite: false });
      await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
    }
  }

  public async renameRemoteItem(item: RemoteFileItem): Promise<void> {
    if (item.remoteUri.path === '/'
      || (item.entryType !== 'file' && item.entryType !== 'directory')) {
      throw new Error('请选择要重命名的远程文件或子目录。');
    }
    ensureWritable(item.remoteUri);
    await this.loadItemProfile(item);
    const currentName = posix.basename(item.remoteUri.path);
    const name = await promptName('重命名远程项目', item.remotePath, currentName);
    if (!name || name === currentName) {
      return;
    }
    ensureNoUnsavedEdits(item.remoteUri);
    const parent = item.remoteUri.with({ path: posix.dirname(item.remoteUri.path) });
    const next = this.fileSystem.childUri(parent, name);
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(item.remoteUri, next, { overwrite: false });
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new Error('重命名失败，请确认目标名称未被占用且远程目录可写。');
    }
  }

  public async uploadFiles(item: RemoteFileItem, replaceFile = false): Promise<void> {
    if (item.entryType !== (replaceFile ? 'file' : 'directory')) {
      throw new Error(replaceFile ? '请选择需要替换的服务器文件。' : '请选择上传文件的服务器目录。');
    }
    const loaded = await this.loadItemProfile(item);
    const selected = await vscode.window.showOpenDialog({
      title: replaceFile ? `选择替换“${item.label}”的本地文件` : `选择上传到 ${item.remotePath} 的本地文件`,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: !replaceFile,
      defaultUri: loaded.workspaceFolder.uri,
      openLabel: replaceFile ? '选择替换文件' : '选择上传文件',
    });
    if (!selected?.length) {
      return;
    }

    const plans: {
      localPath: string;
      uri: vscode.Uri;
      remotePath: string;
      expected?: RemoteFileEntry;
    }[] = [];
    const targets = new Set<string>();
    for (const local of selected) {
      if (local.scheme !== 'file' || !(await lstat(local.fsPath)).isFile()) {
        throw new Error('只能上传本地普通文件，不支持目录或符号链接。');
      }
      const name = local.path.split('/').pop() ?? '';
      const uri = replaceFile ? item.remoteUri : this.fileSystem.childUri(item.remoteUri, name);
      if (targets.has(uri.toString())) {
        throw new Error('选择的多个本地文件存在同名目标，请分开上传。');
      }
      targets.add(uri.toString());
      const expected = await this.fileSystem.inspectUploadTarget(uri);
      if (replaceFile && !expected) {
        throw new Error('要替换的服务器文件已不存在，请刷新后重新选择。');
      }
      const remotePath = replaceFile ? item.remotePath : posix.join(item.remotePath, name);
      plans.push({ localPath: local.fsPath, uri, remotePath, expected });
    }

    const { profile } = loaded;
    const overwriteCount = plans.filter((plan) => plan.expected).length;
    const action = overwriteCount ? '上传并替换' : '上传';
    const confirmed = await vscode.window.showWarningMessage(
      overwriteCount ? `上传 ${plans.length} 个文件，其中 ${overwriteCount} 个将替换服务器上的同名文件？`
        : `上传 ${plans.length} 个文件到服务器？`,
      {
        modal: true,
        detail: `${profile.name} · ${profile.protocol.toUpperCase()} ${profile.host}:${profile.port}\n`
          + plans.map((plan) => `${plan.localPath}\n→ ${plan.remotePath}${plan.expected ? '（替换）' : '（新文件）'}`).join('\n\n')
          + (overwriteCount ? '\n\n替换会覆盖原文件内容，无法通过插件撤销。' : ''),
      },
      action,
    );
    if (confirmed !== action) {
      return;
    }

    let uploaded = 0;
    let stopped = false;
    let currentPath = '';
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '上传服务器文件',
        cancellable: true,
      }, async (progress, token) => {
        for (const plan of plans) {
          if (token.isCancellationRequested) {
            stopped = true;
            break;
          }
          currentPath = plan.remotePath;
          progress.report({ message: `${uploaded + 1}/${plans.length} · ${plan.remotePath}（取消将在当前文件完成后停止）` });
          await this.fileSystem.uploadFile(plan.uri, plan.localPath, plan.expected);
          uploaded += 1;
          progress.report({ increment: 100 / plans.length });
        }
      });
    } catch (error) {
      throw new Error(`上传中断，已确认完成 ${uploaded}/${plans.length} 个文件。\n当前文件：${currentPath}\n${toErrorMessage(error)}\n请刷新目录核对当前文件状态，未自动重试。`);
    }
    void vscode.window.showInformationMessage(`已上传 ${uploaded} 个服务器文件${stopped ? '，已取消后续上传' : ''}。`);
  }

  public async deleteRemoteItem(item: RemoteFileItem): Promise<void> {
    const server = item.remoteUri.scheme === REMOTE_SERVER_FILE_SCHEME;
    if (!server) {
      ensureWritable(item.remoteUri);
    }
    if (item.remoteUri.path === '/') {
      throw new Error(server ? '不能删除服务器根目录。' : '不能删除远端部署根目录。');
    }

    const loaded = await this.loadItemProfile(item);
    const expected = server ? await this.fileSystem.inspectServerItem(item.remoteUri) : undefined;
    if (expected && expected.type !== item.entryType) {
      throw new Error('服务器项目类型已变更，请刷新后重新选择。');
    }
    const { profile } = loaded;
    const kind = item.entryType === 'directory' ? '目录' : item.entryType === 'link' ? '链接' : '文件';
    const consequence = item.entryType === 'directory'
      ? '目录内的全部文件和子目录也会被永久删除。'
      : '此操作无法撤销。';
    const confirmed = await vscode.window.showWarningMessage(
      `确定删除远端${kind}“${item.label}”吗？`,
      {
        modal: true,
        detail: `${profile.name} · ${profile.protocol.toUpperCase()} ${profile.host}:${profile.port}\n${item.remotePath}\n\n${consequence}`,
      },
      '删除',
    );
    if (confirmed !== '删除') {
      return;
    }

    ensureNoUnsavedEdits(item.remoteUri);
    const { remoteUri, entryType } = item;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在删除远端${kind}：${item.label}`,
        cancellable: false,
      },
      () => this.fileSystem.deleteConfirmed(remoteUri, entryType, expected),
    );
    this.logger.info(`已删除远端${kind}：${item.remotePath}（环境：${profile.name}）`);
    void vscode.window.showInformationMessage(`已删除远端${kind}：${item.label}`);
  }

  private loadItemProfile(item: RemoteFileItem): Promise<LoadedProfile> {
    return this.fileSystem.resolveProfile(item.remoteUri);
  }
}

function promptName(title: string, prompt: string, value?: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt,
    value,
    ignoreFocusOut: true,
    validateInput: (name) => name.trim() && isRemoteName(name) ? undefined : '请输入有效名称，不能包含路径分隔符或控制字符。',
  });
}

function ensureNoUnsavedEdits(uri: vscode.Uri): void {
  const dirty = vscode.workspace.textDocuments.some((document) => document.isDirty
    && document.uri.scheme === uri.scheme && document.uri.authority === uri.authority
    && (document.uri.path === uri.path || document.uri.path.startsWith(`${uri.path}/`)));
  if (dirty) {
    throw new Error('该项目中有未保存的远程文件，请先保存或关闭相关编辑器。');
  }
}

function ensureWritable(uri: vscode.Uri): void {
  if (uri.scheme !== REMOTE_FILE_SCHEME) {
    throw new Error('请切换到部署目录后再编辑、新建或重命名文件。');
  }
}
