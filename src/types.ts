import type * as vscode from 'vscode';

export type TransferProtocol = 'sftp' | 'ftp';
export type FtpSecureMode = boolean | 'implicit';
export type AuthenticationType = 'password' | 'privateKey';

export interface UploadProfile {
  protocol: TransferProtocol;
  host: string;
  port?: number;
  username: string;
  authType?: AuthenticationType;
  password?: string;
  localPath?: string;
  remotePath: string;
  uploadOnSave?: boolean;
  ignore?: string[];
  connectTimeout?: number;

  // SFTP 专用配置
  privateKeyPath?: string;
  passphrase?: string;

  // FTP/FTPS 专用配置
  secure?: FtpSecureMode;
  rejectUnauthorized?: boolean;
}

export interface ExtensionConfigFile {
  defaultProfile?: string;
  uploadOnSave?: boolean;
  ignore?: string[];
  profiles: Record<string, UploadProfile>;
}

export interface ResolvedProfile extends UploadProfile {
  name: string;
  authType: AuthenticationType;
  localPath: string;
  port: number;
  remotePath: string;
  uploadOnSave: boolean;
  ignore: string[];
  connectTimeout: number;
}

export interface LoadedProfile {
  workspaceFolder: vscode.WorkspaceFolder;
  configUri: vscode.Uri;
  config: ExtensionConfigFile;
  profile: ResolvedProfile;
}

export interface UploadEntry {
  localPath: string;
  remotePath: string;
  relativePath: string;
  size: number;
}

export interface UploadResult {
  uploaded: number;
  skipped: number;
  bytes: number;
}
