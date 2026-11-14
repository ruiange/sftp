import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import SftpClientLibrary from 'ssh2-sftp-client';
import type { ResolvedProfile } from '../types';
import { collectRemoteFile, stagingPathFor, type RemoteClient, type RemoteFileEntry } from './remoteClient';

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

  public async readFile(remotePath: string, maxBytes: number): Promise<Buffer> {
    return collectRemoteFile(maxBytes, (destination) => {
      // end 含该位置，多读取一个字节用于识别超限文件。
      const source = this.client.createReadStream(remotePath, { end: maxBytes });
      return pipeline(source, destination);
    });
  }

  public async writeFile(remotePath: string, content: Uint8Array, overwrite: boolean): Promise<void> {
    await this.replaceFrom(() => Readable.from([Buffer.from(content)]), remotePath, overwrite);
  }

  public async uploadFileReplacing(localPath: string, remotePath: string, overwrite: boolean): Promise<void> {
    await this.replaceFrom(() => createReadStream(localPath), remotePath, overwrite);
  }

  private async replaceFrom(openSource: () => Readable, remotePath: string, overwrite: boolean): Promise<void> {
    const temporary = stagingPathFor(remotePath);
    const initial = overwrite ? await this.getEditableStat(remotePath) : undefined;
    if (!overwrite && await this.hasRemoteEntry(remotePath)) {
      throw new Error('远程目标已存在，未上传文件。请刷新远程目录后重试。');
    }
    let ownsTemporary = false;

    try {
      const destination = this.client.createWriteStream(temporary, { flags: 'wx', ...(initial ? { mode: 0o600 } : {}) });
      destination.once('open', () => { ownsTemporary = true; });
      await pipeline(openSource(), destination);

      if (!initial) {
        if (await this.hasRemoteEntry(remotePath)) {
          throw new Error('远程目标已变化，未上传文件。请刷新远程目录后重试。');
        }
        await this.client.rename(temporary, remotePath);
      } else {
        // 只保留普通权限位，避免给重新创建的文件附加 setuid 等特殊权限。
        await this.client.chmod(temporary, initial.mode & 0o777);
        const current = await this.getEditableStat(remotePath);
        if (current.size !== initial.size || current.modifyTime !== initial.modifyTime
          || current.mode !== initial.mode || current.uid !== initial.uid || current.gid !== initial.gid) {
          throw new Error('远程文件已变化，未保存文件。请重新打开后再修改。');
        }
        try {
          await this.client.posixRename(temporary, remotePath);
        } catch (error) {
          if (error instanceof Error && (/does not support this extended request/i.test(error.message)
            || ('code' in error && error.code === 8))) {
            throw new Error('该 SFTP 服务器不支持原子替换，未覆盖原文件。', { cause: error });
          }
          throw error;
        }
      }
    } catch (error) {
      if (ownsTemporary) {
        await this.client.delete(temporary, true).catch(() => undefined);
      }
      throw error;
    }
  }

  public async listDirectory(remotePath: string): Promise<RemoteFileEntry[]> {
    const entries = await this.client.list(remotePath);
    return entries
      .filter((entry) => entry.name !== '.' && entry.name !== '..'
        && (entry.type === '-' || entry.type === 'd' || entry.type === 'l'))
      .map((entry) => ({
        name: entry.name,
        path: path.posix.join(remotePath, entry.name),
        type: entry.type === 'd' ? 'directory' : entry.type === 'l' ? 'link' : 'file',
        size: entry.size,
        modifiedAt: entry.modifyTime,
      }));
  }

  public async createDirectory(remotePath: string): Promise<void> {
    await this.client.mkdir(remotePath, false);
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    await this.client.rename(oldPath, newPath);
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

  private async getEditableStat(remotePath: string) {
    if (await this.client.exists(remotePath) !== '-') {
      throw new Error('远程目标不是可编辑的普通文件，未执行保存。');
    }
    const stat = await this.client.stat(remotePath);
    if (!stat.isFile) {
      throw new Error('远程目标不是可编辑的普通文件，未执行保存。');
    }
    return stat;
  }

  private async hasRemoteEntry(remotePath: string): Promise<boolean> {
    try {
      // 运行库 v12 支持 lstat，但当前安装的 v9 类型声明尚未提供该方法。
      await (this.client as SftpClientLibrary & { lstat(path: string): Promise<unknown> }).lstat(remotePath);
      // exists() 会将设备、FIFO 等特殊文件也当成不存在，此处必须保留它们。
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error
        && (error.code === 2 || error.code === 'ENOENT')) {
        return false;
      }
      throw error;
    }
  }
}
