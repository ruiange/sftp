import * as path from 'node:path';
import { Client } from 'basic-ftp';
import type { ResolvedProfile } from '../types';
import type { RemoteClient, RemoteFileEntry } from './remoteClient';

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

  public async listDirectory(remotePath: string): Promise<RemoteFileEntry[]> {
    if (!this.client) {
      throw new Error('FTP 客户端尚未连接。');
    }
    const entries = await this.client.list(remotePath);
    return entries
      .filter((entry) => entry.name !== '.' && entry.name !== '..')
      .map((entry) => ({
        name: entry.name,
        path: path.posix.join(remotePath, entry.name),
        type: entry.isDirectory ? 'directory' : 'file',
        size: entry.size,
        modifiedAt: entry.modifiedAt?.getTime(),
      }));
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
