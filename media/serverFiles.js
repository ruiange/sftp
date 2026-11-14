(() => {
  const vscode = acquireVsCodeApi();
  const find = (id) => document.getElementById(id);
  const rowsElement = find('files');
  const scopeButtons = document.querySelectorAll('[data-scope]');
  const fileTypes = new Set(['file', 'directory', 'link']);
  const typeLabels = { file: '文件', directory: '目录', link: '链接' };
  const marks = { file: '≡', directory: '▱', link: '↗' };
  const pageSize = 20;
  const dateFormat = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  let state = { scope: 'deployment', rootPath: '/', path: '/', connected: false, busy: true, rows: [] };
  let page = 0;
  let selectedPath;
  let previewPath;
  let pending = false;

  function isBusy() {
    return state.busy || pending;
  }

  function selected() {
    return state.rows.find((row) => row.path === selectedPath);
  }

  function openablePath() {
    const row = selected();
    return row?.type === 'file' ? row.path : previewPath;
  }

  function pageCount() {
    return Math.max(1, Math.ceil(state.rows.length / pageSize));
  }

  function send(type, values = {}) {
    if (type !== 'ready' && isBusy()) return;
    if (!['ready', 'configure'].includes(type)) {
      pending = true;
      updateControls();
    }
    vscode.postMessage({ type, ...values });
  }

  function formatSize(size) {
    if (!Number.isFinite(size) || size < 0) return '—';
    if (size < 1024) return `${size} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = size / 1024;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
  }

  function formatDate(timestamp) {
    if (!timestamp || !Number.isFinite(timestamp)) return '未知';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '未知';
    return dateFormat.format(date);
  }

  function updateControls() {
    const row = selected();
    const busy = isBusy();
    const connected = state.connected;
    const deployment = state.scope === 'deployment';
    find('configure').disabled = busy;
    for (const button of scopeButtons) {
      button.disabled = busy || !state.target;
      button.setAttribute('aria-pressed', String(button.dataset.scope === state.scope));
    }
    find('connect').disabled = busy || !state.target;
    find('connect').hidden = connected;
    find('empty-connect').disabled = busy || !state.target;
    find('refresh').disabled = busy || !connected;
    find('up').disabled = busy || !connected || state.path === state.rootPath;
    find('path').disabled = busy || !connected;
    find('go').disabled = busy || !connected;
    find('upload').disabled = busy || !connected;
    find('replace').disabled = busy || !connected || row?.type !== 'file';
    find('delete').disabled = busy || !connected || !row || row.path === state.rootPath;
    find('preview').disabled = busy || !connected || row?.type !== 'file';
    for (const id of ['create-file', 'create-directory', 'rename']) {
      const button = find(id);
      button.hidden = !deployment;
      button.disabled = busy || !connected || !deployment
        || (id === 'rename' && row?.type !== 'file' && row?.type !== 'directory');
    }
    const open = find('open');
    open.disabled = busy || !connected || !openablePath();
    open.textContent = deployment ? '在编辑器中编辑' : '在编辑器中只读打开';
    open.title = openablePath() || '';
    find('retry').disabled = busy || !state.target;
    find('pagination').hidden = pageCount() === 1;
    find('previous-page').disabled = busy || page === 0;
    find('next-page').disabled = busy || page + 1 >= pageCount();
    find('page-number').textContent = `${page + 1} / ${pageCount()}`;
    find('selection').textContent = row ? `已选择 ${row.name}` : '未选择文件';
    find('selection').title = row?.path || '';
    find('table-scroll').setAttribute('aria-busy', String(busy));
    const status = find('connection-status');
    status.dataset.state = busy ? 'busy' : state.error ? 'error' : connected ? 'connected' : 'disconnected';
    status.textContent = busy ? '处理中…' : state.error ? '操作失败' : connected ? '已连接' : '未连接';
    for (const [index, element] of [...rowsElement.children].entries()) {
      element.setAttribute('aria-selected', String(element.dataset.path === selectedPath));
      element.tabIndex = element.dataset.path === selectedPath || (!selectedPath && index === 0) ? 0 : -1;
    }
  }

  function setSelection(row, focus = false) {
    selectedPath = row?.path;
    updateControls();
    if (focus && row) {
      [...rowsElement.children].find((element) => element.dataset.path === row.path)?.focus();
    }
  }

  function activate(row) {
    if (isBusy() || !state.connected) return;
    if (row.type === 'directory') {
      send('navigate', { path: row.path });
    } else if (row.type === 'file') {
      requestPreview(row);
    }
  }

  function renderRows() {
    const fragment = document.createDocumentFragment();
    const visibleRows = state.rows.slice(page * pageSize, (page + 1) * pageSize);
    for (const row of visibleRows) {
      const element = document.createElement('tr');
      element.tabIndex = 0;
      element.dataset.path = row.path;
      element.setAttribute('aria-selected', String(row.path === selectedPath));
      element.setAttribute('aria-label', `${row.name}，${typeLabels[row.type]}${row.type === 'file' ? `，${formatSize(row.size)}` : ''}`);
      const nameCell = document.createElement('td');
      nameCell.title = row.path;
      const name = document.createElement('div');
      name.className = 'file-name';
      const mark = document.createElement('span');
      mark.className = `file-mark ${row.type}`;
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = marks[row.type];
      const label = document.createElement('span');
      label.className = 'file-name-label';
      label.textContent = row.name;
      name.append(mark, label);
      nameCell.append(name);
      element.append(nameCell);
      for (const [className, value] of [
        ['type-cell', typeLabels[row.type]],
        ['size-cell', row.type === 'directory' ? '—' : formatSize(row.size)],
        ['date-cell', formatDate(row.modifiedAt)],
      ]) {
        const cell = document.createElement('td');
        cell.className = className;
        cell.textContent = value;
        cell.title = value;
        element.append(cell);
      }
      element.addEventListener('click', () => setSelection(selectedPath === row.path ? undefined : row));
      element.addEventListener('dblclick', () => { setSelection(row); activate(row); });
      element.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          setSelection(row);
          activate(row);
        } else if (event.key === ' ') {
          event.preventDefault();
          setSelection(selectedPath === row.path ? undefined : row);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const index = visibleRows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1);
          const next = visibleRows[Math.min(visibleRows.length - 1, Math.max(0, index))];
          setSelection(next, true);
        }
      });
      fragment.append(element);
    }
    rowsElement.replaceChildren(fragment);
  }

  function clearPreview() {
    previewPath = undefined;
    find('preview-path').hidden = true;
    find('preview-content').hidden = true;
    find('preview-content').textContent = '';
    find('preview-empty').hidden = false;
    find('preview-message').textContent = '选择文件后点击「预览」';
  }

  function requestPreview(row) {
    if (isBusy() || row?.type !== 'file') return;
    previewPath = row.path;
    find('preview-path').textContent = row.path;
    find('preview-path').hidden = false;
    find('preview-empty').hidden = false;
    find('preview-content').hidden = true;
    find('preview-message').textContent = '正在读取文件内容…';
    send('preview', { path: row.path });
  }

  function renderState(message) {
    pending = false;
    const previousPath = state.path;
    const previousScope = state.scope;
    const previousRoot = state.rootPath;
    const previousEndpoint = state.target?.endpoint;
    const previousEnvironment = state.target?.name;
    const previousWorkspace = state.target?.workspace;
    state = {
      scope: message.scope === 'server' ? 'server' : 'deployment',
      rootPath: typeof message.rootPath === 'string' ? message.rootPath : '/',
      path: typeof message.path === 'string' ? message.path : '/',
      connected: message.connected === true,
      busy: message.busy === true,
      target: message.target && typeof message.target === 'object' ? message.target : undefined,
      error: typeof message.error === 'string' ? message.error : undefined,
      rows: Array.isArray(message.rows) ? message.rows.filter((row) => row
        && typeof row.name === 'string' && typeof row.path === 'string' && fileTypes.has(row.type)) : [],
    };
    const directoryChanged = previousPath !== state.path || previousScope !== state.scope || previousRoot !== state.rootPath
      || previousEndpoint !== state.target?.endpoint
      || previousEnvironment !== state.target?.name || previousWorkspace !== state.target?.workspace;
    if (directoryChanged) {
      page = 0;
      selectedPath = undefined;
      find('table-scroll').scrollTop = 0;
    } else {
      const selectedIndex = state.rows.findIndex((row) => row.path === selectedPath);
      if (selectedIndex < 0) selectedPath = undefined;
      page = selectedIndex < 0 ? Math.min(page, pageCount() - 1) : Math.floor(selectedIndex / pageSize);
    }
    if (directoryChanged || (previewPath && !state.rows.some((row) => row.path === previewPath))) clearPreview();
    find('endpoint').textContent = state.target?.endpoint || '请先配置服务器连接';
    find('endpoint').title = state.target?.workspace || '';
    find('environment').textContent = state.target?.name || '';
    find('environment').hidden = !state.target?.name;
    find('path').value = state.path;
    find('error-banner').hidden = !state.error;
    find('error-text').textContent = state.error || '';
    const empty = state.rows.length === 0;
    find('empty').hidden = !empty;
    find('empty-title').textContent = state.busy ? '正在处理…' : state.error ? '暂时无法读取此目录' : state.connected ? '此目录为空' : '浏览远程文件';
    const scopeDescription = state.scope === 'deployment' ? '从当前环境的部署目录开始浏览。' : '从当前账号可访问的根目录开始浏览。';
    find('empty-message').textContent = state.busy ? '请稍候。'
      : state.error ? '检查连接和账号权限，然后重试。'
        : state.connected ? '可以上传本地文件到当前目录。' : scopeDescription;
    find('empty-connect').hidden = state.connected || state.busy || !!state.error;
    find('file-count').textContent = state.busy ? '正在处理…' : state.connected ? `${state.rows.length} 个项目` : '尚未读取目录';
    renderRows();
    updateControls();
  }

  function renderPreview(message) {
    if (message.path === '') {
      pending = false;
      clearPreview();
      updateControls();
      return;
    }
    if (message.path !== previewPath) return;
    pending = false;
    const error = typeof message.error === 'string' ? message.error : undefined;
    const content = typeof message.content === 'string' ? message.content : undefined;
    find('preview-empty').hidden = content !== undefined && !error;
    find('preview-content').hidden = content === undefined || !!error;
    find('preview-content').textContent = content || '';
    find('preview-message').textContent = error || '无法预览此文件，请在编辑器中打开。';
    updateControls();
  }

  function turnPage(offset) {
    const next = page + offset;
    if (isBusy() || next < 0 || next >= pageCount()) return;
    page = next;
    selectedPath = undefined;
    find('table-scroll').scrollTop = 0;
    renderRows();
    updateControls();
  }

  window.addEventListener('message', ({ data: message }) => {
    if (message?.type === 'state') renderState(message);
    else if (message?.type === 'preview') renderPreview(message);
  });
  find('configure').addEventListener('click', () => send('configure'));
  for (const button of scopeButtons) {
    button.addEventListener('click', () => {
      const scope = button.dataset.scope;
      if (scope !== state.scope) send('scope', { scope });
    });
  }
  find('connect').addEventListener('click', () => send('connect'));
  find('empty-connect').addEventListener('click', () => send('connect'));
  find('refresh').addEventListener('click', () => send('refresh'));
  find('retry').addEventListener('click', () => send(state.connected ? 'refresh' : 'connect'));
  find('up').addEventListener('click', () => send('up'));
  find('upload').addEventListener('click', () => send('upload'));
  find('create-file').addEventListener('click', () => send('createFile'));
  find('create-directory').addEventListener('click', () => send('createDirectory'));
  find('replace').addEventListener('click', () => { const row = selected(); if (row?.type === 'file') send('replace', { path: row.path }); });
  find('rename').addEventListener('click', () => {
    const row = selected();
    if (row?.type === 'file' || row?.type === 'directory') send('rename', { path: row.path });
  });
  find('delete').addEventListener('click', () => { const row = selected(); if (row) send('delete', { path: row.path }); });
  find('preview').addEventListener('click', () => requestPreview(selected()));
  find('open').addEventListener('click', () => { const path = openablePath(); if (path) send('open', { path }); });
  find('previous-page').addEventListener('click', () => turnPage(-1));
  find('next-page').addEventListener('click', () => turnPage(1));
  find('path-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.connected) send('navigate', { path: find('path').value });
  });
  updateControls();
  send('ready');
})();
