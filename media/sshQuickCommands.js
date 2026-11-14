(() => {
  const vscode = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const terminalHost = byId('terminal');
  const quickCommand = byId('quick-command');
  const quickToggle = byId('quick-command-toggle');
  const copyButton = byId('copy');
  const terminalFeedback = byId('terminal-feedback');
  const sessionDetail = byId('session-detail');
  const libraryToggle = byId('library-toggle');
  const library = byId('library');
  const commandList = byId('commands');
  const saveToggle = byId('save-toggle');
  const saveForm = byId('save-form');
  const commandInput = byId('command');
  const nameInput = byId('name');
  const clearButton = byId('clear');
  const executeButton = byId('execute');
  const saveButton = byId('save');
  const deleteButton = byId('remove');
  const collapseButton = byId('hide');
  const feedback = byId('feedback');

  const builtInGroups = [
    {
      label: '内置 · 文件与目录',
      entries: [
        { id: 'builtin:pwd', name: '当前目录', command: 'pwd' },
        { id: 'builtin:ls', name: '列出文件（含隐藏文件）', command: 'ls -lah --color=auto' },
        { id: 'builtin:du', name: '当前目录占用', command: 'du -sh .' },
      ],
    },
    {
      label: '内置 · 系统与资源',
      entries: [
        { id: 'builtin:os', name: 'Linux 版本', command: 'cat /etc/os-release' },
        { id: 'builtin:uptime', name: '运行时间与负载', command: 'uptime' },
        { id: 'builtin:df', name: '磁盘空间', command: 'df -h' },
        { id: 'builtin:free', name: '内存用量', command: 'free -h' },
        { id: 'builtin:ps', name: 'CPU 占用前 10 个进程', command: 'ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu | head -n 11' },
      ],
    },
    {
      label: '内置 · 网络与服务',
      entries: [
        { id: 'builtin:ip', name: '网卡与 IP 地址', command: 'ip -br addr' },
        { id: 'builtin:ss', name: 'TCP 和 UDP 监听端口', command: 'ss -lntu' },
        { id: 'builtin:services', name: '失败的 systemd 服务', command: 'systemctl --failed --no-pager' },
        { id: 'builtin:journal', name: '最近 50 条系统日志', command: 'journalctl -n 50 --no-pager' },
      ],
    },
  ];
  let sessionId;
  let connected = false;
  let commands = [];
  let editingId;
  let collapsed = true;
  let pending;

  const isMac = /Mac/i.test(navigator.platform);
  byId('execute-shortcut').textContent = isMac ? '⌘ Enter' : 'Ctrl+Enter';
  commandInput.placeholder = `输入命令，Enter 换行，${isMac ? '⌘ Enter' : 'Ctrl+Enter'} 执行`;
  executeButton.setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter');

  function terminalTheme() {
    const style = getComputedStyle(document.documentElement);
    const theme = {};
    for (const [option, color] of Object.entries({
      foreground: 'foreground', background: 'background', cursor: 'cursor-foreground',
      cursorAccent: 'cursor-background', selectionBackground: 'selectionBackground',
      black: 'ansiBlack', red: 'ansiRed', green: 'ansiGreen', yellow: 'ansiYellow',
      blue: 'ansiBlue', magenta: 'ansiMagenta', cyan: 'ansiCyan', white: 'ansiWhite',
      brightBlack: 'ansiBrightBlack', brightRed: 'ansiBrightRed', brightGreen: 'ansiBrightGreen',
      brightYellow: 'ansiBrightYellow', brightBlue: 'ansiBrightBlue', brightMagenta: 'ansiBrightMagenta',
      brightCyan: 'ansiBrightCyan', brightWhite: 'ansiBrightWhite',
    })) {
      const value = style.getPropertyValue(`--vscode-terminal-${color}`).trim();
      if (value) theme[option] = value;
    }
    theme.background ||= style.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';
    theme.foreground ||= style.getPropertyValue('--vscode-editor-foreground').trim() || '#d4d4d4';
    return theme;
  }

  const terminal = new Terminal({
    theme: terminalTheme(),
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
    fontSize: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-font-size')) || 13,
    cursorBlink: true,
    minimumContrastRatio: 4.5,
    scrollback: 5_000,
  });
  const fitter = new FitAddon.FitAddon();
  terminal.loadAddon(fitter);
  terminal.open(terminalHost);
  terminal.onData((data) => vscode.postMessage({ type: 'input', data }));
  terminal.onSelectionChange(() => { copyButton.disabled = !terminal.hasSelection(); });
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || event.key.toLowerCase() !== 'c' || !terminal.hasSelection()) return true;
    if (isMac) return !event.metaKey;
    if (!event.ctrlKey || !event.shiftKey) return true;
    event.preventDefault();
    void copySelection();
    return false;
  });
  copyButton.addEventListener('click', () => void copySelection());

  async function copySelection() {
    const selection = terminal.getSelection();
    if (!selection) return;
    terminal.focus();
    try {
      if (!document.execCommand('copy')) await navigator.clipboard.writeText(selection);
      terminalFeedback.textContent = '已复制终端选中内容';
    } catch {
      terminalFeedback.textContent = '复制失败，请使用编辑菜单中的复制';
    }
  }

  let fitFrame;
  let lastSize = '';
  function fit(type) {
    fitter.fit();
    const { cols, rows } = terminal;
    const size = `${cols}:${rows}`;
    if (type === 'ready' || size !== lastSize) vscode.postMessage({ type, cols, rows });
    lastSize = size;
  }
  new ResizeObserver(() => {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => fit('resize'));
  }).observe(terminalHost);
  new MutationObserver(() => {
    terminal.options.theme = terminalTheme();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  function renderLibrary() {
    const groups = commands.length ? [{ label: '工作区命令', entries: commands, editable: true }, ...builtInGroups] : builtInGroups;
    const list = document.createDocumentFragment();
    for (const { label, entries, editable } of groups) {
      const heading = document.createElement('h2');
      heading.className = 'command-group-label';
      heading.textContent = label;
      list.append(heading);
      for (const entry of entries) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'command-item';
        button.title = entry.command;
        const name = document.createElement('span');
        name.textContent = entry.name;
        const preview = document.createElement('code');
        preview.textContent = entry.command;
        button.append(name, preview);
        button.addEventListener('click', () => loadCommand(entry, editable));
        list.append(button);
      }
    }
    commandList.replaceChildren(list);
  }

  function setLibrary(open) {
    library.hidden = !open;
    libraryToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      renderLibrary();
      commandList.querySelector('button')?.focus();
    } else {
      setSaveForm(false);
    }
  }

  function setSaveForm(open) {
    saveForm.hidden = !open;
    saveToggle.setAttribute('aria-expanded', String(open));
    if (open) nameInput.focus();
  }

  function renderCollapse() {
    quickCommand.hidden = collapsed;
    quickToggle.setAttribute('aria-expanded', String(!collapsed));
    if (collapsed) setLibrary(false);
  }

  function updateControls() {
    const busy = Boolean(pending);
    const hasCommand = Boolean(commandInput.value.trim());
    const editing = commands.some(({ id }) => id === editingId);
    libraryToggle.disabled = busy;
    clearButton.disabled = busy || !(commandInput.value || nameInput.value || editingId);
    executeButton.disabled = collapsed || busy || !sessionId || !connected || !hasCommand;
    saveToggle.disabled = busy || !hasCommand;
    saveToggle.textContent = editing ? '更新当前命令' : '保存当前命令';
    saveButton.disabled = busy || !hasCommand || !nameInput.value.trim();
    saveButton.textContent = editing ? '更新' : '保存';
    deleteButton.hidden = !editing;
    deleteButton.disabled = busy;
  }

  function showFeedback(message, state = 'pending') {
    feedback.dataset.state = state;
    feedback.textContent = message;
  }

  function resetCommand() {
    editingId = undefined;
    nameInput.value = '';
    commandInput.value = '';
  }

  function request(operation, values, message) {
    if (pending) return;
    pending = { type: operation, ...values };
    showFeedback(message);
    updateControls();
    vscode.postMessage(pending);
  }

  function execute() {
    if (executeButton.disabled) return;
    request('execute', { sessionId, command: commandInput.value }, '正在发送…');
  }

  commandInput.addEventListener('input', updateControls);
  nameInput.addEventListener('input', updateControls);
  commandInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey) || event.isComposing) return;
    event.preventDefault();
    if (!event.repeat) execute();
  });
  executeButton.addEventListener('click', execute);
  function loadCommand(entry, editable) {
    if (pending) return;
    editingId = editable ? entry.id : undefined;
    nameInput.value = entry.name;
    commandInput.value = entry.command;
    showFeedback('');
    setLibrary(false);
    updateControls();
    commandInput.focus();
  }
  libraryToggle.addEventListener('click', () => {
    setLibrary(library.hidden);
  });
  quickToggle.addEventListener('click', () => vscode.postMessage({ type: collapsed ? 'show' : 'hide' }));
  collapseButton.addEventListener('click', () => vscode.postMessage({ type: 'hide' }));
  document.addEventListener('pointerdown', (event) => {
    if (!library.hidden && !library.contains(event.target) && !libraryToggle.contains(event.target)) setLibrary(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || library.hidden) return;
    event.preventDefault();
    setLibrary(false);
    libraryToggle.focus();
  });
  clearButton.addEventListener('click', () => {
    resetCommand();
    showFeedback('');
    updateControls();
    if (!collapsed) commandInput.focus();
  });
  saveToggle.addEventListener('click', () => setSaveForm(saveForm.hidden));
  byId('cancel-save').addEventListener('click', () => {
    setSaveForm(false);
    saveToggle.focus();
  });
  saveForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (saveButton.disabled) return;
    request('save', { id: editingId, name: nameInput.value.trim(), command: commandInput.value }, '正在保存…');
  });
  deleteButton.addEventListener('click', () => {
    if (deleteButton.disabled || !editingId) return;
    request('delete', { id: editingId }, '等待删除确认…');
  });

  window.addEventListener('message', ({ data }) => {
    if (data?.type === 'output' && typeof data.data === 'string') {
      terminal.write(data.data);
      return;
    }
    if (data?.type === 'state') {
      sessionId = data.activeSessionId;
      connected = data.connected === true;
      terminal.options.disableStdin = data.closed === true;
      byId('session-title').textContent = data.title;
      byId('session-endpoint').textContent = data.endpoint;
      sessionDetail.textContent = connected ? '已连接' : data.closed ? '已断开' : '正在连接';
      sessionDetail.dataset.state = connected ? 'connected' : data.closed ? 'closed' : 'connecting';
      const libraryChanged = JSON.stringify(commands) !== JSON.stringify(data.commands);
      commands = data.commands;
      const wasCollapsed = collapsed;
      collapsed = data.collapsed === true;
      if (!pending && !commands.some(({ id }) => id === editingId)) editingId = undefined;
      renderCollapse();
      if (libraryChanged && !library.hidden) renderLibrary();
      updateControls();
      if (wasCollapsed && !collapsed) commandInput.focus();
      else if (!wasCollapsed && collapsed) terminal.focus();
      return;
    }
    if (data?.type !== 'result' || data.operation !== pending?.type) return;
    const submittedCommand = pending.command;
    pending = undefined;
    if (data.ok && data.operation === 'execute' && commandInput.value === submittedCommand) {
      resetCommand();
      if (!collapsed && (document.activeElement === document.body || document.activeElement === executeButton)) {
        commandInput.focus();
      }
    } else if (data.ok && data.operation === 'save' && data.commandId) {
      editingId = data.commandId;
      setLibrary(false);
      if (!collapsed) commandInput.focus();
    } else if (data.ok && data.operation === 'delete') {
      editingId = undefined;
      setLibrary(false);
      if (!collapsed) commandInput.focus();
    }
    showFeedback(data.message, data.ok ? 'done' : 'error');
    updateControls();
  });

  fit('ready');
  if (document.activeElement === document.body) terminal.focus();
})();
