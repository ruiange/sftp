(() => {
  const vscode = acquireVsCodeApi();
  const get = (id) => document.getElementById(id);
  const environment = get('environment');
  const name = get('name');
  const endpoint = get('endpoint');
  const protocol = get('protocol');
  const empty = get('empty');
  const emptyText = get('empty-text');
  const configure = get('configure');
  const actions = get('actions');
  const uploadWorkspace = get('upload-workspace');
  const upload = get('upload');
  const target = get('target');
  const feedback = get('feedback');
  const status = get('status');
  const logs = get('logs');

  let current = {};
  let pending = false;

  function isUploading() {
    return current.upload?.state === 'queued' || current.upload?.state === 'running';
  }

  function canUpload(wholeWorkspace) {
    const eligible = wholeWorkspace ? !current.workspaceUploadBlockedReason : current.fileName && !current.uploadBlockedReason;
    return Boolean(current.environment && Number.isInteger(current.targetId) && eligible
      && !current.switching && !pending && !isUploading());
  }

  function renderUpload() {
    environment.setAttribute('aria-disabled', String(Boolean(current.switching)));
    uploadWorkspace.setAttribute('aria-disabled', String(!canUpload(true)));
    upload.setAttribute('aria-disabled', String(!canUpload(false)));
    const result = pending ? { state: 'queued', message: '正在提交上传…' } : current.upload;
    feedback.hidden = !result;
    if (result) {
      feedback.dataset.state = result.state;
      if (status.textContent !== result.message) status.textContent = result.message;
    } else {
      delete feedback.dataset.state;
      status.textContent = '';
    }
    logs.hidden = result?.state !== 'error';
  }

  function renderState() {
    const details = current.environment;
    environment.hidden = !details;
    empty.hidden = Boolean(details);
    configure.hidden = !current.canConfigure;
    actions.hidden = !details;
    if (details) {
      name.textContent = details.name;
      endpoint.textContent = details.endpoint;
      protocol.textContent = details.protocol;
      protocol.hidden = !details.protocol;
      environment.title = details.tooltip || '切换上传环境';
      environment.setAttribute('aria-label', `切换上传环境，当前为 ${details.name}`);
      environment.setAttribute('aria-describedby', 'endpoint protocol');
    } else {
      emptyText.textContent = current.emptyText || '';
    }

    const targetText = current.uploadBlockedReason || current.fileName || '';
    target.textContent = targetText;
    target.title = current.remoteFilePath ? `${targetText} → ${current.remoteFilePath}` : targetText;
    target.hidden = !targetText;
    const workspaceReason = current.workspaceUploadBlockedReason || '';
    uploadWorkspace.title = workspaceReason;
    uploadWorkspace.setAttribute('aria-description', workspaceReason);
    upload.title = current.uploadBlockedReason || '';
    renderUpload();
  }

  function requestUpload(wholeWorkspace) {
    if (!canUpload(wholeWorkspace)) return;
    pending = true;
    renderUpload();
    vscode.postMessage({ type: wholeWorkspace ? 'uploadWorkspace' : 'upload', targetId: current.targetId });
  }

  environment.addEventListener('click', () => {
    if (!current.switching) vscode.postMessage({ type: 'switch' });
  });
  configure.addEventListener('click', () => vscode.postMessage({ type: 'configure' }));
  logs.addEventListener('click', () => vscode.postMessage({ type: 'logs' }));
  uploadWorkspace.addEventListener('click', () => requestUpload(true));
  upload.addEventListener('click', () => requestUpload(false));

  window.addEventListener('message', ({ data }) => {
    if (data?.type === 'state') {
      current = data;
      pending = false;
      renderState();
    } else if (data?.type === 'upload') {
      current.upload = data.upload;
      current.switching = data.switching;
      pending = false;
      renderUpload();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
