(() => {
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('servers');
  const empty = document.getElementById('empty');
  const rows = new Map();
  let selectedId = vscode.getState()?.selectedId;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function glyph(className) {
    const node = element('span', `glyph ${className}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function setSelected(row, selected) {
    row.container.classList.toggle('selected', selected);
    row.connect.setAttribute('aria-current', String(selected));
    row.meta.hidden = !selected;
    if (!selected) row.actions.open = false;
  }

  function select(id) {
    const previous = rows.get(selectedId);
    if (previous && selectedId !== id) setSelected(previous, false);
    selectedId = id;
    if (id !== undefined) setSelected(rows.get(id), true);
    vscode.setState({ selectedId });
  }

  function updateLatency(row, { status, latency, detail }) {
    row.status.dataset.status = status;
    row.status.title = detail;
    row.latency.textContent = latency;
  }

  function makeRow(id) {
    const container = element('li', 'server-row');
    const connect = element('button', 'server-connect');
    connect.type = 'button';
    const name = element('span', 'server-name');
    const status = element('span', 'server-status');
    const latency = element('span', 'server-latency');
    const dot = element('span', 'server-dot');
    dot.setAttribute('aria-hidden', 'true');
    status.append(latency, dot);

    const meta = element('span', 'server-meta');
    const address = element('span', 'server-address');
    const protocol = element('span', 'server-protocol', 'SSH');
    const workspace = element('span', 'server-workspace');
    meta.append(address, protocol, workspace);
    connect.append(glyph('glyph-server'), name, status, meta);

    const open = () => {
      select(id);
      vscode.postMessage({ type: 'open', id });
    };
    connect.addEventListener('click', open);

    const actions = element('details', 'server-actions');
    const summary = element('summary', 'server-more');
    summary.title = '更多操作';
    summary.append(glyph('glyph-more'));
    const panel = element('div', 'server-menu');
    for (const [label, action, className] of [
      ['打开 SSH 终端', open],
      ['刷新延迟', () => vscode.postMessage({ type: 'refresh' })],
      ['删除环境', () => vscode.postMessage({ type: 'delete', id }), 'menu-action-danger'],
    ]) {
      const item = element('button', className ? `menu-action ${className}` : 'menu-action', label);
      item.type = 'button';
      item.addEventListener('click', () => {
        actions.open = false;
        summary.focus();
        action();
      });
      panel.append(item);
    }

    actions.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !actions.open) return;
      event.stopPropagation();
      actions.open = false;
      summary.focus();
    });
    actions.append(summary, panel);
    container.append(connect, actions);
    return { container, connect, name, status, latency, meta, address, workspace, actions, summary };
  }

  function render(servers) {
    const ids = new Set(servers.map(({ id }) => id));
    for (const [id, row] of rows) {
      if (ids.has(id)) continue;
      row.container.remove();
      rows.delete(id);
    }
    if (selectedId !== undefined && !ids.has(selectedId)) select(undefined);

    let position = list.firstElementChild;
    for (const server of servers) {
      const { id, name, address, workspace } = server;
      const row = rows.get(id) ?? makeRow(id);
      rows.set(id, row);
      row.name.textContent = name;
      row.name.title = name;
      row.address.textContent = address;
      row.address.title = address;
      row.address.hidden = !address;
      row.workspace.textContent = workspace ?? '';
      row.workspace.title = workspace ?? '';
      row.workspace.hidden = !workspace;
      row.summary.setAttribute('aria-label', `${name}的更多操作`);
      setSelected(row, selectedId === id);
      updateLatency(row, server);
      if (row.container !== position) list.insertBefore(row.container, position);
      position = row.container.nextElementSibling;
    }

    empty.hidden = servers.length > 0;
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type === 'servers' && Array.isArray(message.servers)) {
      render(message.servers);
    } else if (message?.type === 'latency') {
      const row = rows.get(message.id);
      if (row) updateLatency(row, message);
    }
  });

  document.addEventListener('pointerdown', (event) => {
    for (const { actions } of rows.values()) {
      if (actions.open && !actions.contains(event.target)) actions.open = false;
    }
  });
  document.getElementById('configure').addEventListener('click', () => vscode.postMessage({ type: 'configure' }));
  vscode.postMessage({ type: 'ready' });
})();
