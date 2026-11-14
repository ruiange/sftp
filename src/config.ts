import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  ExtensionConfigFile,
  AuthenticationType,
  LoadedProfile,
  ResolvedProfile,
  TransferProtocol,
  UploadProfile,
} from './types';

const DEFAULT_IGNORE = [
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/node_modules/**',
  '**/.vscode/sftp-sync.json',
];

const DEFAULT_CONFIG: ExtensionConfigFile = {
  defaultProfile: 'development',
  uploadOnSave: false,
  ignore: [
    '**/.git/**',
    '**/node_modules/**',
    '**/.DS_Store',
    '**/.vscode/sftp-sync.json',
  ],
  profiles: {
    development: {
      protocol: 'sftp',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      password: '',
      localPath: '.',
      remotePath: '/var/www/${workspaceFolderBasename}',
      uploadOnSave: false,
    },
  },
};

export class ConfigService {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly resolveWorkspaceUri: (resource: vscode.Uri) => vscode.Uri = (resource) => resource,
  ) {}

  public get configFileName(): string {
    return vscode.workspace
      .getConfiguration('sftpFtpUploader')
      .get<string>('configFile', '.vscode/sftp-sync.json');
  }

  public getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return this.findWorkspaceFolder(vscode.window.activeTextEditor?.document.uri)
      ?? vscode.workspace.workspaceFolders?.[0];
  }

  public async chooseWorkspaceFolder(resource?: vscode.Uri): Promise<vscode.WorkspaceFolder | undefined> {
    const matched = this.findWorkspaceFolder(resource);
    if (matched) {
      return matched;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showErrorMessage('请先打开一个工作区或文件夹。');
      return undefined;
    }

    if (folders.length === 1) {
      return folders[0];
    }

    const selected = await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      { placeHolder: '选择要使用的工作区' },
    );
    return selected?.folder;
  }

  private findWorkspaceFolder(resource?: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return resource && vscode.workspace.getWorkspaceFolder(this.resolveWorkspaceUri(resource));
  }

  public getConfigUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(folder.uri, ...this.configFileName.split('/').filter(Boolean));
  }

  public async initialize(folder: vscode.WorkspaceFolder): Promise<vscode.Uri> {
    const configUri = this.getConfigUri(folder);
    try {
      await vscode.workspace.fs.stat(configUri);
      return configUri;
    } catch {
      const parentUri = vscode.Uri.file(path.dirname(configUri.fsPath));
      await vscode.workspace.fs.createDirectory(parentUri);
      const content = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
      await vscode.workspace.fs.writeFile(configUri, Buffer.from(content, 'utf8'));
      return configUri;
    }
  }

  public async readConfig(folder: vscode.WorkspaceFolder, createIfMissing = false): Promise<ExtensionConfigFile> {
    const configUri = this.getConfigUri(folder);
    if (createIfMissing) {
      await this.initialize(folder);
    }

    let raw: Uint8Array;
    try {
      raw = await vscode.workspace.fs.readFile(configUri);
    } catch {
      throw new Error(`未找到配置文件：${this.configFileName}`);
    }

    let config: ExtensionConfigFile;
    try {
      const content = Buffer.from(raw).toString('utf8').replace(/^\uFEFF/, '');
      config = JSON.parse(content) as ExtensionConfigFile;
    } catch (error) {
      throw new Error(`配置文件不是有效的 JSON：${toErrorMessage(error)}`);
    }

    validateConfigFile(config);
    return config;
  }

  public async saveConfig(folder: vscode.WorkspaceFolder, config: ExtensionConfigFile): Promise<void> {
    const normalized = normalizeAuthenticationConfig(config);
    await this.writeConfig(folder, normalized);
  }

  public async deleteProfile(folder: vscode.WorkspaceFolder, name: string): Promise<void> {
    const config = await this.readConfig(folder);
    if (!Object.hasOwn(config.profiles, name)) {
      return;
    }

    delete config.profiles[name];
    if (config.defaultProfile === name) {
      config.defaultProfile = Object.keys(config.profiles)[0];
    }
    await this.writeConfig(folder, config);
    if (this.context.workspaceState.get<string>(this.activeProfileKey(folder)) === name) {
      await this.setActiveProfile(folder, this.getActiveProfileName(folder, config));
    }
  }

  private async writeConfig(folder: vscode.WorkspaceFolder, config: ExtensionConfigFile): Promise<void> {
    validateConfigFile(config);
    const configUri = this.getConfigUri(folder);
    const parentUri = vscode.Uri.file(path.dirname(configUri.fsPath));
    await vscode.workspace.fs.createDirectory(parentUri);
    await vscode.workspace.fs.writeFile(
      configUri,
      Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'),
    );
  }

  public createLoadedProfile(
    folder: vscode.WorkspaceFolder,
    config: ExtensionConfigFile,
    profileName: string,
  ): LoadedProfile {
    validateConfigFile(config);
    const source = config.profiles[profileName];
    if (!source) {
      throw new Error(`上传环境“${profileName}”不存在。`);
    }
    return {
      workspaceFolder: folder,
      configUri: this.getConfigUri(folder),
      config,
      profile: this.resolveProfile(profileName, source, config, folder),
    };
  }

  public async setActiveProfile(folder: vscode.WorkspaceFolder, profileName: string | undefined): Promise<void> {
    await this.context.workspaceState.update(this.activeProfileKey(folder), profileName);
  }

  public getActiveProfileName(folder: vscode.WorkspaceFolder, config: ExtensionConfigFile): string | undefined {
    const stored = this.context.workspaceState.get<string>(this.activeProfileKey(folder));
    if (stored && Object.hasOwn(config.profiles, stored)) {
      return stored;
    }
    if (config.defaultProfile && Object.hasOwn(config.profiles, config.defaultProfile)) {
      return config.defaultProfile;
    }
    return Object.keys(config.profiles)[0];
  }

  public async openConfig(folder: vscode.WorkspaceFolder): Promise<void> {
    const configUri = this.getConfigUri(folder);
    try {
      await vscode.workspace.fs.stat(configUri);
    } catch {
      await this.initialize(folder);
    }
    const document = await vscode.workspace.openTextDocument(configUri);
    await vscode.window.showTextDocument(document);
  }

  public async load(
    folder: vscode.WorkspaceFolder,
    profileName?: string,
    options: { resolveLoginSecrets?: boolean } = {},
  ): Promise<LoadedProfile> {
    const configUri = this.getConfigUri(folder);
    const config = await this.readConfig(folder);

    const selectedName = profileName ?? this.getActiveProfileName(folder, config);
    if (selectedName === undefined) {
      throw new NoUploadProfilesError();
    }

    if (!Object.hasOwn(config.profiles, selectedName)) {
      throw new Error(`上传环境“${selectedName}”不存在，请重新选择环境。`);
    }

    return {
      workspaceFolder: folder,
      configUri,
      config,
      profile: this.resolveProfile(selectedName, config.profiles[selectedName], config, folder, options.resolveLoginSecrets),
    };
  }

  public async selectProfile(folder: vscode.WorkspaceFolder): Promise<ResolvedProfile | undefined> {
    const config = await this.readConfig(folder);
    const currentName = this.getActiveProfileName(folder, config);
    if (!currentName) {
      throw new NoUploadProfilesError();
    }
    const selected = await vscode.window.showQuickPick(
      Object.entries(config.profiles).map(([name, profile]) => ({
        label: name,
        description: `${profile.protocol.toUpperCase()} · ${profile.host}:${profile.port ?? defaultPort(profile.protocol, profile)}`,
        picked: name === currentName,
      })),
      { placeHolder: '选择上传环境' },
    );
    if (!selected) {
      return undefined;
    }

    const { profile } = await this.load(folder, selected.label);
    await this.setActiveProfile(folder, selected.label);
    return profile;
  }

  private resolveProfile(
    name: string,
    source: UploadProfile,
    config: ExtensionConfigFile,
    folder: vscode.WorkspaceFolder,
    resolveLoginSecrets = true,
  ): ResolvedProfile {
    const protocol = String(source.protocol).toLowerCase() as TransferProtocol;
    if (protocol !== 'sftp' && protocol !== 'ftp') {
      throw new Error(`环境“${name}”的 protocol 只能是 sftp 或 ftp。`);
    }
    if (!source.host?.trim()) {
      throw new Error(`环境“${name}”缺少 host。`);
    }
    if (!source.username?.trim()) {
      throw new Error(`环境“${name}”缺少 username。`);
    }
    if (!source.remotePath?.trim()) {
      throw new Error(`环境“${name}”缺少 remotePath。`);
    }

    const interpolate = (value?: string): string | undefined =>
      value === undefined ? undefined : resolveProfileValue(value, folder.name);

    const authType: AuthenticationType = protocol === 'ftp'
      ? 'password'
      : source.authType ?? (source.privateKeyPath ? 'privateKey' : 'password');
    const privateKeyPath = authType === 'privateKey' ? interpolate(source.privateKeyPath) : undefined;
    const localPath = normalizeLocalPath(source.localPath ?? '.');
    resolveLocalUploadRoot(folder.uri.fsPath, localPath);
    return {
      ...source,
      name,
      protocol,
      authType,
      host: interpolate(source.host)!,
      username: interpolate(source.username)!,
      password: resolveLoginSecrets && authType === 'password' ? interpolate(source.password) : undefined,
      passphrase: resolveLoginSecrets && authType === 'privateKey' ? interpolate(source.passphrase) : undefined,
      privateKeyPath: privateKeyPath ? expandHome(privateKeyPath) : undefined,
      localPath,
      remotePath: normalizeRemoteRoot(interpolate(source.remotePath)!),
      port: source.port ?? defaultPort(protocol, source),
      connectTimeout: source.connectTimeout ?? 15_000,
      uploadOnSave: source.uploadOnSave ?? config.uploadOnSave ?? false,
      ignore: [...DEFAULT_IGNORE, ...(config.ignore ?? []), ...(source.ignore ?? [])],
    };
  }

  private activeProfileKey(folder: vscode.WorkspaceFolder): string {
    return `activeProfile:${folder.uri.toString()}`;
  }
}

