import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, type ClientChannel, type HostVerifier } from 'ssh2';
import * as vscode from 'vscode';
import { normalizeSshHost, toErrorMessage } from './config';
import { SshLogColors } from './sshLogColors';
import type { ResolvedProfile } from './types';

const HOST_CONFIRMATION_TIMEOUT = 120_000;
const MAX_QUICK_COMMAND_BYTES = 16 * 1024;
type ConnectionStage = 'tcp' | 'identification' | 'handshake' | 'hostConfirmation' | 'authentication' | 'shell' | 'connected';
const stageNames: Record<ConnectionStage, string> = {
  tcp: '建立 TCP 连接',
  identification: '等待服务器 SSH 标识',
  handshake: '交换 SSH 密钥',
  hostConfirmation: '等待确认服务器指纹',
  authentication: '等待 SSH 登录认证',
  shell: '打开交互式终端',
  connected: 'SSH 会话',
};

export interface SshTerminalSession {
  readonly endpoint: string;
  open(dimensions?: vscode.TerminalDimensions): void;
  close(): void;
  handleInput(data: string): void;
  setDimensions(dimensions: vscode.TerminalDimensions): void;
  isConnected(): boolean;
  sendCommand(command: string): Promise<void>;
}

interface SshTerminalCallbacks {
  onOutput(data: string): void;
  onStateChange(): void;
  onClose(message?: string): void;
}

export function createSshTerminal(
  profile: ResolvedProfile,
  storage: vscode.Memento,
  colorizeLogs: boolean,
  callbacks: SshTerminalCallbacks,
): SshTerminalSession {
  if (profile.protocol !== 'sftp') {
    throw new Error('打开 SSH 终端前，请先切换到 SFTP 环境。');
  }
  if (profile.authType === 'password' && !profile.password) {
    throw new Error('请在当前 SFTP 环境中保存 SSH 登录密码。');
  }
  if (profile.authType === 'privateKey' && !profile.privateKeyPath?.trim()) {
    throw new Error('请在当前 SFTP 环境中配置 SSH 私钥路径。');
  }

  const host = normalizeSshHost(profile.host);
  if (!host || !profile.username.trim()) {
    throw new Error('请检查当前 SFTP 环境的服务器地址和用户名。');
  }

  return new SshTerminal(
    { ...profile, host, username: profile.username.trim() },
    storage,
    colorizeLogs,
    callbacks,
  );
}

class SshTerminal implements SshTerminalSession {
  private readonly client = new Client();

  public readonly endpoint: string;
  private readonly hostKey: string;
  private readonly logColors?: SshLogColors;
  private readonly terminalModes = new TerminalModes();
  private channel?: ClientChannel;
  private dimensions?: vscode.TerminalDimensions;
  private stage: ConnectionStage = 'tcp';
  private stageTimer?: NodeJS.Timeout;
  private onCommandClosed?: () => void;
  private opened = false;
  private closed = false;

  public constructor(
    private readonly profile: ResolvedProfile,
    private readonly storage: vscode.Memento,
    colorizeLogs: boolean,
    private readonly callbacks: SshTerminalCallbacks,
  ) {
    const { host, port, username } = profile;
    this.endpoint = `${username}@${host.includes(':') ? `[${host}]` : host}:${port}`;
    // 继续使用此前命令台保存的服务器指纹。
    this.hostKey = `sshConsole.hostKey:${JSON.stringify([host.toLowerCase(), port])}`;
    if (colorizeLogs) this.logColors = new SshLogColors(username, (data) => this.callbacks.onOutput(data));
  }

  public open(dimensions?: vscode.TerminalDimensions): void {
    if (this.closed || this.opened) return;
    this.opened = true;
    this.dimensions = dimensions ?? this.dimensions;
    this.callbacks.onOutput('正在连接 SSH…\r\n');
    this.client.on('error', (error) => this.fail(error));
    this.client.once('change password', () => this.fail(new Error('服务器要求修改 SSH 登录密码。')));
    this.client.once('close', () => this.fail(new Error('SSH 连接已断开。')));
    this.client.once('connect', () => this.setStage('identification'));
    this.client.once('handshake', () => this.setStage('authentication'));
    this.client.once('ready', () => this.openShell());
    void this.connect().catch((error: unknown) => this.fail(error));
  }

  public close(): void {
    this.finish();
  }

  public handleInput(data: string): void {
    if (this.channel) {
      if (this.isConnected()) this.channel.write(data);
    } else if (data === '\x03' && this.opened) {
      this.finish('已取消 SSH 连接。');
    }
  }

  public isConnected(): boolean {
    return !this.closed && this.stage === 'connected' && this.channel?.writable === true && !this.channel.readableEnded;
  }

