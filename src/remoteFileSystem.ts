import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { posix } from 'node:path';
import * as vscode from 'vscode';
import { createRemoteClient } from './clients';
import type { RemoteClient, RemoteFileEntry } from './clients/remoteClient';
import { toErrorMessage, type ConfigService } from './config';
import type { Logger } from './logger';
import type { LoadedProfile } from './types';

export const REMOTE_FILE_SCHEME = 'sftp-ftp-remote';
export const REMOTE_SERVER_FILE_SCHEME = 'sftp-ftp-server';
export type RemoteFileScope = 'deployment' | 'server';
const MAX_FILE_BYTES = 2 * 1024 * 1024;

type Source = { folder: vscode.Uri; profileName: string; scope: RemoteFileScope };
type RemoteTarget = { path: string; entry?: RemoteFileEntry };

export class RemoteFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  public readonly onDidChangeFile = this.changes.event;
  private readonly serverChanges = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  public readonly onDidChangeServerFile = this.serverChanges.event;
  private readonly sources = new Map<string, Source>();
  private readonly revisions = new Map<string, string>();
  private readonly localWriteTimes = new Map<string, number>();
  private mutations: Promise<void> = Promise.resolve();
  private readonly registrations: vscode.Disposable[];

  public constructor(private readonly config: ConfigService, private readonly logger: Logger) {
    this.registrations = [
      vscode.workspace.registerFileSystemProvider(REMOTE_FILE_SCHEME, this, { isCaseSensitive: true }),
      vscode.workspace.registerFileSystemProvider(REMOTE_SERVER_FILE_SCHEME, {
        onDidChangeFile: this.serverChanges.event,
        watch: () => this.watch(),
        stat: (uri) => this.stat(uri),
        readDirectory: (uri) => this.readDirectory(uri),
        readFile: (uri) => this.readFile(uri),
        writeFile: rejectServerWrite,
        createDirectory: rejectServerWrite,
        rename: rejectServerWrite,
        delete: rejectServerWrite,
      }, { isCaseSensitive: true, isReadonly: true }),
      vscode.workspace.onDidCloseTextDocument(({ uri }) => {
        if (uri.scheme === REMOTE_FILE_SCHEME) {
          this.revisions.delete(uri.toString());
        }
        if (scopeForScheme(uri.scheme)) {
          this.localWriteTimes.delete(uri.toString());
        }
      }),
    ];
  }

  public getWorkspaceUri(uri: vscode.Uri): vscode.Uri | undefined {
    const source = this.sources.get(uri.authority);
    return source && source.scope === scopeForScheme(uri.scheme) ? source.folder : undefined;
  }

  public async resolveProfile(uri: vscode.Uri): Promise<LoadedProfile> {
    segmentsOf(uri);
    const scope = scopeForScheme(uri.scheme);
    if (!scope) {
      throw vscode.FileSystemError.NoPermissions('无效的远程文件路径。');
    }
    return this.loadSource(uri, scope);
  }

  public rootUri(loaded: LoadedProfile, scope: RemoteFileScope = 'deployment'): vscode.Uri {
    const authority = remoteSourceKey(loaded, scope);
    this.sources.set(authority, { folder: loaded.workspaceFolder.uri, profileName: loaded.profile.name, scope });
    const scheme = scope === 'server' ? REMOTE_SERVER_FILE_SCHEME : REMOTE_FILE_SCHEME;
    return vscode.Uri.from({ scheme, authority, path: '/' });
  }

  public childUri(parent: vscode.Uri, name: string): vscode.Uri {
    if (!isRemoteName(name)) {
      throw vscode.FileSystemError.NoPermissions('名称不能包含斜杠、反斜杠或控制字符，也不能是 . 或 ..。');
    }
    return vscode.Uri.joinPath(parent, name);
  }

  public watch(): vscode.Disposable {
    // 仅发布插件自身的变更；不为 FTP/SFTP 文件持续建立轮询连接。
    return new vscode.Disposable(() => {});
  }

  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.withTarget(uri, async (client, target) => {
      if (uri.path === '/') {
        await client.listDirectory(target.path);
        return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
      }
      const entry = requireEntry(target, uri);
      const mtime = entry.modifiedAt && Number.isFinite(entry.modifiedAt) ? entry.modifiedAt : 0;
      return {
        type: fileType(entry),
        ctime: 0,
        mtime: Math.max(mtime, this.localWriteTimes.get(uri.toString()) ?? 0),
        size: entry.size,
        ...(entry.type === 'link' ? { permissions: vscode.FilePermission.Readonly } : {}),
      };
    });
  }

  public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return (await this.listEntries(uri)).map((entry) => [entry.name, fileType(entry)]);
  }

  public listEntries(uri: vscode.Uri): Promise<RemoteFileEntry[]> {
    return this.withTarget(uri, async (client, target) => {
      if (uri.path !== '/') {
        requireDirectory(requireEntry(target, uri), uri);
      }
      return (await client.listDirectory(target.path)).filter((entry) => isRemoteName(entry.name));
    });
  }

  public readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.readFileContent(uri, true);
  }

  public previewFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.readFileContent(uri, false);
  }

  private readFileContent(uri: vscode.Uri, trackRevision: boolean): Promise<Uint8Array> {
    return this.withTarget(uri, async (client, target) => {
      const entry = requireFile(target, uri);
      checkFileSize(entry.size);
      const content = await client.readFile(target.path, MAX_FILE_BYTES);
      if (trackRevision && uri.scheme === REMOTE_FILE_SCHEME) {
        const key = uri.toString();
        // 其他编辑器或扩展的读取不能替换仍在编辑的文件基线。
        if (!this.revisions.has(key)) {
          this.revisions.set(key, digest(content));
        }
      }
      return content;
    });
  }

  public inspectUploadTarget(uri: vscode.Uri): Promise<RemoteFileEntry | undefined> {
    assertFileOperationTarget(uri);
    return this.withTarget(uri, async (_client, target) => {
      if (target.entry) {
        requireUploadTarget(target, uri);
      }
      return target.entry;
    });
  }

  public inspectServerItem(uri: vscode.Uri): Promise<RemoteFileEntry> {
    assertFileOperationTarget(uri);
    return this.withTarget(uri, async (_client, target) => requireEntry(target, uri));
  }

  public uploadFile(uri: vscode.Uri, localPath: string, expected: RemoteFileEntry | undefined): Promise<void> {
    assertFileOperationTarget(uri);
    return this.mutate(async () => {
      const local = await lstat(localPath);
      if (!local.isFile() || local.isSymbolicLink()) {
        throw vscode.FileSystemError.NoPermissions('请选择普通本地文件，不能上传目录或符号链接。');
      }
      await this.withTarget(uri, async (client, target, loaded) => {
        assertSameSnapshot(target, expected, uri);
        assertNoUnsavedTarget(loaded, target.path, uri);
        if (target.entry) {
          requireUploadTarget(target, uri);
        }
        await client.uploadFileReplacing(localPath, target.path, !!target.entry);
        const key = uri.toString();
        if (vscode.workspace.textDocuments.some((document) => document.uri.toString() === key)) {
          this.localWriteTimes.set(key, Math.max(Date.now(), (target.entry?.modifiedAt ?? 0) + 1, (this.localWriteTimes.get(key) ?? 0) + 1));
        }
        this.logger.info(`已上传服务器文件：${target.path}（环境：${loaded.profile.name}）`);
        const changes = uri.scheme === REMOTE_SERVER_FILE_SCHEME ? this.serverChanges : this.changes;
        changes.fire([{ uri, type: target.entry ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created }]);
      });
    });
  }

  public writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    assertWritable(uri);
    return this.mutate(() => this.withTarget(uri, async (client, target, loaded) => {
      if (uri.path === '/') {
        throw vscode.FileSystemError.FileIsADirectory(uri);
      }
      checkFileSize(content.byteLength);
      const key = uri.toString();
      const revision = this.revisions.get(key);
      if (target.entry) {
        if (!options.overwrite) {
          throw vscode.FileSystemError.FileExists(uri);
        }
        const entry = requireFile(target, uri);
        if (entry.size > MAX_FILE_BYTES || !revision
          || digest(await client.readFile(target.path, MAX_FILE_BYTES)) !== revision) {
          throw vscode.FileSystemError.NoPermissions('远端文件已变更，或没有可核对的原始版本。请先保留本次编辑，关闭标签页后重新打开文件核对。');
        }
      } else if (!options.create || revision) {
        throw vscode.FileSystemError.FileNotFound('远端原文件已不存在，未重新创建。');
      }

      const wasOpen = vscode.workspace.textDocuments.some((document) => document.uri.toString() === key);
      await client.writeFile(target.path, content, !!target.entry);
      if (wasOpen) {
        this.revisions.set(key, digest(content));
        this.localWriteTimes.set(key, Math.max(Date.now(), (target.entry?.modifiedAt ?? 0) + 1, (this.localWriteTimes.get(key) ?? 0) + 1));
      }
      this.logger.info(`已保存远端文件：${target.path}（环境：${loaded.profile.name}）`);
      this.changes.fire([{ uri, type: target.entry ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created }]);
    }));
  }

  public createDirectory(uri: vscode.Uri): Promise<void> {
    assertWritable(uri);
    return this.mutate(() => this.withTarget(uri, async (client, target) => {
      if (uri.path === '/' || target.entry) {
        throw vscode.FileSystemError.FileExists(uri);
      }
      await client.createDirectory(target.path);
      this.changes.fire([{ uri, type: vscode.FileChangeType.Created }]);
    }));
  }

  public rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    assertWritable(oldUri);
    assertWritable(newUri);
    if (oldUri.authority !== newUri.authority || oldUri.path === '/' || newUri.path === '/') {
      throw vscode.FileSystemError.NoPermissions('不能重命名部署根目录或跨环境移动。');
    }
    const newSegments = segmentsOf(newUri);
    return this.mutate(() => this.withTarget(oldUri, async (client, oldTarget, loaded) => {
      const entry = requireEntry(oldTarget, oldUri);
      if (entry.type === 'link') {
        throw vscode.FileSystemError.NoPermissions('不支持重命名远程符号链接。');
      }
      const newTarget = await locate(client, loaded.profile.remotePath, newSegments, newUri);
      if (newTarget.entry) {
        throw vscode.FileSystemError.FileExists(newUri);
      }
      await client.rename(oldTarget.path, newTarget.path);
      const revision = this.revisions.get(oldUri.toString());
      if (revision) {
        this.revisions.set(newUri.toString(), revision);
      }
      this.changes.fire([
        { uri: oldUri, type: vscode.FileChangeType.Deleted },
        { uri: newUri, type: vscode.FileChangeType.Created },
      ]);
    }));
  }

  public delete(): never {
    throw vscode.FileSystemError.NoPermissions('请在远程文件管理器中使用带确认的删除操作。');
  }

  public deleteConfirmed(
    uri: vscode.Uri,
    expectedType: RemoteFileEntry['type'],
    expected?: RemoteFileEntry,
  ): Promise<void> {
    const server = uri.scheme === REMOTE_SERVER_FILE_SCHEME;
    if (server) {
      assertFileOperationTarget(uri);
      if (!expected) {
        throw vscode.FileSystemError.NoPermissions('请先读取并确认要删除的服务器文件。');
      }
    } else {
      assertWritable(uri);
    }
    return this.mutate(() => this.withTarget(uri, async (client, target, loaded) => {
      if (uri.path === '/' || requireEntry(target, uri).type !== expectedType) {
        throw vscode.FileSystemError.NoPermissions('远端项目类型已变更，或为部署根目录。');
      }
      if (expected) {
        assertSameSnapshot(target, expected, uri);
      }
      if (server) {
        assertNoUnsavedTarget(loaded, target.path, uri);
      }
      if (expectedType === 'directory') {
        await client.deleteDirectory(target.path);
      } else {
        await client.deleteFile(target.path);
      }
      const event = [{ uri, type: vscode.FileChangeType.Deleted }];
      if (server) {
        this.serverChanges.fire(event);
      } else {
        this.changes.fire(event);
      }
    }));
  }

  public dispose(): void {
    this.changes.dispose();
    this.serverChanges.dispose();
    for (const registration of this.registrations) {
      registration.dispose();
    }
  }

  private mutate(operation: () => Promise<void>): Promise<void> {
    const result = this.mutations.then(operation);
    this.mutations = result.catch(() => {});
    return result;
  }

  private async withTarget<T>(
    uri: vscode.Uri,
    action: (client: RemoteClient, target: RemoteTarget, loaded: LoadedProfile) => Promise<T>,
  ): Promise<T> {
    try {
      const segments = segmentsOf(uri);
      const scope = uri.scheme === REMOTE_SERVER_FILE_SCHEME ? 'server' : 'deployment';
      const loaded = await this.loadSource(uri, scope);
      const client = createRemoteClient(loaded.profile.protocol);
      try {
        await client.connect(loaded.profile);
        const root = scope === 'server' ? '/' : loaded.profile.remotePath;
        const target = await locate(client, root, segments, uri);
        return await action(client, target, loaded);
      } finally {
        try {
          await client.disconnect();
        } catch (error) {
          this.logger.error(`关闭远程文件连接失败：${toErrorMessage(error)}`);
        }
      }
    } catch (error) {
      if (error instanceof vscode.FileSystemError) {
        throw error;
      }
      throw vscode.FileSystemError.Unavailable(toErrorMessage(error));
    }
  }

  private async loadSource(uri: vscode.Uri, scope: RemoteFileScope): Promise<LoadedProfile> {
    const source = this.sources.get(uri.authority);
    if (source) {
      const folder = source.scope === scope
        ? vscode.workspace.workspaceFolders?.find((item) => item.uri.toString() === source.folder.toString())
        : undefined;
      if (folder) {
        const loaded = await this.config.load(folder, source.profileName);
        if (remoteSourceKey(loaded, scope) === uri.authority) {
          return loaded;
        }
      }
    } else {
      // 恢复重载前的标签：只匹配完全相同的来源，不回退到当前环境。
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        let config;
        try {
          config = await this.config.readConfig(folder);
        } catch {
          continue;
        }
        for (const name of Object.keys(config.profiles)) {
          try {
            const loaded = this.config.createLoadedProfile(folder, config, name);
            if (remoteSourceKey(loaded, scope) === uri.authority) {
              this.rootUri(loaded, scope);
              return loaded;
            }
          } catch {
            // 其他环境的凭据缺失时，不影响匹配原环境。
          }
        }
      }
    }
    throw vscode.FileSystemError.NoPermissions('此标签对应的远程连接配置已变更，请从远程文件侧栏重新打开。');
  }
}