export class NoUploadProfilesError extends Error {
  public constructor() {
    super('当前工作区暂无上传环境，请先在配置页面新增环境。');
  }
}

export function resolveSshEndpoint(profile: UploadProfile, folderName: string): { host: string; port: number } {
  const host = normalizeSshHost(resolveProfileValue(profile.host, folderName));
  if (!host) {
    throw new Error('请检查 SFTP 环境的服务器地址。');
  }
  return { host, port: profile.port ?? defaultPort('sftp') };
}

export function normalizeSshHost(host: string): string {
  return host.trim().replace(/^\[([^\]]+)\]$/, '$1');
}

export function resolveProfileValue(value: string, folderName: string): string {
  const withWorkspace = value.replaceAll('${workspaceFolderBasename}', folderName);
  return withWorkspace.replace(/\$\{env:([^}]+)\}/g, (_match, variable: string) => {
    const resolved = process.env[variable];
    if (resolved === undefined) {
      throw new Error(`环境变量 ${variable} 未设置。`);
    }
    return resolved;
  });
}

export function normalizeRemoteRoot(remotePath: string): string {
  const normalized = remotePath.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (normalized === '/') {
    return normalized;
  }
  return normalized.replace(/\/$/, '');
}

export function normalizeLocalPath(localPath: string): string {
  const normalized = localPath.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  return normalized || '.';
}

