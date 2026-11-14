import { randomBytes } from 'node:crypto';
import { basename, posix, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import {
  defaultPort, isPathInsideRoot, normalizeLocalPath, normalizeRemoteRoot,
  resolveLocalUploadRoot, resolveProfileValue, type ConfigService,
} from './config';
import type { UploadProfile } from './types';

export type UploadFeedback = {
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  message: string;
};

type TransferTarget = {
  folder?: vscode.WorkspaceFolder;
  file?: vscode.Uri;
  profile?: string;
  workspaceUploadBlockedReason?: string;
};

export class TransferViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly subscriptions: vscode.Disposable[] = [];
  private target?: TransferTarget;
  private targetId = 0;
  private revision = 0;
  private appliedRevision = 0;
  private upload?: UploadFeedback;
  private switching = false;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly config: ConfigService,
    private readonly uploadResource: (resource: vscode.Uri, profile: string) => Promise<void>,
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.dispose();
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    this.subscriptions.push(
      view.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(view, message)),
      view.onDidChangeVisibility(() => this.refresh()),
      view.onDidDispose(() => this.dispose()),
    );
    view.webview.html = this.getHtml(view.webview, media);
  }

  public refresh(): void {
    const view = this.view;
    if (view?.visible) void this.postState(view);
  }

  public setUpload(upload?: UploadFeedback): void {
    this.upload = upload;
    const view = this.view;
    if (view?.visible) void view.webview.postMessage({ type: 'upload', upload, switching: this.switching });
  }

  public dispose(): void {
    this.revision += 1;
    this.view = undefined;
    this.target = undefined;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }

  private async handleMessage(view: vscode.WebviewView, message: unknown): Promise<void> {
    if (this.view !== view || !message || typeof message !== 'object' || !('type' in message)) return;

    switch (message.type) {
      case 'ready':
        await this.postState(view);
        break;
      case 'configure':
        await vscode.commands.executeCommand('sftpFtpUploader.openConfig', this.target?.folder?.uri);
        break;
      case 'switch': {
        if (this.switching || !this.target?.profile) return;
        this.switching = true;
        void view.webview.postMessage({ type: 'upload', upload: this.upload, switching: true });
        try {
          await vscode.commands.executeCommand('sftpFtpUploader.selectProfile', this.target.folder?.uri);
        } finally {
          this.switching = false;
          this.refresh();
        }
        break;
      }
      case 'upload':
      case 'uploadWorkspace': {
        const target = this.target;
        const uploading = this.upload?.state === 'queued' || this.upload?.state === 'running';
        const activeFolder = this.config.getActiveWorkspaceFolder();
        if (!('targetId' in message) || message.targetId !== this.targetId || this.appliedRevision !== this.revision
          || uploading || this.switching || !target?.folder || !target.profile
          || target.folder.uri.toString() !== activeFolder?.uri.toString()) {
          await this.postState(view);
          break;
        }
        const resource = message.type === 'uploadWorkspace'
          ? (target.workspaceUploadBlockedReason ? undefined : target.folder.uri)
          : (target.file?.toString() === vscode.window.activeTextEditor?.document.uri.toString() ? target.file : undefined);
        if (!resource) {
          await this.postState(view);
          break;
        }
        await this.uploadResource(resource, target.profile);
        break;
      }
      case 'logs':
        await vscode.commands.executeCommand('sftpFtpUploader.showOutput');
        break;
    }
  }

  private async postState(view: vscode.WebviewView): Promise<void> {
    const revision = ++this.revision;
    const folder = this.config.getActiveWorkspaceFolder();
    const document = vscode.window.activeTextEditor?.document;
    const file = document?.uri.scheme === 'file' ? document.uri : undefined;
    const config = folder ? await this.config.readConfig(folder).catch(() => undefined) : undefined;
    if (this.view !== view || revision !== this.revision || !view.visible) return;

    const profileName = folder && config && this.config.getActiveProfileName(folder, config);
    const profile = profileName ? config?.profiles[profileName] : undefined;
    const environment = folder && profileName && profile ? describeEnvironment(profileName, profile, folder.name) : undefined;
    const uploadTarget = folder && profile ? describeUploadTarget(folder, profile, file) : undefined;
    const workspaceUploadBlockedReason = uploadTarget?.workspaceReason;

    const current = this.target;
    const uploadFile = uploadTarget && !uploadTarget.reason ? file : undefined;
    if (current?.folder?.uri.toString() !== folder?.uri.toString() || current?.file?.toString() !== uploadFile?.toString()
      || current?.profile !== profileName || current?.workspaceUploadBlockedReason !== workspaceUploadBlockedReason) {
      this.targetId += 1;
    }
    this.target = { folder, profile: profileName, file: uploadFile, workspaceUploadBlockedReason };
    this.appliedRevision = revision;
    void view.webview.postMessage({
      type: 'state', targetId: this.targetId, environment, canConfigure: !!folder, switching: this.switching,
      emptyText: folder ? '当前工作区尚未配置上传环境' : '请先打开工作区',
      fileName: file ? basename(file.fsPath) : undefined,
      remoteFilePath: uploadTarget?.remoteFilePath,
      uploadBlockedReason: uploadTarget?.reason, workspaceUploadBlockedReason, upload: this.upload,
    });
  }

  private getHtml(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('hex');
    const resource = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, name));
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${resource('transfer.css')}">
  <title>传输控制</title>