export function remoteSourceKey(
  { workspaceFolder, configUri, profile }: LoadedProfile,
  scope: RemoteFileScope = 'deployment',
): string {
  const identity = JSON.stringify([
    ...(scope === 'server' ? [REMOTE_SERVER_FILE_SCHEME] : []),
    workspaceFolder.uri.toString(), configUri.toString(), profile.name, profile.protocol,
    profile.host, profile.port, profile.username, scope === 'server' ? '/' : profile.remotePath, profile.secure ?? false,
    profile.rejectUnauthorized ?? true,
  ]);
  return createHash('sha256').update(identity).digest('hex');
}

export function isRemoteName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\x00-\x1f\x7f/\\]/.test(name);
}

function segmentsOf(uri: vscode.Uri): string[] {
  const segments = uri.path === '/' ? [] : uri.path.slice(1).split('/');
  if (!scopeForScheme(uri.scheme) || !/^[a-f0-9]{64}$/.test(uri.authority)
    || !uri.path.startsWith('/') || uri.query || uri.fragment || !segments.every(isRemoteName)) {
    throw vscode.FileSystemError.NoPermissions('无效的远程文件路径。');
  }
  return segments;
}

function scopeForScheme(scheme: string): RemoteFileScope | undefined {
  if (scheme === REMOTE_SERVER_FILE_SCHEME) {
    return 'server';
  }
  return scheme === REMOTE_FILE_SCHEME ? 'deployment' : undefined;
}