export function resolveLocalUploadRoot(workspacePath: string, localPath: string): string {
  const normalized = normalizeLocalPath(localPath);
  if (path.isAbsolute(normalized)) {
    throw new Error('项目上传目录必须填写工作区内的相对路径。');
  }
  const resolved = path.resolve(workspacePath, normalized);
  if (!isPathInsideRoot(workspacePath, resolved)) {
    throw new Error('项目上传目录不能超出当前工作区。');
  }
  return resolved;
}

export function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function defaultPort(protocol: TransferProtocol, profile?: UploadProfile): number {
  if (protocol === 'sftp') {
    return 22;
  }
  return profile?.secure === 'implicit' ? 990 : 21;
}

function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function validateConfigFile(value: unknown): asserts value is ExtensionConfigFile {
  if (!value || typeof value !== 'object') {
    throw new Error('配置内容必须是对象。');
  }
  const config = value as Partial<ExtensionConfigFile>;
  if (!config.profiles || typeof config.profiles !== 'object' || Array.isArray(config.profiles)) {
    throw new Error('配置文件必须包含 profiles 对象。');
  }

  if (config.defaultProfile && !Object.hasOwn(config.profiles, config.defaultProfile)) {
    throw new Error(`默认环境“${config.defaultProfile}”不存在。`);
  }
  validateIgnore(config.ignore, '全局 ignore');

  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!name.trim()) {
      throw new Error('上传环境名称不能为空。');
    }
    if (!profile || typeof profile !== 'object') {
      throw new Error(`环境“${name}”的配置无效。`);
    }
    if (profile.protocol !== 'sftp' && profile.protocol !== 'ftp') {
      throw new Error(`环境“${name}”的 protocol 只能是 sftp 或 ftp。`);
    }
    if (profile.authType !== undefined
      && profile.authType !== 'password'
      && profile.authType !== 'privateKey') {
      throw new Error(`环境“${name}”的 authType 只能是 password 或 privateKey。`);
    }
    if (profile.protocol === 'ftp' && profile.authType === 'privateKey') {
      throw new Error(`环境“${name}”使用 FTP 时只能选择密码登录。`);
    }
    for (const field of ['host', 'username', 'remotePath'] as const) {
      if (typeof profile[field] !== 'string' || !profile[field].trim()) {
        throw new Error(`环境“${name}”缺少 ${field}。`);
      }
    }
    if (profile.localPath !== undefined) {
      if (typeof profile.localPath !== 'string' || !profile.localPath.trim()) {
        throw new Error(`环境“${name}”的 localPath 不能为空。`);
      }
      const localPath = normalizeLocalPath(profile.localPath);
      if (path.isAbsolute(localPath) || localPath === '..' || localPath.startsWith('../')) {
        throw new Error(`环境“${name}”的 localPath 必须是工作区内的相对路径。`);
      }
    }
    if (profile.port !== undefined
      && (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65_535)) {
      throw new Error(`环境“${name}”的 port 必须在 1 到 65535 之间。`);
    }
    if (profile.connectTimeout !== undefined
      && (!Number.isInteger(profile.connectTimeout) || profile.connectTimeout < 1_000)) {
      throw new Error(`环境“${name}”的 connectTimeout 不能小于 1000 毫秒。`);
    }
    if (profile.secure !== undefined
      && profile.secure !== true
      && profile.secure !== false
      && profile.secure !== 'implicit') {
      throw new Error(`环境“${name}”的 secure 配置无效。`);
    }
    validateIgnore(profile.ignore, `环境“${name}”的 ignore`);
  }
}

function normalizeAuthenticationConfig(config: ExtensionConfigFile): ExtensionConfigFile {
  const normalized = JSON.parse(JSON.stringify(config)) as ExtensionConfigFile;
  for (const profile of Object.values(normalized.profiles)) {
    const legacyProfile = profile as UploadProfile & { agent?: string };
    delete legacyProfile.agent;
    const authType: AuthenticationType = profile.protocol === 'ftp'
      ? 'password'
      : profile.authType ?? (profile.privateKeyPath ? 'privateKey' : 'password');
    profile.authType = authType;
    profile.localPath = normalizeLocalPath(profile.localPath ?? '.');
    if (authType === 'password') {
      delete profile.privateKeyPath;
      delete profile.passphrase;
    } else {
      delete profile.password;
    }
  }
  return normalized;
}

function validateIgnore(value: string[] | undefined, label: string): void {
  if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) {
    throw new Error(`${label} 必须是字符串数组。`);
  }
}
