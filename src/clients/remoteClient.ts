import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { Writable } from 'node:stream';
import type { ResolvedProfile } from '../types';

export interface RemoteFileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'link';
  size: number;
  modifiedAt?: number;
}

export interface RemoteClient {
  connect(profile: ResolvedProfile): Promise<void>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  uploadFileReplacing(localPath: string, remotePath: string, overwrite: boolean): Promise<void>;
  readFile(remotePath: string, maxBytes: number): Promise<Buffer>;
  writeFile(remotePath: string, content: Uint8Array, overwrite: boolean): Promise<void>;
  listDirectory(remotePath: string): Promise<RemoteFileEntry[]>;
  createDirectory(remotePath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  deleteFile(remotePath: string): Promise<void>;
  deleteDirectory(remotePath: string): Promise<void>;
  disconnect(): Promise<void>;
}

export function stagingPathFor(remotePath: string): string {
  return posix.join(posix.dirname(remotePath), `.sftp-ftp-uploader-${randomUUID()}.tmp`);
}

export async function collectRemoteFile(
  maxBytes: number,
  download: (destination: Writable) => Promise<unknown>,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('无效的文件预览大小限制。');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (size + chunk.length > maxBytes) {
        callback(new Error(`文件超过预览大小限制（${maxBytes} 字节）。`));
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
      callback();
    },
  });

  try {
    await download(destination);
    return Buffer.concat(chunks, size);
  } finally {
    destination.destroy();
  }
}
