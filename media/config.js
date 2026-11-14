(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let model;
  let activeProfile = '';
  let activeTab = 'connection';
  let workspaceName = '';
  let configPath = '';
  let dirty = false;
  let testing = false;
  let revision = 0;

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'state') {
      model = clone(message.config);
      activeProfile = Object.hasOwn(model.profiles, message.activeProfile)
        ? message.activeProfile
        : Object.keys(model.profiles)[0] ?? '';
      revision = message.revision;
      workspaceName = message.workspaceName;
      configPath = message.configPath;
      dirty = false;
      testing = false;
      render();
      return;
    }
    if (message.type === 'deleteConfirmed') {
      removeProfile(message.profileName, true);
      return;
    }
    if (message.type === 'profileDeleted') {
      revision = message.revision;
      removeProfile(message.profileName, false);
      return;
    }
    if (message.type === 'saved') {
      dirty = false;
      setTesting(false);
      updateSaveState();
      showToast('配置已写入当前工作区', 'success');
      return;
    }
    if (message.type === 'testing') {
      setTesting(true);
      showConnectionStatus('正在连接服务器…', 'loading');
      return;
    }
    if (message.type === 'testResult') {
      setTesting(false);
      showConnectionStatus(message.message, message.ok ? 'success' : 'error');
      showToast(message.ok ? '连接测试成功' : '连接测试失败', message.ok ? 'success' : 'error');
      return;
    }
    if (message.type === 'privateKeyPicked') {
      if (message.profileName === activeProfile && model.profiles[activeProfile]) {
        model.profiles[activeProfile].privateKeyPath = message.path;
        const input = document.querySelector('[data-field="privateKeyPath"]');
        if (input) input.value = message.path;
        markDirty();
      }
      return;
    }
    if (message.type === 'localPathPicked') {
      if (message.profileName === activeProfile && model.profiles[activeProfile]) {
        model.profiles[activeProfile].localPath = message.path;
        const input = document.querySelector('[data-field="localPath"]');
        if (input) input.value = message.path;
        updateMappingPreview();
        markDirty();
      }
      return;
    }
    if (message.type === 'operationError') {
      setTesting(false);
      if (!model) {
        renderFatal(message.message);
        return;
      }
      showConnectionStatus(message.message, 'error');
      showToast(message.message, 'error');
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
  });

  function render() {
    const profile = Object.hasOwn(model.profiles, activeProfile) ? model.profiles[activeProfile] : undefined;
    const names = Object.keys(model.profiles);
    app.setAttribute('aria-busy', 'false');
    app.innerHTML = `
      <header class="topbar">
        <div class="brand-lockup">
          <div class="brand-mark" aria-hidden="true">SF</div>
          <div>
            <h1>SFTP / FTP 配置</h1>
            <p>上传与远程目录管理</p>
          </div>
        </div>
        <div class="topbar-actions">
          <button class="button button-ghost" data-action="open-json" title="直接编辑配置文件">原始 JSON</button>
          <button class="button button-primary" data-action="save">保存配置</button>
        </div>
      </header>

      <div class="workspace-strip">
        <span class="workspace-dot" aria-hidden="true"></span>
        <strong>${escapeHtml(workspaceName)}</strong>
        <code title="${escapeHtml(configPath)}">${escapeHtml(configPath)}</code>
        <div id="save-state" class="save-state ${dirty ? 'is-dirty' : ''}">${dirty ? '有未保存修改' : '配置已保存'}</div>
      </div>

      <div class="layout">
        <aside class="sidebar">
          <div class="section-label"><span>连接环境</span><b>${names.length}</b></div>
          <nav class="profile-list" aria-label="上传环境">
            ${names.map((name) => profileItem(name, model.profiles[name])).join('')}
          </nav>
          <button class="add-profile" data-action="add-profile"><span>＋</span> 新增环境</button>
          <p class="sidebar-note">每个环境可以单独配置连接、目录映射和排除路径。</p>
        </aside>

        <main class="content">
          ${profile ? `
          <section class="profile-heading">
            <div>
              <label for="profile-name">当前环境</label>
              <input id="profile-name" class="profile-name-input" value="${escapeHtml(activeProfile)}" spellcheck="false">
            </div>
            <button class="button button-danger-subtle" data-action="delete-profile">删除环境</button>
          </section>

          <nav class="config-tabs" aria-label="配置分类">
            ${tabButton('connection', '连接')}
            ${tabButton('mapping', '映射')}
            ${tabButton('exclude', '排除的路径')}
          </nav>

          <section class="settings-surface">
            ${activeTab === 'connection' ? connectionTab(profile, names) : ''}
            ${activeTab === 'mapping' ? mappingTab(profile) : ''}
            ${activeTab === 'exclude' ? excludeTab(profile) : ''}
          </section>
          ` : '<p>暂无连接环境，可通过左侧「新增环境」添加。</p>'}
        </main>
      </div>
      <div id="toast-region" class="toast-region" aria-live="polite"></div>
    `;
    bindEvents();
  }

  function renderFatal(message) {
    app.setAttribute('aria-busy', 'false');
    app.innerHTML = `<div class="fatal-screen">
      <div class="fatal-mark">!</div>
      <h1>配置文件暂时无法载入</h1>
      <p>${escapeHtml(message)}</p>
      <div>
        <button class="button button-primary" id="fatal-open-json">打开原始 JSON</button>
        <button class="button button-ghost" id="fatal-reload">重新读取</button>
      </div>
    </div>`;
    document.getElementById('fatal-open-json').addEventListener('click', () => vscode.postMessage({ type: 'openJson' }));
    document.getElementById('fatal-reload').addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
  }

  function profileItem(name, profile) {
    const active = name === activeProfile;
    return `<button class="profile-item ${active ? 'active' : ''}" data-profile="${escapeHtml(name)}">
      <span class="profile-copy">
        <strong>${escapeHtml(name)}</strong>
        <small>${escapeHtml(profile.host || '未配置服务器')}</small>
      </span>
      <span class="protocol-chip ${profile.protocol}">${profile.protocol.toUpperCase()}</span>
    </button>`;
  }

  function tabButton(name, label) {
    const selected = activeTab === name;
    return `<button class="${selected ? 'active' : ''}" data-tab="${name}" role="tab" aria-selected="${selected}">${label}</button>`;
  }

  function connectionTab(profile, names) {
    const authType = profile.protocol === 'ftp'
      ? 'password'
      : profile.authType || (profile.privateKeyPath ? 'privateKey' : 'password');
    const secure = profile.secure === 'implicit' ? 'implicit' : String(profile.secure === true);
    profile.authType = authType;

    return `<div class="tab-form">
      <div id="connection-status" class="connection-status" hidden></div>

      <div class="settings-row">
        <label for="protocol">类型(T)：</label>
        <div class="control-narrow">
          <select id="protocol" data-protocol-select>
            <option value="sftp" ${profile.protocol === 'sftp' ? 'selected' : ''}>SFTP</option>
            <option value="ftp" ${profile.protocol === 'ftp' ? 'selected' : ''}>FTP / FTPS</option>
          </select>
        </div>
      </div>

      <div class="settings-row">
        <label for="host">服务器(H)：</label>
        <div class="server-fields">
          <input id="host" data-field="host" value="${escapeHtml(profile.host || '')}" placeholder="服务器地址或 IP" spellcheck="false">
          <input class="port-input" data-field="port" type="number" min="1" value="${escapeHtml(String(profile.port ?? defaultPort(profile)))}" placeholder="端口">
        </div>
      </div>

      <div class="settings-row">
        <label for="username">用户名(U)：</label>
        <input id="username" data-field="username" value="${escapeHtml(profile.username || '')}" placeholder="登录用户名" spellcheck="false">
      </div>

      <div class="settings-row">
        <span class="row-label">登录方式(A)：</span>
        ${profile.protocol === 'sftp'
          ? `<div class="auth-method-switch" role="group" aria-label="登录方式">
              <button class="${authType === 'password' ? 'active' : ''}" data-auth="password">密码登录</button>
              <button class="${authType === 'privateKey' ? 'active' : ''}" data-auth="privateKey">密钥登录</button>
            </div>`
          : '<div class="fixed-auth-badge">FTP 使用密码登录</div>'}
      </div>

      ${authType === 'password' ? passwordRow(profile.password || '') : privateKeyRows(profile)}

      <div class="settings-row">
        <span class="row-label"></span>
        <button id="test-button" class="settings-button test-button" data-action="test" ${testing ? 'disabled' : ''}>
          <span class="test-dot"></span>${testing ? '连接中…' : '测试连接(C)'}
        </button>
      </div>

      <div class="settings-divider"></div>

      <div class="settings-row">
        <span class="row-label">保存时上传(S)：</span>
        ${switchControl('uploadOnSave', profile.uploadOnSave === true, '保存当前项目文件后自动上传')}
      </div>

      <div class="settings-row">
        <label for="default-profile">默认环境(D)：</label>
        <div class="control-narrow">
          <select id="default-profile" data-global-field="defaultProfile">
            ${names.map((name) => `<option value="${escapeHtml(name)}" ${model.defaultProfile === name ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}
          </select>
        </div>
      </div>

      <details class="compact-advanced">
        <summary>高级连接设置</summary>
        <div class="advanced-rows">
          <div class="settings-row">
            <label for="connect-timeout">连接超时：</label>
            <div class="number-with-unit">
              <input id="connect-timeout" data-field="connectTimeout" type="number" min="1000" value="${escapeHtml(String(profile.connectTimeout ?? 15000))}">
              <span>毫秒</span>
            </div>
          </div>
          ${profile.protocol === 'ftp' ? `
            <div class="settings-row">
              <label for="secure-mode">FTP 安全模式：</label>
              <div class="control-narrow">
                <select id="secure-mode" data-field="secure">
                  <option value="false" ${secure === 'false' ? 'selected' : ''}>普通 FTP</option>
                  <option value="true" ${secure === 'true' ? 'selected' : ''}>显式 FTPS</option>
                  <option value="implicit" ${secure === 'implicit' ? 'selected' : ''}>隐式 FTPS</option>
                </select>
              </div>
            </div>
            <div class="settings-row">
              <span class="row-label">TLS 证书校验：</span>
              ${switchControl('rejectUnauthorized', profile.rejectUnauthorized !== false, '生产环境建议开启')}
            </div>` : ''}
        </div>
      </details>
    </div>`;
  }

  function passwordRow(value) {
    return `<div class="settings-row">
      <label for="password">密码(P)：</label>
      <div class="input-action-wrap">
        <input id="password" data-field="password" type="password" value="${escapeHtml(value)}" placeholder="输入密码或 \${env:VARIABLE}" spellcheck="false">
        <button type="button" data-action="toggle-password" aria-label="显示或隐藏密码">显示</button>
      </div>
    </div>`;
  }

  function privateKeyRows(profile) {
    return `<div class="settings-row">
      <label for="private-key">私钥(K)：</label>
      <div class="input-action-wrap">
        <input id="private-key" data-field="privateKeyPath" value="${escapeHtml(profile.privateKeyPath || '')}" placeholder="~/.ssh/id_rsa" spellcheck="false">
        <button type="button" data-action="pick-key">选择</button>
      </div>
    </div>
    <div class="settings-row">
      <label for="passphrase">私钥口令：</label>
      <input id="passphrase" data-field="passphrase" type="password" value="${escapeHtml(profile.passphrase || '')}" placeholder="可选，也可以填写 \${env:SFTP_KEY_PASSPHRASE}" spellcheck="false">
    </div>`;
  }

  function mappingTab(profile) {
    return `<div class="tab-form">
      <div class="settings-row">
        <label for="local-path">本地路径(L)：</label>
        <div class="input-action-wrap">
          <input id="local-path" data-field="localPath" value="${escapeHtml(profile.localPath || '.')}" placeholder="例如 dist；项目根目录填写 ." spellcheck="false">
          <button type="button" data-action="pick-local">选择</button>
        </div>
      </div>

      <div class="settings-row">
        <label for="remote-path">部署路径(E)：</label>
        <input id="remote-path" data-field="remotePath" value="${escapeHtml(profile.remotePath || '')}" placeholder="/var/www/site" spellcheck="false">
      </div>

      <div class="settings-row mapping-summary-row">
        <span class="row-label"></span>
        <div class="mapping-summary">
          <span>上传映射</span>
          <strong id="mapping-preview">${mappingPreview(profile)}</strong>
          <small>本地路径相对于当前项目；部署路径是服务器上的目标目录。</small>
        </div>
      </div>
    </div>`;
  }

  function excludeTab(profile) {
    return `<div class="tab-form">
      <div class="settings-row settings-row-top">
        <label for="profile-ignore">当前环境：</label>
        <div>
          <textarea id="profile-ignore" data-field="ignore" rows="8" placeholder="dist/**/*.map&#10;temp/**" spellcheck="false">${escapeHtml((profile.ignore || []).join('\n'))}</textarea>
          <p class="field-help">仅应用于“${escapeHtml(activeProfile)}”环境，每行填写一条 glob 规则。</p>
        </div>
      </div>

      <div class="settings-row settings-row-top">
        <label for="global-ignore">所有环境：</label>
        <div>
          <textarea id="global-ignore" data-global-field="ignore" rows="8" placeholder="**/.git/**&#10;**/node_modules/**" spellcheck="false">${escapeHtml((model.ignore || []).join('\n'))}</textarea>
          <p class="field-help">应用于当前项目的全部上传环境；以 ! 开头可以重新包含路径。</p>
        </div>
      </div>

      <div class="settings-row">
        <span class="row-label">全局自动上传：</span>
        ${globalSwitchControl('uploadOnSave', model.uploadOnSave === true, '环境未单独开启时使用此设置')}
      </div>
    </div>`;
  }

  function switchControl(name, checked, hint) {
    return `<label class="switch-control">
      <input data-field="${name}" type="checkbox" ${checked ? 'checked' : ''}>
      <i aria-hidden="true"></i>
      <span>${hint}</span>
    </label>`;
  }

  function globalSwitchControl(name, checked, hint) {
    return `<label class="switch-control">
      <input data-global-field="${name}" type="checkbox" ${checked ? 'checked' : ''}>
      <i aria-hidden="true"></i>
      <span>${hint}</span>
    </label>`;
  }

  function bindEvents() {
    document.querySelectorAll('[data-profile]').forEach((button) => {
      button.addEventListener('click', () => {
        activeProfile = button.dataset.profile;
        render();
      });
    });
    document.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        activeTab = button.dataset.tab;
        render();
      });
    });
    const protocolSelect = document.querySelector('[data-protocol-select]');
    if (protocolSelect) {
      protocolSelect.addEventListener('change', () => {
        const profile = model.profiles[activeProfile];
        const next = protocolSelect.value;
        if (profile.protocol === next) return;
        profile.protocol = next;
        if (next === 'ftp') profile.authType = 'password';
        if (!profile.port || profile.port === 21 || profile.port === 22 || profile.port === 990) {
          profile.port = next === 'sftp' ? 22 : 21;
        }
        markDirty();
        render();
      });
    }
    document.querySelectorAll('[data-auth]').forEach((button) => {
      button.addEventListener('click', () => {
        const profile = model.profiles[activeProfile];
        const next = button.dataset.auth;
        if (profile.authType === next) return;
        profile.authType = next;
        markDirty();
        render();
      });
    });
    document.querySelectorAll('[data-field]').forEach((input) => {
      input.addEventListener('input', () => updateProfileField(input));
      input.addEventListener('change', () => updateProfileField(input));
    });
    document.querySelectorAll('[data-global-field]').forEach((input) => {
      input.addEventListener('input', () => updateGlobalField(input));
      input.addEventListener('change', () => updateGlobalField(input));
    });
    document.getElementById('profile-name')?.addEventListener('change', renameActiveProfile);
    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => runAction(button.dataset.action, button));
    });
  }

  function updateProfileField(input) {
    const profile = model.profiles[activeProfile];
    const key = input.dataset.field;
    let value = input.type === 'checkbox' ? input.checked : input.value;
    if (key === 'port' || key === 'connectTimeout') value = value === '' ? undefined : Number(value);
    if (key === 'ignore') value = lines(value);
    if (key === 'secure') value = value === 'implicit' ? 'implicit' : value === 'true';
    if (value === '' && optionalFields.has(key)) delete profile[key];
    else profile[key] = value;
    if (key === 'localPath' || key === 'remotePath') updateMappingPreview();
    markDirty();
  }

  function updateGlobalField(input) {
    const key = input.dataset.globalField;
    let value = input.type === 'checkbox' ? input.checked : input.value;
    if (key === 'ignore') value = lines(value);
    model[key] = value;
    markDirty();
  }

  function renameActiveProfile(event) {
    const next = event.target.value.trim();
    if (!next || next === activeProfile) {
      event.target.value = activeProfile;
      return;
    }
    if (model.profiles[next]) {
      showToast(`环境“${next}”已经存在`, 'error');
      event.target.value = activeProfile;
      return;
    }
    model.profiles[next] = model.profiles[activeProfile];
    delete model.profiles[activeProfile];
    if (model.defaultProfile === activeProfile) model.defaultProfile = next;
    activeProfile = next;
    markDirty();
    render();
  }

  function runAction(action, button) {
    if (action === 'save') save();
    if (action === 'test') test();
    if (action === 'open-json') vscode.postMessage({ type: 'openJson' });
    if (action === 'pick-key') vscode.postMessage({ type: 'pickPrivateKey', profileName: activeProfile });
    if (action === 'pick-local') vscode.postMessage({ type: 'pickLocalPath', profileName: activeProfile });
    if (action === 'add-profile') addProfile();
    if (action === 'delete-profile') vscode.postMessage({ type: 'confirmDelete', profileName: activeProfile });
    if (action === 'toggle-password') {
      const input = button.parentElement.querySelector('input');
      input.type = input.type === 'password' ? 'text' : 'password';
      button.textContent = input.type === 'password' ? '显示' : '隐藏';
    }
  }

  function addProfile() {
    let index = 1;
    let name = 'new-profile';
    while (model.profiles[name]) name = `new-profile-${++index}`;
    model.profiles[name] = {
      protocol: 'sftp',
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      password: '',
      localPath: '.',
      remotePath: '/',
      uploadOnSave: false,
    };
    activeProfile = name;
    activeTab = 'connection';
    markDirty();
    render();
    requestAnimationFrame(() => document.getElementById('profile-name').select());
  }

  function removeProfile(name, markUnsaved) {
    if (!model || !Object.hasOwn(model.profiles, name)) return;
    const names = Object.keys(model.profiles);
    const currentIndex = names.indexOf(name);
    delete model.profiles[name];
    const remaining = Object.keys(model.profiles);
    if (name === activeProfile) {
      activeProfile = remaining[Math.min(currentIndex, remaining.length - 1)] ?? '';
    }
    if (model.defaultProfile === name) {
      if (remaining.length > 0) model.defaultProfile = remaining[0];
      else delete model.defaultProfile;
    }
    if (markUnsaved) markDirty();
    render();
  }

  function save() {
    const error = validate();
    if (error) {
      showToast(error, 'error');
      return;
    }
    vscode.postMessage({ type: 'save', config: model, profileName: activeProfile, revision });
  }

  function test() {
    const error = validate(activeProfile);
    if (error) {
      showToast(error, 'error');
      return;
    }
    vscode.postMessage({ type: 'test', config: model, profileName: activeProfile });
  }

  function validate(onlyProfile) {
    const names = onlyProfile ? [onlyProfile] : Object.keys(model.profiles);
    for (const name of names) {
      const profile = model.profiles[name];
      if (!profile.host.trim()) return `环境“${name}”需要填写服务器地址`;
      if (!profile.username.trim()) return `环境“${name}”需要填写用户名`;
      if (!profile.remotePath.trim()) return `环境“${name}”需要填写部署路径`;
      const port = profile.port ?? defaultPort(profile);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return `环境“${name}”的端口无效`;
      const authType = profile.protocol === 'ftp'
        ? 'password'
        : profile.authType || (profile.privateKeyPath ? 'privateKey' : 'password');
      if (onlyProfile && authType === 'password' && !String(profile.password || '').trim()) return `环境“${name}”需要填写登录密码`;
      if (onlyProfile && authType === 'privateKey' && !String(profile.privateKeyPath || '').trim()) return `环境“${name}”需要选择私钥文件`;
      if (profile.connectTimeout !== undefined && profile.connectTimeout < 1000) return `环境“${name}”的连接超时不能小于 1000 毫秒`;
    }
    return '';
  }

  function markDirty() {
    dirty = true;
    updateSaveState();
  }

  function updateSaveState() {
    const state = document.getElementById('save-state');
    if (!state) return;
    state.classList.toggle('is-dirty', dirty);
    state.textContent = dirty ? '有未保存修改' : '配置已保存';
  }

  function setTesting(value) {
    testing = value;
    const button = document.getElementById('test-button');
    if (button) {
      button.disabled = value;
      button.innerHTML = `<span class="test-dot"></span>${value ? '连接中…' : '测试连接(C)'}`;
    }
  }

  function showConnectionStatus(message, type) {
    const status = document.getElementById('connection-status');
    if (!status) return;
    status.hidden = false;
    status.className = `connection-status ${type}`;
    status.innerHTML = `<span></span><strong>${escapeHtml(message)}</strong><button aria-label="关闭">×</button>`;
    status.querySelector('button').addEventListener('click', () => { status.hidden = true; });
  }

  function updateMappingPreview() {
    const preview = document.getElementById('mapping-preview');
    if (preview) preview.textContent = mappingPreview(model.profiles[activeProfile]);
  }

  function mappingPreview(profile) {
    const local = String(profile.localPath || '.').trim() || '.';
    const remote = String(profile.remotePath || '/').trim() || '/';
    return `${local}  →  ${remote}`;
  }

  function showToast(message, type) {
    const region = document.getElementById('toast-region');
    if (!region) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span></span><p>${escapeHtml(message)}</p>`;
    region.appendChild(toast);
    setTimeout(() => toast.classList.add('leaving'), 2800);
    setTimeout(() => toast.remove(), 3200);
  }

  function defaultPort(profile) {
    return profile.protocol === 'sftp' ? 22 : profile.secure === 'implicit' ? 990 : 21;
  }

  function lines(value) {
    return String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  const optionalFields = new Set(['password', 'privateKeyPath', 'passphrase']);
  vscode.postMessage({ type: 'ready' });
}());
