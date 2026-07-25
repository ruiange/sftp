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
  listDirectory(remotePath: string): Promise<RemoteFileEntry[]>;
  deleteFile(remotePath: string): Promise<void>;
  deleteDirectory(remotePath: string): Promise<void>;
  disconnect(): Promise<void>;
}