  public async sendCommand(command: string): Promise<void> {
    const channel = this.channel;
    if (!channel || !this.isConnected()) {
      throw new Error('SSH 会话尚未连接或已断开，请重新选择会话。');
    }
    if (this.onCommandClosed) {
      throw new Error('命令正在发送，请稍候。');
    }

    const text = command.replace(/\r\n/g, '\n');
    if (!text.trim()) {
      throw new Error('请输入命令。');
    }
    if (Buffer.byteLength(text) > MAX_QUICK_COMMAND_BYTES) {
      throw new Error('命令最多支持 16 KB。');
    }
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) {
      throw new Error('命令含有不支持的终端控制字符。');
    }
    if (this.terminalModes.alternateScreen) {
      throw new Error('请先退出当前全屏程序并返回 Shell，再发送快捷命令。');
    }
    const bracketedPaste = this.terminalModes.bracketedPaste;
    if (!bracketedPaste && /[\n\t]/.test(text)) {
      throw new Error('当前会话未启用括号粘贴，只能发送不含换行或制表符的单行命令。');
    }
    // 括号粘贴将多行作为一次输入，最后一个回车提交给当前终端程序。
    const data = bracketedPaste ? `\x1b[200~${text.replace(/\n/g, '\r')}\x1b[201~\r` : `${text}\r`;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error | null): void => {
        clearTimeout(timer);
        if (this.onCommandClosed === onClose) this.onCommandClosed = undefined;
        if (error) reject(error);
        else resolve();
      };
      const onClose = (): void => finish(new Error('发送时 SSH 会话已断开，请先检查终端。'));
      const timer = setTimeout(() => finish(new Error('发送超时，请先在终端确认命令是否收到。')), this.profile.connectTimeout);
      this.onCommandClosed = onClose;
      try {
        channel.write(data, finish);
      } catch (error) {
        finish(new Error(toErrorMessage(error)));
      }
    });
  }

  public setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.dimensions = dimensions;
    this.channel?.setWindow(dimensions.rows, dimensions.columns, 0, 0);
  }

  private async connect(): Promise<void> {
    const { host, port, username, authType, password, privateKeyPath, passphrase } = this.profile;
    const privateKey = authType === 'privateKey' && privateKeyPath ? await readFile(privateKeyPath) : undefined;
    if (this.closed) return;

    if (authType === 'password' && password) {
      let passwordSent = false;
      this.client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, answer) => {
        if (this.closed) return;
        const [prompt] = prompts;
        if (!passwordSent && prompts.length === 1 && !prompt.echo && /^password\s*:\s*$/i.test(prompt.prompt.trim())) {
          passwordSent = true;
          answer([password]);
        } else {
          this.fail(new Error('服务器要求额外的 SSH 登录验证。'));
        }
      });
    }

    const hostVerifier: HostVerifier = (key, verify) => {
      void this.verifyHost(key).then(() => {
        if (!this.closed) {
          if (this.stage !== 'connected') this.setStage('handshake');
          verify(true);
        }
      }).catch((error: unknown) => this.fail(error));
    };

    this.setStage('tcp');
    this.client.connect({
      host,
      port,
      username,
      password: authType === 'password' ? password : undefined,
      privateKey,
      passphrase: privateKey ? passphrase : undefined,
      tryKeyboard: authType === 'password',
      // ssh2 的计时覆盖整个登录过程。每个阶段由终端独立计时。
      readyTimeout: 0,
      debug: (message) => {
        if (this.stage === 'identification' && message.startsWith('Remote ident:')) {
          this.setStage('handshake');
        }
      },
      keepaliveInterval: 15_000,
      hostVerifier,
    });
  }

  private async verifyHost(key: Buffer): Promise<void> {
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
    let saved = this.storage.get<string>(this.hostKey);
    if (!saved) {
      this.setStage('hostConfirmation', HOST_CONFIRMATION_TIMEOUT);
      const answer = await vscode.window.showWarningMessage(
        `首次连接 ${this.endpoint}，请核对服务器指纹。`,
        { modal: true, detail: fingerprint },
        '信任并连接',
      );
      if (this.closed) return;
      if (answer !== '信任并连接') throw new Error('已取消服务器指纹确认。');
      saved = this.storage.get<string>(this.hostKey);
      if (!saved) await this.storage.update(this.hostKey, fingerprint);
    }
    if (saved && saved !== fingerprint) {
      throw new Error(`服务器指纹已变更。记录：${saved}，当前：${fingerprint}`);
    }
  }

  private openShell(): void {
    this.setStage('shell');
    const { rows, columns } = this.dimensions ?? { rows: 24, columns: 80 };
    this.client.shell({ term: 'xterm-256color', rows, cols: columns }, (error, channel) => {
      if (error) {
        this.fail(error);
        return;
      }
      if (this.closed) {
        channel.close();
        return;
      }
      this.setStage('connected');
      this.channel = channel;
      for (const stream of [channel, channel.stderr]) {
        stream.on('error', (cause) => this.fail(cause));
        stream.setEncoding('utf8').on('data', (data: string) => {
          if (this.closed) return;
          this.terminalModes.read(data);
          if (this.logColors) this.logColors.write(data);
          else this.callbacks.onOutput(data);
        });
      }
      channel.once('end', () => {
        if (this.closed) return;
        this.logColors?.flush();
        // 等待服务端发送退出状态和关闭消息，避免截断 EOF 后的退出码。
        this.stageTimer = setTimeout(() => this.finish('SSH 会话已结束。'), this.profile.connectTimeout);
        this.callbacks.onStateChange();
      });
      channel.once('close', (code?: number | null, signal?: string) => {
        const reason = signal ? `SSH 会话已结束（${signal}）。`
          : code ? `SSH 会话已退出（退出码 ${code}）。`
          : 'SSH 会话已退出。';
        this.finish(reason);
      });
      if (this.dimensions && (this.dimensions.rows !== rows || this.dimensions.columns !== columns)) {
        this.setDimensions(this.dimensions);
      }
      this.callbacks.onStateChange();
    });
  }

  private setStage(stage: ConnectionStage, timeout = this.profile.connectTimeout): void {
    if (this.closed) return;
    clearTimeout(this.stageTimer);
    this.stage = stage;
    if (stage !== 'connected') {
      this.stageTimer = setTimeout(() => this.fail(new Error(`${stageNames[stage]}超时（${timeout / 1_000} 秒）。`)), timeout);
    }
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.finish(`${stageNames[this.stage]}：${toErrorMessage(error)}`);
  }

  private finish(message?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onCommandClosed?.();
    clearTimeout(this.stageTimer);
    this.logColors?.flush();
    this.channel?.close();
    this.channel = undefined;
    this.client.destroy();
    this.callbacks.onClose(message);
    this.callbacks.onStateChange();
  }
}

