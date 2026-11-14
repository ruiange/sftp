import * as path from 'node:path';
import { Readable } from 'node:stream';
import { Client, FTPError } from 'basic-ftp';
import type { ResolvedProfile } from '../types';
import { collectRemoteFile, stagingPathFor, type RemoteClient, type RemoteFileEntry } from './remoteClient';

export class FtpRemoteClient implements RemoteClient {
  private client: Client | undefined;

  public async connect(profile: ResolvedProfile): Promise<void> {
    this.client = new Client(profile.connectTimeout);
    await this.client.access({
      host: profile.host,
      port: profile.port,
      user: profile.username,
      password: profile.password ?? '',
      secure: profile.secure ?? false,
      secureOptions: profile.secure
        ? { rejectUnauthorized: profile.rejectUnauthorized ?? true }
        : undefined,
    });
  }

  public async uploadFile(localPath: string, remotePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('FTP 客户端尚未连接。');
    }
    await this.client.ensureDir(path.posix.dirname(remotePath));
    await this.client.uploadFrom(localPath, path.posix.basename(remotePath));
  }

  public async readFile(remotePath: string, maxBytes: number): Promise<Buffer> {
    const client = this.client;
    if (!client) {
      throw new Error('FTP 客户端尚未连接。');
    }
    return collectRemoteFile(maxBytes, (destination) => client.downloadTo(destination, remotePath));
  }

  public async writeFile(remotePath: string, content: Uint8Array, overwrite: boolean): Promise<void> {
    await this.replaceFrom(Readable.from([Buffer.from(content)]), remotePath, overwrite);
  }

  public async uploadFileReplacing(localPath: string, remotePath: string, overwrite: boolean): Promise<void> {
    await this.replaceFrom(localPath, remotePath, overwrite);
  }

  private async replaceFrom(source: string | Readable, remotePath: string, overwrite: boolean): Promise<void> {
    const client = this.client;
    if (!client) {
      throw new Error('FTP 客户端尚未连接。');
    }
    const temporary = stagingPathFor(remotePath);
    const initial = await findFtpEntry(client, remotePath, !overwrite);
    if (overwrite ? !initial?.isFile : initial !== undefined) {
      throw new Error('远程目标已变化，未保存文件。请刷新远程目录后重试。');
    }

    try {
      await client.uploadFrom(source, temporary);
      // FTP 没有可移植的原子「不存在才重命名」操作，尽量缩短检查与提交的间隔。
      const current = await findFtpEntry(client, remotePath, !overwrite);
      if (initial
        ? !current?.isFile || initial.size !== current.size || initial.rawModifiedAt !== current.rawModifiedAt
          || initial.uniqueID !== current.uniqueID
        : current !== undefined) {
        throw new Error('远程目标已变化，未保存文件。请刷新远程目录后重试。');
      }
      try {
        await client.rename(temporary, remotePath);
      } catch (error) {
        if (overwrite && error instanceof FTPError) {
          throw new Error(`FTP 服务器拒绝替换文件，未执行删除原文件的操作。${error.message}`, { cause: error });
        }
        throw error;
      }
    } catch (error) {
      await client.remove(temporary, true).catch(() => undefined);
      throw error;
    }
  }

  public async listDirectory(remotePath: string): Promise<RemoteFileEntry[]> {
    if (!this.client) {
      throw new Error('FTP 客户端尚未连接。');
    }
    const entries = await this.client.list(ftpListPath(remotePath));
    return entries
      .filter((entry) => entry.name !== '.' && entry.name !== '..'
        && (entry.isFile || entry.isDirectory || entry.isSymbolicLink))
      .map((entry) => ({
        name: entry.name,
        path: path.posix.join(remotePath, entry.name),
        type: entry.isSymbolicLink ? 'link' : entry.isDirectory ? 'directory' : 'file',
        size: entry.size,
        modifiedAt: entry.modifiedAt?.getTime(),
      }));
  }

  public async createDirectory(remotePath: string): Promise<void> {
    const client = this.client;
    if (!client) {
      throw new Error('FTP 客户端尚未连接。');
    }
    const validPath = await client.protectWhitespace(remotePath);
    await client.send(`MKD ${validPath}`);
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    const client = this.client;
    if (!client) {
      throw new Error('FTP 客户端尚未连接。');
    }
    if (await findFtpEntry(client, newPath, true)) {
      throw new Error('远程目标名称已存在，未重命名。');
    }
    await client.rename(oldPath, newPath);
  }

  public async deleteFile(remotePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('FTP 客户端尚未连接。');
    }
    await this.client.remove(remotePath);
  }

  public async deleteDirectory(remotePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('FTP 客户端尚未连接。');
    }
    await this.client.removeDir(remotePath);
  }

  public async disconnect(): Promise<void> {
    this.client?.close();
    this.client = undefined;
  }
}

async function findFtpEntry(client: Client, remotePath: string, guardCase = false) {
  const entries = await client.list(ftpListPath(path.posix.dirname(remotePath)));
  const name = path.posix.basename(remotePath);
  return entries.find((entry) => entry.name === name || (guardCase && entry.name.toLowerCase() === name.toLowerCase()));
}

function ftpListPath(remotePath: string): string {
  // 一些服务端会把 LIST 的前导连字符解释为选项。
  return remotePath.startsWith('-') ? `./${remotePath}` : remotePath;
}