</head>
<body>
  <main aria-label="传输控制">
    <button id="environment" class="environment" type="button" hidden>
      <span class="server-icon" aria-hidden="true"></span>
      <span class="env-copy"><span id="name" class="env-name"></span><span id="endpoint" class="endpoint"></span></span>
      <span id="protocol" class="protocol"></span><span class="chevron" aria-hidden="true"></span>
    </button>
    <section id="empty" class="empty">
      <p id="empty-text" role="status">正在读取配置…</p>
      <button id="configure" class="secondary" type="button" hidden>打开配置页面</button>
    </section>
    <section id="actions" class="actions" hidden>
      <button id="upload-workspace" class="primary" type="button">上传整个映射工作区</button>
      <button id="upload" class="secondary" type="button" aria-describedby="target">上传当前文件</button>
      <p id="target" class="target"></p>
    </section>
    <section id="feedback" class="feedback" hidden>
      <span class="indicator" aria-hidden="true"></span>
      <p id="status" role="status"></p>
      <button id="logs" class="text-button" type="button" hidden>查看日志</button>
    </section>
  </main>
  <script nonce="${nonce}" src="${resource('transfer.js')}" defer></script>
</body>
</html>`;
  }
}

function describeEnvironment(name: string, profile: UploadProfile, folderName: string) {
  const protocol = profile.protocol === 'ftp' && profile.secure ? 'FTPS' : profile.protocol.toUpperCase();
  try {
    const host = resolveProfileValue(profile.host, folderName).trim();
    const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const port = profile.port ?? defaultPort(profile.protocol, profile);
    const local = normalizeLocalPath(profile.localPath ?? '.');
    const remote = normalizeRemoteRoot(resolveProfileValue(profile.remotePath, folderName));
    const endpoint = `${address}:${port}`;
    return { name, protocol, endpoint, tooltip: `${name} · ${protocol}\n${endpoint}\n路径映射：${local} → ${remote}\n点击切换上传环境` };
  } catch {
    return { name, protocol, endpoint: '连接配置缺少环境变量', tooltip: '点击切换上传环境' };
  }
}

function describeUploadTarget(folder: vscode.WorkspaceFolder, profile: UploadProfile, file: vscode.Uri | undefined): {
  reason?: string;
  workspaceReason?: string;
  remoteFilePath?: string;
} {
  let root: string;
  try {
    root = resolveLocalUploadRoot(folder.uri.fsPath, profile.localPath ?? '.');
  } catch {
    const reason = '请检查项目上传目录配置';
    return { reason, workspaceReason: reason };
  }
  if (!file) return { reason: '打开本地文件后即可上传' };
  const fileFolder = vscode.workspace.getWorkspaceFolder(file);
  if (fileFolder?.uri.toString() !== folder.uri.toString()) return { reason: '当前文件不在此工作区内' };
  if (!isPathInsideRoot(root, file.fsPath)) return { reason: '当前文件不在项目上传目录内' };
  try {
    const remote = normalizeRemoteRoot(resolveProfileValue(profile.remotePath, folder.name));
    const filePath = relative(root, file.fsPath).split(sep).join('/');
    return { remoteFilePath: posix.join(remote, filePath) };
  } catch {
    return {};
  }
}