type TerminalControl = 'text' | 'escape' | 'csi' | 'string' | 'stringEscape';

class TerminalModes {
  public bracketedPaste = false;
  public alternateScreen = false;
  private control: TerminalControl = 'text';
  private csi: string | undefined;
  private osc = false;

  public read(data: string): void {
    const introducer = /[\x1b\x90\x98\x9b\x9d-\x9f]/g;
    for (let index = 0; index < data.length; index += 1) {
      if (this.control === 'text') {
        introducer.lastIndex = index;
        const next = introducer.exec(data);
        if (!next) return;
        index = next.index;
      }
      this.readControl(data[index]);
    }
  }

  private readControl(character: string): void {
    if (character === '\x18' || character === '\x1a') {
      this.control = 'text';
      return;
    }
    if (this.control === 'string' || this.control === 'stringEscape') {
      const terminated = character === '\x9c' || (this.osc && character === '\x07')
        || (this.control === 'stringEscape' && character === '\\');
      this.control = terminated ? 'text' : (character === '\x1b' ? 'stringEscape' : 'string');
      return;
    }
    if (character === '\x1b') {
      this.control = 'escape';
      return;
    }
    if (this.control === 'csi') {
      if (character >= '@' && character <= '~') {
        this.finishCsi(character);
        this.control = 'text';
      } else if (character >= ' ' && this.csi !== undefined) {
        this.csi = this.csi.length < 64 ? this.csi + character : undefined;
      }
      return;
    }
    if (this.control === 'escape') {
      if (character === '[') {
        this.control = 'csi';
        this.csi = '';
      } else if (']PX^_'.includes(character)) {
        this.control = 'string';
        this.osc = character === ']';
      } else {
        if (character === 'c') this.reset();
        this.control = 'text';
      }
      return;
    }
    if (character === '\x9b') {
      this.control = 'csi';
      this.csi = '';
    } else {
      this.control = 'string';
      this.osc = character === '\x9d';
    }
  }

  private finishCsi(final: string): void {
    if (final === 'p' && this.csi === '!') this.bracketedPaste = false;
    if ((final !== 'h' && final !== 'l') || !this.csi || !/^\?[\d;]+$/.test(this.csi)) return;
    const enabled = final === 'h';
    const modes = this.csi.slice(1).split(';');
    if (modes.includes('2004')) this.bracketedPaste = enabled;
    if (modes.some((mode) => mode === '47' || mode === '1047' || mode === '1049')) this.alternateScreen = enabled;
  }

  private reset(): void {
    this.bracketedPaste = false;
    this.alternateScreen = false;
  }
}
