import { randomBytes } from 'node:crypto';
import { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import { resolveSshEndpoint, toErrorMessage, type ConfigService } from './config';
import type { UploadProfile } from './types';

const CONNECTION_TIMEOUT = 3_000;
const REFRESH_INTERVAL = 30_000;
const MAX_CONCURRENT_CONNECTIONS = 6;

type SshEndpoint = ReturnType<typeof resolveSshEndpoint>;
type Latency = {
  status: 'pending' | 'reachable' | 'timeout' | 'unreachable' | 'invalid';
  latency: string;
  detail: string;
};
type Server = {
  id: string;
  name: string;
  folder: vscode.Uri;
  workspace?: string;
  address: string;
  endpoint?: SshEndpoint;
  measurement: Latency;
};

export class SshServerViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly viewDisposables: vscode.Disposable[] = [];
  private servers?: Promise<Server[]>;
  private monitoring?: AbortController;
  private refreshTimer?: NodeJS.Timeout;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly configService: ConfigService,
    private readonly deleteProfile: (folder: vscode.Uri, name: string) => Promise<void>,
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.dispose();
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((value: unknown) => void this.handleMessage(view, value)),
      view.onDidChangeVisibility(() => this.updateVisibility()),
      view.onDidDispose(() => this.dispose()),
    );
    view.webview.html = this.getHtml(view.webview, media);
    this.updateVisibility();
  }

  public refresh(): void {
    this.servers = undefined;
    this.updateVisibility();
  }

  public dispose(): void {
    this.view = undefined;
    this.updateVisibility();
    for (const disposable of this.viewDisposables.splice(0)) {
      disposable.dispose();
    }
  }

  private updateVisibility(): void {
    clearTimeout(this.refreshTimer);
    this.monitoring?.abort();
    this.monitoring = undefined;
    if (!this.view?.visible) {
      return;
    }
    this.monitoring = new AbortController();
    void this.postServers(this.view);
    void this.measureLatencies(this.monitoring.signal);
  }

  private async handleMessage(view: vscode.WebviewView, value: unknown): Promise<void> {
    if (this.view !== view || !value || typeof value !== 'object' || !('type' in value)) {
      return;
    }
    switch (value.type) {
      case 'ready':
        await this.postServers(view);
        break;
      case 'configure':
        await vscode.commands.executeCommand('sftpFtpUploader.openConfig');
        break;
      case 'refresh':
        this.refresh();
        break;
      case 'open':
      case 'delete': {
        if (!('id' in value) || typeof value.id !== 'string') {
          return;
        }
        const rows = this.getServers();
        const servers = await rows;
        const server = servers.find(({ id }) => id === value.id);
        if (server && this.view === view && this.servers === rows) {
          if (value.type === 'delete') {
            await this.deleteProfile(server.folder, server.name);
          } else {
            await vscode.commands.executeCommand('sftpFtpUploader.openSshTerminal', server.folder, server.name);
          }
        }
        break;
      }
    }
  }

  private async postServers(view: vscode.WebviewView): Promise<void> {
    const rows = this.getServers();
    const servers = await rows;
    if (this.view === view && this.servers === rows && view.visible) {
      void view.webview.postMessage({
        type: 'servers',
        servers: servers.map(({ id, name, address, workspace, measurement }) => ({
          id, name, address, workspace, ...measurement,
        })),
      });
    }
  }

  private getHtml(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('hex');
    const resource = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, name));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${resource('sshServers.css')}">
  <title>SSH 服务器</title>
</head>
<body>
  <main aria-label="SSH 服务器">
    <ul id="servers" aria-label="SSH 服务器"></ul>
    <div id="empty" class="empty" hidden>
      <p>工作区暂无可用的 SFTP 环境。</p>
      <button id="configure" type="button">打开配置页面</button>
    </div>
  </main>
  <script nonce="${nonce}" src="${resource('sshServers.js')}" defer></script>