function assertWritable(uri: vscode.Uri): void {
  if (uri.scheme === REMOTE_SERVER_FILE_SCHEME) {
    rejectServerWrite();
  }
  if (uri.scheme !== REMOTE_FILE_SCHEME) {
    throw vscode.FileSystemError.NoPermissions('无效的远程文件路径。');
  }
}

function rejectServerWrite(): never {
  throw vscode.FileSystemError.NoPermissions('服务器根目录中的文件以只读方式打开，请在远程文件管理器中上传、替换或删除。');
}

function assertFileOperationTarget(uri: vscode.Uri): void {
  segmentsOf(uri);
  if (uri.path === '/') {
    throw vscode.FileSystemError.NoPermissions('不能替换或删除当前范围的根目录。');
  }
}

function assertSameSnapshot(target: RemoteTarget, expected: RemoteFileEntry | undefined, uri: vscode.Uri): void {
  const current = target.entry;
  if ((!current && !expected)
    || (current && expected && expected.path === target.path && current.path === target.path
      && current.type === expected.type && current.size === expected.size && current.modifiedAt === expected.modifiedAt)) {
    return;
  }
  throw vscode.FileSystemError.NoPermissions(`远端目标在确认后已发生变化，请刷新并重新确认：${uri.path}`);
}

function requireUploadTarget(target: RemoteTarget, uri: vscode.Uri): void {
  const entry = requireEntry(target, uri);
  if (entry.type === 'directory') {
    throw vscode.FileSystemError.FileIsADirectory(uri);
  }
  if (entry.type !== 'file') {
    throw vscode.FileSystemError.NoPermissions('只能替换普通远程文件，不能替换符号链接。');
  }
}

