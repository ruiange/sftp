import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import SftpClientLibrary from 'ssh2-sftp-client';
import type { ResolvedProfile } from '../types';
import type { RemoteClient, RemoteFileEntry } from './remoteClient';

export class SftpRemoteClient implements RemoteClient {
  private readonly client = new SftpClientLibrary('SFTP / FTP Uploader');
  private connected = false;

  public async connect(profile: ResolvedProfile): Promise<void> {
    const privateKey = profile.privateKeyPath
      ? await readFile(profile.privateKeyPath)
      : undefined;

    await this.client.connect({
      host: profile.host,
      port: profile.port,
      username: profile.username,
      password: profile.password,
      privateKey,
      passphrase: profile.passphrase,
      readyTimeout: profile.connectTimeout,
    });
    this.connected = true;
  }

  public async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const remoteDirectory = path.posix.dirname(remotePath);
    await this.client.mkdir(remoteDirectory, true);
    await this.client.fastPut(localPath, remotePath);
  }

  public async listDirectory(remotePath: string): Promise<RemoteFileEntry[]> {
    const entries = await this.client.list(remotePath);
    return entries
      .filter((entry) => entry.name !== '.' && entry.name !== '..')
      .map((entry) => ({
        name: entry.name,
        path: path.posix.join(remotePath, entry.name),
        type: entry.type === 'd' ? 'directory' : entry.type === 'l' ? 'link' : 'file',
        size: entry.size,
        modifiedAt: entry.modifyTime,
      }));
  }

  public async deleteFile(remotePath: string): Promise<void> {
    await this.client.delete(remotePath);
  }

  public async deleteDirectory(remotePath: string): Promise<void> {
    await this.client.rmdir(remotePath, true);
  }

  public async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    await this.client.end();
  }
}