</body>
</html>`;
  }

  private getServers(): Promise<Server[]> {
    return this.servers ??= this.readServers();
  }

  private async readServers(): Promise<Server[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const entries = await Promise.all(folders.map(async (folder) => {
      const config = await this.configService.readConfig(folder).catch(() => undefined);
      if (!config) {
        return [];
      }

      return Object.entries(config.profiles)
        .filter(([, profile]) => profile.protocol === 'sftp')
        .map(([name, profile]) => createServer(name, folder, profile, folders.length > 1));
    }));
    return entries.flat();
  }

  private async measureLatencies(signal: AbortSignal): Promise<void> {
    const servers = await this.getServers();
    if (signal.aborted) {
      return;
    }

    const endpoints = new Map<string, { endpoint: SshEndpoint; items: Server[] }>();
    for (const item of servers) {
      if (!item.endpoint) {
        continue;
      }
      const { host, port } = item.endpoint;
      const key = JSON.stringify([host, port]);
      const group = endpoints.get(key) ?? { endpoint: item.endpoint, items: [] };
      group.items.push(item);
      endpoints.set(key, group);
    }

    const remaining = endpoints.values();
    const measureNext = async (): Promise<void> => {
      for (const { endpoint, items } of remaining) {
        const latency = await measureConnection(endpoint, signal);
        if (signal.aborted || !latency) {
          return;
        }
        for (const item of items) {
          item.measurement = latency;
          if (this.view?.visible) {
            void this.view.webview.postMessage({ type: 'latency', id: item.id, ...latency });
          }
        }
      }
    };
    const workerCount = Math.min(endpoints.size, MAX_CONCURRENT_CONNECTIONS);
    await Promise.all(Array.from({ length: workerCount }, measureNext));
    if (!signal.aborted && workerCount > 0) {
      this.refreshTimer = setTimeout(() => void this.measureLatencies(signal), REFRESH_INTERVAL);
    }
  }
}

function createServer(name: string, folder: vscode.WorkspaceFolder, profile: UploadProfile, multipleRoots: boolean): Server {
  const identity = {
    id: JSON.stringify([folder.uri.toString(), name]),
    name,
    folder: folder.uri,
    workspace: multipleRoots ? folder.name : undefined,
  };
  try {
    const endpoint = resolveSshEndpoint(profile, folder.name);
    const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host;
    return {
      ...identity,
      endpoint,
      address: endpoint.port === 22 ? host : `${host}:${endpoint.port}`,
      measurement: { status: 'pending', latency: '测量中', detail: '正在测量 SSH 端口的 TCP 连接耗时。' },
    };
  } catch (error) {
    return {
      ...identity,
      address: profile.host,
      measurement: { status: 'invalid', latency: '配置错误', detail: toErrorMessage(error) },
    };
  }
}

function measureConnection(
  endpoint: SshEndpoint,
  signal: AbortSignal,
): Promise<Latency | undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(undefined);
      return;
    }

    const start = performance.now();
    const socket = new Socket();
    const timeout = setTimeout(() => finish({ status: 'timeout', latency: '超时', detail: '3 秒内未能建立 TCP 连接。' }), CONNECTION_TIMEOUT);
    const abort = () => finish();

    function finish(result?: Latency): void {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      socket.destroy();
      resolve(result);
    }

    function onError(error: NodeJS.ErrnoException): void {
      const timedOut = error.code === 'ETIMEDOUT';
      finish({
        status: timedOut ? 'timeout' : 'unreachable',
        latency: timedOut ? '超时' : '不可达',
        detail: error.code ? `TCP 连接失败（${error.code}）。` : 'TCP 连接失败。',
      });
    }

    signal.addEventListener('abort', abort, { once: true });
    socket.once('error', onError);
    socket.once('connect', () => {
      const latency = `${Math.max(1, Math.round(performance.now() - start))} ms`;
      finish({ status: 'reachable', latency, detail: `SSH 端口 TCP 连接耗时：${latency}` });
    });
    try {
      socket.connect(endpoint);
    } catch (error) {
      onError(error as NodeJS.ErrnoException);
    }
  });
}
