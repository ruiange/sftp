const levels = {
  TRACE: 90,
  DEBUG: 36,
  INFO: 32,
  WARN: 33,
  WARNING: 33,
  ERROR: 31,
  FATAL: 31,
};
type LogLevel = keyof typeof levels;

const levelPattern = Object.keys(levels).join('|');
const timestampPattern = '\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?';
const logPrefix = new RegExp(`^(?:\\[(${levelPattern})\\]|(${levelPattern})(\\[${timestampPattern}\\]))`);
const prefixStarts = Object.keys(levels).flatMap((level) => [`[${level}]`, `${level}[`]);
const unfinishedTimestamp = new RegExp(`^(?:${levelPattern})\\[[0-9 T:.,+Z-]*$`);
const terminalControl = /[\x00-\x1f\x7f-\x9f]/;
const stringStarts = '\x90\x98\x9d\x9e\x9f';
const alternateScreen = /(?:^|;)(?:47|1047|1049)(?:;|$)/;
const MAX_PREFIX_LENGTH = 64;
const MAX_PROMPT_LENGTH = 256;
const PREFIX_WAIT_MS = 35;
const promptHost = '[a-zA-Z0-9_.-]{1,128}';
type ControlState = 'text' | 'escape' | 'escapeIntermediate' | 'csi' | 'string' | 'stringEscape';

export class SshLogColors {
  private atLineStart = true;
  private inAlternateScreen = false;
  private remoteStyle = false;
  private inOsc = false;
  private control: ControlState = 'text';
  private csi = '';
  private prefix = '';
  private flushTimer?: NodeJS.Timeout;
  private readonly promptUsers: string[];
  private readonly prompt: RegExp;
  private readonly unfinishedPrompt: RegExp;

  public constructor(username: string, private readonly emit: (output: string) => void) {
    this.promptUsers = [...new Set([username, 'root'])].map((name) => `${name}@`);
    const users = this.promptUsers.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const host = `(?:${users})${promptHost}`;
    this.prompt = new RegExp(`^(${host}):((?:~|/).*?|[A-Za-z0-9_.-]+)([#$])(?= |$)`);
    this.unfinishedPrompt = new RegExp(`^(?:${users})(?:${promptHost}(?::[^\\r\\n]*)?)?$`);
  }

  public write(data: string): void {
    clearTimeout(this.flushTimer);
    let output = '';
    let textStart = 0;
    for (let index = 0; index < data.length; index += 1) {
      const character = data[index];
      if (this.control === 'text' && !terminalControl.test(character)) continue;

      if (index > textStart) output += this.colorText(data.slice(textStart, index));
      output += this.takePrefix() + character;
      this.readControl(character);
      textStart = index + 1;
    }
    if (textStart < data.length) output += this.colorText(data.slice(textStart));
    if (output) this.emit(output);
    // 只有可能被分块的日志标记或提示符才短暂等待。
    if (this.prefix) this.flushTimer = setTimeout(() => this.flush(), PREFIX_WAIT_MS);
  }

  public flush(): void {
    clearTimeout(this.flushTimer);
    const prefix = this.takePrefix();
    if (prefix) this.emit(prefix);
  }

  private colorText(text: string): string {
    if (!this.atLineStart || this.inAlternateScreen || this.remoteStyle) return text;

    const candidate = this.prefix + text;
    this.prefix = '';
    const match = logPrefix.exec(candidate);
    if (match) {
      this.atLineStart = false;
      const [, bracketedLevel, level, time] = match;
      const color = levels[(bracketedLevel ?? level) as LogLevel];
      const prefix = bracketedLevel ? `[${ansi(color, bracketedLevel)}]` : ansi(color, level) + ansi(35, time);
      return prefix + candidate.slice(match[0].length);
    }
    const promptMatch = this.prompt.exec(candidate);
    if (promptMatch) {
      this.atLineStart = false;
      const [prefix, userAndHost, directory, symbol] = promptMatch;
      return `${ansi(32, userAndHost)}:${ansi(36, directory)}${symbol}${candidate.slice(prefix.length)}`;
    }
    const splitLog = candidate.length < MAX_PREFIX_LENGTH
      && (prefixStarts.some((start) => start.startsWith(candidate)) || unfinishedTimestamp.test(candidate));
    const splitPrompt = candidate.length < MAX_PROMPT_LENGTH
      && (this.promptUsers.some((start) => start.startsWith(candidate)) || this.unfinishedPrompt.test(candidate));
    if (splitLog || splitPrompt) {
      this.prefix = candidate;
      return '';
    }
    this.atLineStart = false;
    return candidate;
  }

  private takePrefix(): string {
    const prefix = this.prefix;
    if (prefix) this.atLineStart = false;
    this.prefix = '';
    return prefix;
  }

  private readControl(character: string): void {
    if (character === '\x18' || character === '\x1a') {
      this.control = 'text';
      this.atLineStart = false;
      return;
    }
    switch (this.control) {
      case 'text':
        if (character === '\x1b') this.control = 'escape';
        else if (character === '\x9b') this.beginCsi();
        else if (stringStarts.includes(character)) this.beginString(character === '\x9d');
        else this.atLineStart = character === '\n' || character === '\r';
        break;
      case 'escape':
        if (character === '[') {
          this.beginCsi();
        } else if (']PX^_'.includes(character)) {
          this.beginString(character === ']');
        } else if (character >= ' ' && character <= '/') {
          this.control = 'escapeIntermediate';
        } else if (character !== '\x1b') {
          if (character === 'c') {
            this.remoteStyle = false;
            this.inAlternateScreen = false;
          }
          this.atLineStart = false;
          this.control = 'text';
        }
        break;
      case 'escapeIntermediate':
        if (character === '\x1b') this.control = 'escape';
        else if (character >= '0') {
          this.atLineStart = false;
          this.control = 'text';
        }
        break;
      case 'csi':
        if (character === '\x1b') {
          this.control = 'escape';
        } else if (character >= '@' && character <= '~') {
          this.finishCsi(character);
          this.control = 'text';
        } else if (character >= ' ' && this.csi.length < 64) {
          this.csi += character;
        }
        break;
      case 'string':
      case 'stringEscape':
        if ((this.inOsc && character === '\x07') || character === '\x9c' || (this.control === 'stringEscape' && character === '\\')) {
          this.control = 'text';
        } else {
          this.control = character === '\x1b' ? 'stringEscape' : 'string';
        }
        break;
    }
  }

  private beginCsi(): void {
    this.control = 'csi';
    this.csi = '';
  }

  private beginString(osc: boolean): void {
    this.inOsc = osc;
    this.control = 'string';
    if (!osc) this.atLineStart = false;
  }

  private finishCsi(final: string): void {
    // Leave remote SGR attributes alone until a full reset.
    if (final === 'm') {
      this.remoteStyle = !/^(?:0?;)*0?$/.test(this.csi);
      return;
    }
    if ((final === 'h' || final === 'l') && this.csi.startsWith('?') && alternateScreen.test(this.csi.slice(1))) {
      this.inAlternateScreen = final === 'h';
    }
    // Bash 在输出提示符前可能切换括号粘贴模式，或清除行尾。
    const bracketedPaste = (final === 'h' || final === 'l') && this.csi === '?2004';
    if (!bracketedPaste && (final !== 'K' || (this.csi !== '' && this.csi !== '0'))) {
      this.atLineStart = false;
    }
  }
}

function ansi(color: number, value: string): string {
  return `\x1b[${color}m${value}\x1b[39m`;
}
