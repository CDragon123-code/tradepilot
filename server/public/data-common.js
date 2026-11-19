'use strict';

// 云端数据中台：登录态、API 与通用格式化
(() => {
  const TOKEN_KEY = 'aliCloudToken';
  const $ = (id) => document.getElementById(id);
  let onReady = null;

  async function api(path, options = {}) {
    const token = sessionStorage.getItem(TOKEN_KEY) || sessionStorage.getItem('aliAdminToken') || '';
    const headers = token ? { authorization: 'Bearer ' + token } : {};
    if (options.body) headers['content-type'] = 'application/json';
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    const isJson = type.indexOf('application/json') >= 0;
    const data = isJson ? await res.json().catch(() => ({})) : {};
    if (res.status === 401) {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem('aliAdminToken');
      const err = new Error('登录已失效，请重新登录');
      err.status = 401;
      throw err;
    }
    if (!res.ok) throw new Error(data.message || data.error || ('HTTP ' + res.status));
    // 防止把页面路由当接口调用时静默返回空对象，导致页面出现 undefined
    if (!isJson) throw new Error('接口返回非 JSON：' + path);
    return data;
  }

  function fmtTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('zh-CN', { hour12: false });
  }
  function fmtRows(n) {
    return Number(n || 0).toLocaleString('zh-CN');
  }
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function showGate(message) {
    $('gate').classList.remove('hidden');
    $('view').classList.add('hidden');
    $('head-actions').classList.add('hidden');
    $('gate-msg').textContent = message || '';
  }
  function showView() {
    $('gate').classList.add('hidden');
    $('view').classList.remove('hidden');
    $('head-actions').classList.remove('hidden');
  }
  async function run() {
    if (!onReady) return;
    const token = sessionStorage.getItem(TOKEN_KEY) || sessionStorage.getItem('aliAdminToken');
    if (!token) { showGate(''); return; }
    try {
      await onReady();
      showView();
    } catch (e) {
      if (e.status === 401) showGate(e.message);
      else showGate('读取失败：' + e.message);
    }
  }
  function bind() {
    $('login').onclick = async () => {
      const email = $('email').value.trim();
      const password = $('password').value;
      if (!email || !password) { $('gate-msg').textContent = '请填写邮箱和密码'; return; }
      try {
        const res = await fetch('/auth/login', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || '登录失败');
        sessionStorage.setItem(TOKEN_KEY, data.token);
        $('password').value = '';
        await run();
      } catch (e) { $('gate-msg').textContent = e.message; }
    };
    $('connect').onclick = () => {
      const token = $('token').value.trim();
      if (!token) { $('gate-msg').textContent = '请填写令牌'; return; }
      sessionStorage.setItem(TOKEN_KEY, token);
      $('gate-msg').textContent = '';
      run();
    };
    $('refresh').onclick = () => run();
    $('switch-account').onclick = () => {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem('aliAdminToken');
      showGate('');
    };
    $('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login').click(); });
    $('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('connect').click(); });
  }

  function mount(handler) {
    onReady = handler;
    bind();
    run();
    setInterval(() => {
      if (!document.hidden) run();
    }, 60000);
  }

  window.CloudData = { api, fmtTime, fmtRows, el, mount, showGate, TOKEN_KEY, $ };
})();
