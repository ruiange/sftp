import { lstat, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { minimatch } from 'minimatch';
import * as vscode from 'vscode';
import { createRemoteClient } from './clients';
import { resolveLocalUploadRoot } from './config';
import type { Logger } from './logger';
import type { LoadedProfile, UploadEntry, UploadResult } from './types';

interface CollectionResult {
  entries: UploadEntry[];
  skipped: number;
}

export class Uploader {
  public constructor(private readonly logger: Logger) {}

  public async upload(
    loaded: LoadedProfile,
    resources: vscode.Uri[],
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
  ): Promise<UploadResult> {
    const collection = await this.collectEntries(loaded, resources, token);
    if (collection.entries.length === 0) {
      return { uploaded: 0, skipped: collection.skipped, bytes: 0 };
    }

    const profile = loaded.profile;
    const client = createRemoteClient(profile.protocol);
    let uploaded = 0;
    let bytes = 0;

    this.logger.info(
      `连接 ${profile.protocol.toUpperCase()} ${profile.host}:${profile.port}（环境：${profile.name}）`,
    );
    progress.report({ message: `正在连接 ${profile.host}…` });

    try {
      await client.connect(profile);
      this.logger.info(`连接成功，准备上传 ${collection.entries.length} 个文件。`);

      for (const entry of collection.entries) {
        if (token.isCancellationRequested) {
          this.logger.info('上传已由用户取消。');
          break;
        }

        progress.report({
          message: `${uploaded + 1}/${collection.entries.length} ${entry.relativePath}`,
          increment: 100 / collection.entries.length,
        });
        await client.uploadFile(entry.localPath, entry.remotePath);
        uploaded += 1;
        bytes += entry.size;
        this.logger.info(`已上传 ${entry.relativePath} → ${entry.remotePath}`);
      }

      return { uploaded, skipped: collection.skipped, bytes };
    } finally {
      try {
        await client.disconnect();
      } catch (error) {
        this.logger.error(`断开连接时发生错误：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  public async testConnection(loaded: LoadedProfile): Promise<void> {
    const client = createRemoteClient(loaded.profile.protocol);
    const { profile } = loaded;
    this.logger.info(
      `测试 ${profile.protocol.toUpperCase()} ${profile.host}:${profile.port}（环境：${profile.name}）`,
    );
    try {
      await client.connect(profile);
      this.logger.info('连接测试成功。');
    } finally {
      await client.disconnect();
    }
  }

  private async collectEntries(
    loaded: LoadedProfile,
    resources: vscode.Uri[],
    token: vscode.CancellationToken,
  ): Promise<CollectionResult> {
    const entries = new Map<string, UploadEntry>();
    let skipped = 0;
    const uploadRoot = resolveLocalUploadRoot(
      loaded.workspaceFolder.uri.fsPath,
      loaded.profile.localPath,
    );

    const visit = async (localPath: string): Promise<void> => {
      if (token.isCancellationRequested) {
        return;
      }

      const relativePath = toUploadRelativePath(uploadRoot, localPath);
      if (relativePath !== '' && isIgnored(relativePath, loaded.profile.ignore)) {
        skipped += 1;
        return;
      }

      const stat = await lstat(localPath);
      if (stat.isSymbolicLink()) {
        skipped += 1;
        this.logger.info(`已跳过符号链接：${relativePath || localPath}`);
        return;
      }

      if (stat.isDirectory()) {
        const children = await readdir(localPath, { withFileTypes: true });
        children.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
          await visit(path.join(localPath, child.name));
        }
        return;
      }

      if (!stat.isFile()) {
        skipped += 1;
        return;
      }

      entries.set(localPath, {
        localPath,
        relativePath,
        remotePath: path.posix.join(loaded.profile.remotePath, relativePath),
        size: stat.size,
      });
    };

    for (const resource of resources) {
      if (resource.scheme !== 'file') {
        skipped += 1;
        continue;
      }
      const resourcePath = path.resolve(resource.fsPath) === path.resolve(loaded.workspaceFolder.uri.fsPath)
        ? uploadRoot
        : resource.fsPath;
      await visit(resourcePath);
    }

    return { entries: [...entries.values()], skipped };
  }
}

function toUploadRelativePath(uploadRoot: string, localPath: string): string {
  const relativePath = path.relative(uploadRoot, localPath);
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`只能上传项目上传目录“${uploadRoot}”内的文件：${localPath}`);
  }
  return relativePath.split(path.sep).join('/');
}

function isIgnored(relativePath: string, patterns: string[]): boolean {
  const normalized = relativePath.replace(/^\.\//, '').replace(/\\/g, '/');
  let ignored = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const normalizedPattern = (negated ? pattern.slice(1) : pattern).replace(/\\/g, '/');
    const matches = minimatch(normalized, normalizedPattern, { dot: true })
      || minimatch(`${normalized}/`, normalizedPattern, { dot: true });
    if (matches) {
      ignored = !negated;
    }
  }
  return ignored;
}