function assertNoUnsavedTarget(loaded: LoadedProfile, targetPath: string, uri: vscode.Uri): void {
  const deploymentSource = remoteSourceKey(loaded, 'deployment');
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty) {
      continue;
    }
    if (uri.scheme === REMOTE_FILE_SCHEME && document.uri.scheme === REMOTE_FILE_SCHEME
      && document.uri.authority === deploymentSource) {
      if (document.uri.path === uri.path || document.uri.path.startsWith(`${uri.path}/`)) {
        throw vscode.FileSystemError.NoPermissions('该服务器项目中有未保存的远程文件，请先保存或关闭相关编辑器。');
      }
      continue;
    }
    let documentPath: string | undefined;
    if (document.uri.scheme === REMOTE_SERVER_FILE_SCHEME && document.uri.authority === uri.authority) {
      documentPath = document.uri.path;
    } else if (document.uri.scheme === REMOTE_FILE_SCHEME && document.uri.authority === deploymentSource) {
      if (!posix.isAbsolute(loaded.profile.remotePath)) {
        throw vscode.FileSystemError.NoPermissions('当前环境有未保存的远程文件，且部署路径是相对路径。请先保存或关闭相关编辑器，再操作服务器文件。');
      }
      documentPath = posix.join(loaded.profile.remotePath, document.uri.path.slice(1));
    }
    if (documentPath === targetPath || documentPath?.startsWith(`${targetPath}/`)) {
      throw vscode.FileSystemError.NoPermissions('该服务器项目中有未保存的远程文件，请先保存或关闭相关编辑器。');
    }
  }
}

async function locate(client: RemoteClient, root: string, segments: string[], uri: vscode.Uri): Promise<RemoteTarget> {
  if (/[\x00-\x1f\x7f]/.test(root) || root.split('/').includes('..')) {
    throw vscode.FileSystemError.NoPermissions('部署根路径不能包含控制字符或 ..，请修改连接配置。');
  }
  const rootPath = posix.normalize(root);
  let parent = rootPath;
  for (const [index, name] of segments.entries()) {
    const targetPath = posix.join(parent, name);
    const entry = (await client.listDirectory(parent)).find((item) => item.name === name);
    if (index === segments.length - 1) {
      return { path: targetPath, entry };
    }
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    requireDirectory(entry, uri);
    parent = targetPath;
  }
  return { path: rootPath };
}

function fileType(entry: RemoteFileEntry): vscode.FileType {
  if (entry.type === 'directory') {
    return vscode.FileType.Directory;
  }
  return entry.type === 'link' ? vscode.FileType.SymbolicLink : vscode.FileType.File;
}

function requireEntry(target: RemoteTarget, uri: vscode.Uri): RemoteFileEntry {
  if (!target.entry) {
    throw vscode.FileSystemError.FileNotFound(uri);
  }
  return target.entry;
}

function requireDirectory(entry: RemoteFileEntry, uri: vscode.Uri): void {
  if (entry.type === 'link') {
    throw vscode.FileSystemError.NoPermissions('不跟随远程符号链接。');
  }
  if (entry.type !== 'directory') {
    throw vscode.FileSystemError.FileNotADirectory(uri);
  }
}

function requireFile(target: RemoteTarget, uri: vscode.Uri): RemoteFileEntry {
  if (uri.path === '/' || target.entry?.type === 'directory') {
    throw vscode.FileSystemError.FileIsADirectory(uri);
  }
  const entry = requireEntry(target, uri);
  if (entry.type !== 'file') {
    throw vscode.FileSystemError.NoPermissions('只支持打开和保存普通远程文件。');
  }
  return entry;
}

function checkFileSize(size: number): void {
  if (size > MAX_FILE_BYTES) {
    throw vscode.FileSystemError.NoPermissions('文件超过 2 MB，无法在远程编辑器中打开或保存。');
  }
}

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
