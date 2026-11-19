'use strict';

// API 与权限：员工角色、API 令牌、调用流水与操作审计
(() => {
  const { api, fmtTime, fmtRows, el, mount } = window.CloudData;
  const $ = (id) => document.getElementById(id);
  const ROLE_LABEL = { admin: '管理员', operator: '运营', viewer: '只读' };
  const KIND_LABEL = { extension: '扩展插件', collector: '采集器', external: '外部工具' };
  const TABS = [
    ['overview', '概览'],
    ['employees', '员工与角色'],
    ['tokens', 'API 令牌'],
    ['gate', '发送门禁'],
    ['calls', '调用审计'],
    ['audit', '操作审计'],
  ];
  const state = {
    me: null, admin: false, tab: 'overview',
    overview: null, employees: [], clients: [], calls: [], audits: [],
    control: null, dnc: [], alibabaAccounts: [], editingAlibabaId: '',
  };

  function say(id, text, ok) {
    const node = $(id);
    node.textContent = text || '';
    node.className = 'status-line' + (ok === true ? ' ok' : ok === false ? ' err' : '');
  }

  function pill(text, cls) {
    return el('span', 'pill ' + (cls || 'empty'), text);
  }

  function scopePills(scopes) {
    const box = el('span', 'tag-cell');
    (scopes || []).forEach((scope) => box.appendChild(pill(scope, 'ok')));
    if (!box.childNodes.length) box.appendChild(el('span', 'muted', '—'));
    return box;
  }

  function short(value, size) {
    const text = value === undefined || value === null ? '' : String(value);
    return text.length > size ? text.slice(0, size) + '…' : text;
  }

  function safeGet(path) {
    return api(path).catch(() => ({ items: [] }));
  }

  function renderBriefing() {
    const overview = state.overview || {};
    const clients = overview.clients || {};
    const calls = overview.calls || {};
    const audit = overview.audit || {};
    $('briefing-text').textContent = '员工 ' + state.employees.length + ' 人，API 令牌 '
      + (clients.total || 0) + ' 个（启用 ' + (clients.active || 0) + '），近 24 小时调用 '
      + fmtRows(calls.total) + ' 次、服务端错误 ' + fmtRows(calls.server_errors)
      + ' 次、权限拦截 ' + fmtRows(calls.denied) + ' 次，近 7 天审计 '
      + fmtRows(audit.total) + ' 条。';
    const badge = $('gateway-badge');
    const serverErrors = calls.server_errors || 0;
    const denied = calls.denied || 0;
    const warn = serverErrors > 0;
    badge.className = 'quality-badge' + (warn ? ' warn' : '');
    badge.textContent = warn ? serverErrors + ' 次服务端错误待排查'
      : denied ? '网关运行正常 · ' + denied + ' 次权限拦截' : '网关运行正常';
  }

  function renderKpis() {
    const box = $('kpis');
    box.textContent = '';
    const overview = state.overview || {};
    const clients = overview.clients || {};
    const calls = overview.calls || {};
    const audit = overview.audit || {};
    const items = [
      ['员工账号', fmtRows(state.employees.length), '启用与停用合计'],
      ['API 令牌', fmtRows(clients.active) + ' / ' + fmtRows(clients.total), '启用 / 总数'],
      ['24h 调用', fmtRows(calls.total), '数据接口调用次数'],
      ['24h 错误', fmtRows(calls.server_errors), '服务端错误；权限拦截 ' + fmtRows(calls.denied) + ' 次'],
      ['审计事件', fmtRows(audit.total), '近 7 天关键操作'],
    ];
    items.forEach(([label, value, hint]) => {
      const card = el('div', 'kpi');
      card.appendChild(el('div', 'k', label));
      card.appendChild(el('div', 'v', String(value)));
      card.appendChild(el('div', 'h', hint));
      box.appendChild(card);
    });
  }

  function renderTabs() {
    const box = $('tabs');
    box.textContent = '';
    TABS.forEach(([key, label]) => {
      const button = el('button', 'tab' + (state.tab === key ? ' active' : ''), label);
      button.type = 'button';
      button.onclick = () => {
        state.tab = key;
        renderTabs();
        TABS.forEach(([name]) => $('panel-' + name).classList.toggle('hidden', name !== key));
      };
      box.appendChild(button);
    });
    TABS.forEach(([name]) => $('panel-' + name).classList.toggle('hidden', name !== state.tab));
  }

  function renderRoleMatrix() {
    const body = $('role-matrix').querySelector('tbody');
    body.textContent = '';
    [
      ['查看数据（总览 / 资产 / 质量 / 主数据）', true, true, true],
      ['采集与导入', true, true, false],
      ['处理待办', true, true, false],
      ['主数据合并 / 取消合并', true, false, false],
      ['发送门禁与 DNC', true, false, false],
      ['员工与 API 令牌管理', true, false, false],
      ['查看调用流水与操作审计', true, false, false],
    ].forEach(([name, admin, operator, viewer]) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, name));
      [admin, operator, viewer].forEach((ok) => {
        const td = el('td');
        td.appendChild(pill(ok ? '✓' : '—', ok ? 'ok' : 'empty'));
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  function renderTopPaths() {
    const body = $('top-paths').querySelector('tbody');
    body.textContent = '';
    const paths = (state.overview && state.overview.calls && state.overview.calls.top_paths) || [];
    if (!paths.length) {
      const tr = el('tr');
      const td = el('td', 'muted', '近 24 小时还没有接口调用。');
      td.colSpan = 3;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    paths.forEach((row) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'mono', row.path));
      tr.appendChild(el('td', null, fmtRows(row.count)));
      tr.appendChild(el('td', row.errors ? 'error-text' : null, fmtRows(row.errors)));
      body.appendChild(tr);
    });
  }

  function renderGatewayMeta() {
    const box = $('gateway-meta');
    box.textContent = '';
    const overview = state.overview || {};
    const clients = overview.clients || {};
    const calls = overview.calls || {};
    const legacy = overview.legacy || {};
    const byKind = clients.by_kind || {};
    const rows = [
      ['启用令牌', (clients.active || 0) + ' / ' + (clients.total || 0)],
      ['令牌类型', Object.keys(byKind).map((kind) => (KIND_LABEL[kind] || kind) + ' ' + byKind[kind]).join(' · ') || '—'],
      ['24h 平均耗时', fmtRows(calls.avg_ms) + ' ms'],
      ['采集令牌', legacy.ingest_configured ? '已配置' : '未配置'],
      ['只读令牌', legacy.read_configured ? '已配置' : '未配置'],
      ['读写共享', legacy.shared ? '是（建议拆分）' : '否'],
    ];
    rows.forEach(([label, value]) => {
      const item = el('div', 'meta-item');
      item.appendChild(el('span', 'meta-k', label));
      item.appendChild(el('span', 'meta-v', String(value)));
      box.appendChild(item);
    });
  }

  function renderGate() {
    const control = state.control || {};
    const box = $('gate-state');
    box.textContent = '';
    const rows = [
      ['发送状态', control.send_paused ? '已暂停' : '正常'],
      ['暂停原因', control.pause_reason || '—'],
      ['操作人', control.updated_by || '—'],
      ['更新时间', fmtTime(control.updated_at)],
    ];
    rows.forEach(([label, value]) => {
      const item = el('div', 'meta-item');
      item.appendChild(el('span', 'meta-k', label));
      item.appendChild(el('span', 'meta-v', String(value)));
      box.appendChild(item);
    });
    const button = $('gate-toggle');
    button.textContent = control.send_paused ? '恢复发送' : '暂停发送';
    button.className = control.send_paused ? 'secondary' : '';
  }

  function renderDnc() {
    const body = $('dnc-rows').querySelector('tbody');
    body.textContent = '';
    if (!state.dnc.length) {
      const tr = el('tr');
      const td = el('td', 'muted', '名单为空。');
      td.colSpan = 5;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    state.dnc.forEach((row) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'mono', row.customer_key));
      tr.appendChild(el('td', null, row.reason || '—'));
      tr.appendChild(el('td', 'muted', row.until ? fmtTime(row.until) : '永久'));
      const status = el('td');
      status.appendChild(pill(row.active ? '生效中' : '已过期', row.active ? 'ok' : 'empty'));
      tr.appendChild(status);
      const actions = el('td');
      const button = el('button', 'mini danger js-dnc-del', '移除');
      button.type = 'button';
      button.dataset.key = row.customer_key;
      actions.appendChild(button);
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }

  function renderEmployees() {
    const body = $('employees').querySelector('tbody');
    body.textContent = '';
    if (!state.employees.length) {
      const tr = el('tr');
      const td = el('td', 'muted', '还没有员工账号。');
      td.colSpan = 9;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    state.employees.forEach((emp) => {
      const tr = el('tr');
      tr.dataset.id = emp.id;
      tr.dataset.email = emp.email;
      tr.dataset.name = emp.name || '';
      tr.dataset.role = emp.role;
      tr.dataset.seller = emp.seller_id || '';
      tr.dataset.status = emp.status;
      tr.dataset.created = emp.created_at || '';
      tr.dataset.alibaba = emp.alibaba_account_id || '';
      tr.dataset.owner = emp.owner_name || '';
      tr.appendChild(el('td', null, emp.email));
      tr.appendChild(el('td', null, emp.name || '—'));
      const ali = el('td');
      if (emp.alibaba_login) {
        ali.appendChild(el('div', null, emp.alibaba_login));
        ali.appendChild(el('div', 'muted', emp.alibaba_type === 'main' ? '主账号' : '子账号'));
      } else {
        ali.appendChild(el('span', 'muted', '未绑定'));
      }
      tr.appendChild(ali);
      tr.appendChild(el('td', null, emp.owner_name || '—'));
      tr.appendChild(el('td', null, ROLE_LABEL[emp.role] || emp.role));
      tr.appendChild(el('td', null, emp.seller_id || '—'));
      const status = el('td');
      status.appendChild(pill(emp.status === 'active' ? '启用' : '停用', emp.status === 'active' ? 'ok' : 'empty'));
      tr.appendChild(status);
      tr.appendChild(el('td', 'muted', fmtTime(emp.created_at)));
      const actions = el('td');
      const box = el('div', 'table-actions');
      [['js-edit', '编辑'], ['js-pwd', '重置密码'],
        ['js-toggle', emp.status === 'active' ? '停用' : '启用'], ['js-del', '删除']].forEach(([cls, label]) => {
        const button = el('button', 'mini ' + cls, label);
        button.type = 'button';
        if (cls === 'js-edit' || cls === 'js-pwd') button.className = 'mini secondary ' + cls;
        if (cls === 'js-del') button.className = 'mini danger ' + cls;
        box.appendChild(button);
      });
      actions.appendChild(box);
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }

  function startEdit(tr) {
    const roleOptions = ['admin', 'operator', 'viewer'].map((role) =>
      '<option value="' + role + '"' + (tr.dataset.role === role ? ' selected' : '') + '>'
      + (ROLE_LABEL[role] || role) + '</option>').join('');
    const statusOptions = ['active', 'disabled'].map((status) =>
      '<option value="' + status + '"' + (tr.dataset.status === status ? ' selected' : '') + '>'
      + (status === 'active' ? '启用' : '停用') + '</option>').join('');
    const alibabaOptions = ['<option value="">未绑定</option>'].concat(
      (state.alibabaAccounts || []).map((account) =>
        '<option value="' + escapeAttr(account.id) + '"'
        + (tr.dataset.alibaba === account.id ? ' selected' : '') + '>'
        + escapeAttr(account.login_name) + '（' + (account.account_type === 'main' ? '主' : '子') + '）</option>'),
    ).join('');
    tr.classList.add('editing');
    tr.innerHTML = '<td><input class="edit-email" value="' + escapeAttr(tr.dataset.email) + '"></td>'
      + '<td><input class="edit-name" value="' + escapeAttr(tr.dataset.name) + '"></td>'
      + '<td><select class="edit-alibaba">' + alibabaOptions + '</select></td>'
      + '<td class="muted">' + escapeAttr(tr.dataset.owner || '—') + '</td>'
      + '<td><select class="edit-role">' + roleOptions + '</select></td>'
      + '<td><input class="edit-seller" value="' + escapeAttr(tr.dataset.seller) + '"></td>'
      + '<td><select class="edit-status">' + statusOptions + '</select></td>'
      + '<td class="muted">' + fmtTime(tr.dataset.created) + '</td>'
      + '<td><div class="table-actions"><button type="button" class="mini js-save">保存</button>'
      + '<button type="button" class="mini secondary js-cancel">取消</button></div></td>';
    tr.querySelector('.edit-alibaba').onchange = () => {
      const account = (state.alibabaAccounts || []).find((item) =>
        item.id === tr.querySelector('.edit-alibaba').value);
      if (account) tr.querySelector('.edit-seller').value = account.seller_id || '';
    };
    tr.querySelector('.js-cancel').onclick = () => renderEmployees();
    tr.querySelector('.js-save').onclick = () => saveEdit(tr);
  }

  function escapeAttr(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  async function saveEdit(tr) {
    const id = tr.dataset.id;
    const body = {
      email: tr.querySelector('.edit-email').value.trim(),
      name: tr.querySelector('.edit-name').value.trim(),
      role: tr.querySelector('.edit-role').value,
      seller_id: tr.querySelector('.edit-seller').value.trim(),
      status: tr.querySelector('.edit-status').value,
      alibaba_account_id: tr.querySelector('.edit-alibaba').value,
    };
    if (!body.email) { say('employee-status', '邮箱不能为空', false); return; }
    if (!body.seller_id) { say('employee-status', '店铺 ID 不能为空', false); return; }
    if (state.me && id === state.me.employee.id
      && (body.role !== tr.dataset.role || body.status !== tr.dataset.status
        || body.seller_id !== tr.dataset.seller || body.alibaba_account_id !== tr.dataset.alibaba)) {
      if (!window.confirm('修改自己的角色/状态/店铺/阿里账号后，当前登录会失效，需要重新登录。继续？')) return;
    }
    try {
      await api('/api/employees/' + id, { method: 'PATCH', body: body });
      say('employee-status', '已保存 ' + body.email, true);
      await refreshEmployees();
    } catch (error) {
      say('employee-status', '保存失败：' + error.message, false);
    }
  }

  function renderAlibabaOptions() {
    const select = $('new-alibaba');
    const current = select.value;
    select.textContent = '';
    const blank = el('option', null, '暂不绑定');
    blank.value = '';
    select.appendChild(blank);
    (state.alibabaAccounts || []).forEach((account) => {
      const option = el('option', null, account.login_name + '（'
        + (account.account_type === 'main' ? '主' : '子') + '）');
      option.value = account.id;
      select.appendChild(option);
    });
    if (current && (state.alibabaAccounts || []).some((account) => account.id === current)) {
      select.value = current;
    }
  }

  function renderAlibabaAccounts() {
    const body = $('ali-accounts').querySelector('tbody');
    body.textContent = '';
    if (!state.alibabaAccounts.length) {
      const tr = el('tr');
      const td = el('td', 'muted', '还没有阿里账号，先新增主账号或子账号。');
      td.colSpan = 7;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    state.alibabaAccounts.forEach((account) => {
      const tr = el('tr');
      tr.dataset.id = account.id;
      tr.dataset.login = account.login_name;
      tr.appendChild(el('td', 'mono', account.login_name));
      const type = el('td');
      type.appendChild(pill(account.account_type === 'main' ? '主账号' : '子账号',
        account.account_type === 'main' ? 'ok' : 'empty'));
      tr.appendChild(type);
      tr.appendChild(el('td', null, account.seller_id || '—'));
      tr.appendChild(el('td', null, account.owner_name || '—'));
      tr.appendChild(el('td', null, account.display_name || '—'));
      const status = el('td');
      status.appendChild(pill(account.status === 'active' ? '启用' : '停用',
        account.status === 'active' ? 'ok' : 'empty'));
      tr.appendChild(status);
      const actions = el('td');
      const box = el('div', 'table-actions');
      const edit = el('button', 'mini secondary js-edit', '编辑');
      edit.type = 'button';
      const del = el('button', 'mini danger js-del', '删除');
      del.type = 'button';
      box.appendChild(edit);
      box.appendChild(del);
      actions.appendChild(box);
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }

  function resetAlibabaForm() {
    state.editingAlibabaId = '';
    $('ali-login').value = '';
    $('ali-type').value = 'main';
    $('ali-seller').value = (state.me && state.me.seller_id) || 'seller-main';
    $('ali-owner').value = '';
    $('ali-display').value = '';
    $('ali-note').value = '';
    $('ali-save').textContent = '新增阿里账号';
    $('ali-cancel').classList.add('hidden');
    say('ali-status', '');
  }

  function fillAlibabaForm(account) {
    state.editingAlibabaId = account.id;
    $('ali-login').value = account.login_name || '';
    $('ali-type').value = account.account_type || 'sub';
    $('ali-seller').value = account.seller_id || '';
    $('ali-owner').value = account.owner_name || '';
    $('ali-display').value = account.display_name || '';
    $('ali-note').value = account.note || '';
    $('ali-save').textContent = '保存修改';
    $('ali-cancel').classList.remove('hidden');
    say('ali-status', '正在编辑「' + account.login_name + '」');
  }

  async function saveAlibabaAccount() {
    const body = {
      login_name: $('ali-login').value.trim(),
      account_type: $('ali-type').value,
      seller_id: $('ali-seller').value.trim() || 'seller-main',
      owner_name: $('ali-owner').value.trim(),
      display_name: $('ali-display').value.trim(),
      note: $('ali-note').value.trim(),
    };
    if (!body.login_name) { say('ali-status', '请填写阿里登录名', false); return; }
    say('ali-status', '正在保存…');
    try {
      if (state.editingAlibabaId) {
        await api('/api/alibaba-accounts/' + state.editingAlibabaId, {
          method: 'PATCH', body: body,
        });
        say('ali-status', '已保存「' + body.login_name + '」', true);
      } else {
        await api('/api/alibaba-accounts', { method: 'POST', body: body });
        say('ali-status', '已新增「' + body.login_name + '」', true);
      }
      resetAlibabaForm();
      await refreshAlibabaAccounts();
      await refreshEmployees();
    } catch (error) {
      say('ali-status', '保存失败：' + error.message, false);
    }
  }

  async function deleteAlibabaAccount(id, login) {
    if (!window.confirm('删除阿里账号「' + login + '」？已绑定的员工会自动解绑。')) return;
    try {
      await api('/api/alibaba-accounts/' + id, { method: 'DELETE' });
      say('ali-status', '已删除「' + login + '」', true);
      await refreshAlibabaAccounts();
      await refreshEmployees();
    } catch (error) {
      say('ali-status', '删除失败：' + error.message, false);
    }
  }

  async function refreshAlibabaAccounts() {
    const data = await api('/api/alibaba-accounts');
    state.alibabaAccounts = data.items || [];
    renderAlibabaAccounts();
    renderAlibabaOptions();
  }

  function renderClients() {
    const body = $('clients').querySelector('tbody');
    body.textContent = '';
    if (!state.clients.length) {
      const tr = el('tr');
      const td = el('td', 'muted', '还没有 API 令牌。创建后请立即保存明文令牌。');
      td.colSpan = 8;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    state.clients.forEach((client) => {
      const tr = el('tr');
      const name = el('td');
      name.appendChild(el('div', 'member-name', client.name));
      name.appendChild(el('div', 'muted mono', client.token_prefix + '…'));
      tr.appendChild(name);
      tr.appendChild(el('td', null, KIND_LABEL[client.kind] || client.kind));
      const scopes = el('td');
      scopes.appendChild(scopePills(client.scopes));
      tr.appendChild(scopes);
      tr.appendChild(el('td', null, client.seller_id || '—'));
      tr.appendChild(el('td', null, fmtRows(client.rate_limit) + ' / 分'));
      const status = el('td');
      status.appendChild(pill(client.status === 'active' ? '启用' : '停用', client.status === 'active' ? 'ok' : 'empty'));
      tr.appendChild(status);
      tr.appendChild(el('td', 'muted', fmtTime(client.last_used_at)));
      const actions = el('td');
      const box = el('div', 'table-actions');
      const rotate = el('button', 'mini secondary js-rotate', '轮换');
      rotate.type = 'button';
      rotate.dataset.id = client.id;
      rotate.dataset.name = client.name;
      const toggle = el('button', 'mini js-toggle', client.status === 'active' ? '停用' : '启用');
      toggle.type = 'button';
      toggle.dataset.id = client.id;
      toggle.dataset.name = client.name;
      toggle.dataset.status = client.status;
      const remove = el('button', 'mini danger js-del', '删除');
      remove.type = 'button';
      remove.dataset.id = client.id;
      remove.dataset.name = client.name;
      box.appendChild(rotate); box.appendChild(toggle); box.appendChild(remove);
      actions.appendChild(box);
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }

  function renderCalls() {
    const body = $('calls').querySelector('tbody');
    body.textContent = '';
    if (!state.calls.length) {
      const tr = el('tr');
      const td = el('td', 'muted', '没有符合条件的调用记录。');
      td.colSpan = 8;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    state.calls.forEach((row) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'muted', fmtTime(row.created_at)));
      tr.appendChild(el('td', null, row.client_name || '—'));
      tr.appendChild(el('td', null, row.actor_type || '—'));
      tr.appendChild(el('td', 'mono', row.method));
      tr.appendChild(el('td', 'mono', row.path));
      const status = el('td');
      const cls = row.status >= 500 ? 'stale' : row.status >= 400 ? 'empty' : 'ok';
      status.appendChild(pill(String(row.status), cls));
      tr.appendChild(status);
      tr.appendChild(el('td', null, fmtRows(row.ms) + ' ms'));
      tr.appendChild(el('td', 'muted', row.ip || '—'));
      body.appendChild(tr);
    });
  }

  function renderAudits() {
    const body = $('audits').querySelector('tbody');
    body.textContent = '';
    if (!state.audits.length) {
      const tr = el('tr');
      const td = el('td', 'muted', '没有符合条件的审计记录。');
      td.colSpan = 6;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    state.audits.forEach((row) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'muted', fmtTime(row.created_at)));
      tr.appendChild(el('td', null, row.actor_name || row.actor_type || '—'));
      tr.appendChild(el('td', 'mono', row.action));
      tr.appendChild(el('td', null, row.target || '—'));
      const detail = row.detail && typeof row.detail === 'object'
        ? JSON.stringify(row.detail) : String(row.detail || '');
      tr.appendChild(el('td', 'muted', short(detail, 90) || '—'));
      tr.appendChild(el('td', 'muted', row.ip || '—'));
      body.appendChild(tr);
    });
  }

  function showToken(token, title) {
    $('token-title').textContent = title;
    $('token-value').textContent = token;
    $('token-reveal').classList.remove('hidden');
  }

  async function refreshEmployees() {
    const data = await api('/api/employees');
    state.employees = data.items || [];
    renderEmployees();
    renderKpis();
    renderBriefing();
  }

  async function refreshClients() {
    const [clients, overview] = await Promise.all([
      api('/api/gateway/clients'),
      api('/api/gateway/overview'),
    ]);
    state.clients = clients.items || [];
    state.overview = overview;
    renderClients();
    renderKpis();
    renderBriefing();
    renderTopPaths();
    renderGatewayMeta();
  }

  async function refreshCalls() {
    const minStatus = $('calls-filter').value || '0';
    const data = await api('/api/gateway/calls?limit=100&min_status=' + encodeURIComponent(minStatus));
    state.calls = data.items || [];
    renderCalls();
  }

  async function refreshAudits() {
    const action = $('audit-action').value.trim();
    const actor = $('audit-actor').value.trim();
    const data = await api('/api/audit?limit=100&action=' + encodeURIComponent(action)
      + '&actor=' + encodeURIComponent(actor));
    state.audits = data.items || [];
    renderAudits();
  }

  async function refreshGate() {
    const data = await api('/api/send-control');
    state.control = data.control || {};
    renderGate();
  }

  async function refreshDnc() {
    const data = await safeGet('/api/dnc?active=0&limit=100');
    state.dnc = data.items || [];
    renderDnc();
    say('dnc-status', '共 ' + state.dnc.length + ' 条');
  }

  async function toggleGate() {
    const paused = !(state.control && state.control.send_paused);
    try {
      const data = await api('/api/send-control', {
        method: 'PUT',
        body: { paused: paused, reason: $('gate-reason').value.trim() },
      });
      state.control = data.control || {};
      renderGate();
      say('gate-status', paused ? '已暂停发送' : '已恢复发送', true);
    } catch (error) {
      say('gate-status', '操作失败：' + error.message, false);
    }
  }

  async function addDnc() {
    const key = $('dnc-key').value.trim();
    if (!key) { say('dnc-status', '请填写客户键或询盘 ID', false); return; }
    try {
      await api('/api/dnc', {
        method: 'POST',
        body: {
          customer_key: key,
          reason: $('dnc-reason').value.trim(),
          until: $('dnc-until').value.trim(),
        },
      });
      $('dnc-key').value = '';
      $('dnc-reason').value = '';
      $('dnc-until').value = '';
      say('dnc-status', '已加入不联系名单', true);
      await refreshDnc();
    } catch (error) {
      say('dnc-status', '加入失败：' + error.message, false);
    }
  }

  async function removeDnc(key) {
    try {
      await api('/api/dnc?customer_key=' + encodeURIComponent(key), { method: 'DELETE' });
      say('dnc-status', '已移除 ' + key, true);
      await refreshDnc();
    } catch (error) {
      say('dnc-status', '移除失败：' + error.message, false);
    }
  }

  async function createEmployee() {
    const body = {
      email: $('new-email').value.trim(),
      name: $('new-name').value.trim(),
      password: $('new-password').value,
      role: $('new-role').value,
      seller_id: $('new-seller').value.trim() || 'seller-main',
      alibaba_account_id: $('new-alibaba').value,
    };
    if (!body.email) { say('create-status', '请填写邮箱', false); return; }
    if (body.password.length < 8) { say('create-status', '密码至少 8 位', false); return; }
    say('create-status', '正在创建…');
    try {
      await api('/api/employees', { method: 'POST', body: body });
      say('create-status', '已创建 ' + body.email, true);
      $('new-email').value = '';
      $('new-name').value = '';
      $('new-password').value = '';
      await refreshEmployees();
    } catch (error) {
      say('create-status', '创建失败：' + error.message, false);
    }
  }

  async function createClient() {
    const scopes = [];
    if ($('scope-read').checked) scopes.push('read');
    if ($('scope-write').checked) scopes.push('write');
    if ($('scope-collector').checked) scopes.push('collector');
    if (!scopes.length) { say('client-status', '至少选择一个调用范围', false); return; }
    const body = {
      name: $('client-name').value.trim(),
      kind: $('client-kind').value,
      scopes: scopes,
      rate_limit: Number($('client-rate').value) || 120,
      seller_id: $('client-seller').value.trim() || 'seller-main',
    };
    if (!body.name) { say('client-status', '请填写令牌名称', false); return; }
    say('client-status', '正在创建…');
    try {
      const data = await api('/api/gateway/clients', { method: 'POST', body: body });
      say('client-status', '已创建令牌 ' + body.name + '，请立即复制保存', true);
      showToken(data.token, '新令牌 · ' + body.name + '（只显示一次）');
      $('client-name').value = '';
      await refreshClients();
    } catch (error) {
      say('client-status', '创建失败：' + error.message, false);
    }
  }

  async function rotateClient(id, name) {
    if (!window.confirm('轮换「' + name + '」的令牌？旧令牌会立即失效。')) return;
    try {
      const data = await api('/api/gateway/clients/' + id + '/rotate', { method: 'POST', body: {} });
      showToken(data.token, '新令牌 · ' + name + '（只显示一次）');
      say('client-status', '已轮换 ' + name + '，请更新使用方配置', true);
      await refreshClients();
    } catch (error) {
      say('client-status', '轮换失败：' + error.message, false);
    }
  }

  async function toggleClient(id, name, status) {
    const next = status === 'active' ? 'disabled' : 'active';
    try {
      await api('/api/gateway/clients/' + id, { method: 'PATCH', body: { status: next } });
      say('client-status', (next === 'disabled' ? '已停用 ' : '已启用 ') + name, true);
      await refreshClients();
    } catch (error) {
      say('client-status', '操作失败：' + error.message, false);
    }
  }

  async function deleteClient(id, name) {
    if (!window.confirm('删除令牌「' + name + '」？删除后不可恢复，使用方会立即失去访问。')) return;
    try {
      await api('/api/gateway/clients/' + id, { method: 'DELETE' });
      say('client-status', '已删除 ' + name, true);
      await refreshClients();
    } catch (error) {
      say('client-status', '删除失败：' + error.message, false);
    }
  }

  async function toggleEmployee(id, email, status) {
    const next = status === 'active' ? 'disabled' : 'active';
    try {
      await api('/api/employees/' + id, { method: 'PATCH', body: { status: next } });
      say('employee-status', (next === 'disabled' ? '已停用 ' : '已启用 ') + email, true);
      await refreshEmployees();
    } catch (error) {
      say('employee-status', '操作失败：' + error.message, false);
    }
  }

  async function resetPassword(id, email) {
    const password = window.prompt('给 ' + email + ' 设置新密码（至少 8 位）');
    if (!password) return;
    if (password.length < 8) { say('employee-status', '密码至少 8 位', false); return; }
    try {
      await api('/api/employees/' + id, { method: 'PATCH', body: { password: password } });
      say('employee-status', '已重置 ' + email + ' 的密码', true);
    } catch (error) {
      say('employee-status', '重置失败：' + error.message, false);
    }
  }

  async function deleteEmployee(id, email) {
    if (!window.confirm('确定删除 ' + email + '？该操作不可恢复。')) return;
    try {
      await api('/api/employees/' + id, { method: 'DELETE' });
      say('employee-status', '已删除 ' + email, true);
      await refreshEmployees();
    } catch (error) {
      say('employee-status', '删除失败：' + error.message, false);
    }
  }

  function renderDenied() {
    state.admin = false;
    $('kpis').classList.add('hidden');
    $('tabs').classList.add('hidden');
    TABS.forEach(([name]) => $('panel-' + name).classList.add('hidden'));
    $('denied').classList.remove('hidden');
    $('briefing-text').textContent = '当前账号角色为「'
      + (ROLE_LABEL[state.me.role] || state.me.role) + '」，无权管理员工与 API 令牌。';
    $('gateway-badge').className = 'quality-badge warn';
    $('gateway-badge').textContent = '需要管理员';
    $('seller').textContent = '店铺 · ' + (state.me.seller_id || '—');
    $('updated').textContent = '只读身份 · ' + fmtTime(new Date().toISOString());
  }

  async function load() {
    const me = await api('/auth/me');
    state.me = me;
    state.admin = me.role === 'admin' && Boolean(me.employee);
    if (!state.admin) { renderDenied(); return; }
    const [overview, employees, alibaba, clients, calls, audits, control, dnc] = await Promise.all([
      api('/api/gateway/overview'),
      api('/api/employees'),
      api('/api/alibaba-accounts'),
      api('/api/gateway/clients'),
      api('/api/gateway/calls?limit=100'),
      api('/api/audit?limit=100'),
      api('/api/send-control'),
      safeGet('/api/dnc?active=0&limit=100'),
    ]);
    state.overview = overview;
    state.employees = employees.items || [];
    state.alibabaAccounts = alibaba.items || [];
    state.clients = clients.items || [];
    state.calls = calls.items || [];
    state.audits = audits.items || [];
    state.control = control.control || {};
    state.dnc = dnc.items || [];
    $('denied').classList.add('hidden');
    $('kpis').classList.remove('hidden');
    $('tabs').classList.remove('hidden');
    $('seller').textContent = '店铺 · ' + (me.seller_id || '—');
    $('updated').textContent = '更新于 ' + fmtTime(overview.generated_at);
    const seller = me.seller_id || 'seller-main';
    if (!$('new-seller').value || $('new-seller').value === 'seller-main') $('new-seller').value = seller;
    if (!$('client-seller').value || $('client-seller').value === 'seller-main') $('client-seller').value = seller;
    if (!$('ali-seller').value || $('ali-seller').value === 'seller-main') $('ali-seller').value = seller;
    renderBriefing();
    renderKpis();
    renderTabs();
    renderRoleMatrix();
    renderTopPaths();
    renderGatewayMeta();
    renderAlibabaAccounts();
    renderAlibabaOptions();
    renderEmployees();
    renderClients();
    renderGate();
    renderDnc();
    renderCalls();
    renderAudits();
  }

  function bind() {
    $('create-employee').onclick = createEmployee;
    $('create-client').onclick = createClient;
    $('ali-save').onclick = saveAlibabaAccount;
    $('ali-cancel').onclick = resetAlibabaForm;
    $('new-alibaba').onchange = () => {
      const account = (state.alibabaAccounts || []).find((item) => item.id === $('new-alibaba').value);
      if (account) $('new-seller').value = account.seller_id || '';
    };
    $('calls-refresh').onclick = () => refreshCalls().catch((e) => say('client-status', e.message, false));
    $('calls-filter').onchange = () => refreshCalls().catch(() => {});
    $('gate-toggle').onclick = toggleGate;
    $('dnc-add').onclick = addDnc;
    $('dnc-refresh').onclick = () => refreshDnc().catch(() => {});
    $('audit-search').onclick = () => refreshAudits().catch(() => {});
    $('audit-action').addEventListener('keydown', (event) => { if (event.key === 'Enter') refreshAudits(); });
    $('audit-actor').addEventListener('keydown', (event) => { if (event.key === 'Enter') refreshAudits(); });
    $('copy-token').onclick = async () => {
      const token = $('token-value').textContent;
      try {
        await navigator.clipboard.writeText(token);
        $('copy-token').textContent = '已复制';
      } catch (error) {
        const range = document.createRange();
        range.selectNodeContents($('token-value'));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        $('copy-token').textContent = '已选中，请按 Ctrl+C';
      }
    };

    $('employees').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const tr = button.closest('tr');
      if (!tr || !tr.dataset.id) return;
      if (button.classList.contains('js-edit')) { startEdit(tr); return; }
      const id = tr.dataset.id;
      const email = tr.dataset.email;
      if (button.classList.contains('js-pwd')) resetPassword(id, email);
      else if (button.classList.contains('js-toggle')) toggleEmployee(id, email, tr.dataset.status);
      else if (button.classList.contains('js-del')) deleteEmployee(id, email);
    });

    $('ali-accounts').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const tr = button.closest('tr');
      if (!tr || !tr.dataset.id) return;
      if (button.classList.contains('js-edit')) {
        const account = (state.alibabaAccounts || []).find((item) => item.id === tr.dataset.id);
        if (account) fillAlibabaForm(account);
      } else if (button.classList.contains('js-del')) {
        deleteAlibabaAccount(tr.dataset.id, tr.dataset.login);
      }
    });

    $('clients').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.classList.contains('js-rotate')) rotateClient(button.dataset.id, button.dataset.name);
      else if (button.classList.contains('js-toggle')) toggleClient(button.dataset.id, button.dataset.name, button.dataset.status);
      else if (button.classList.contains('js-del')) deleteClient(button.dataset.id, button.dataset.name);
    });

    $('dnc-rows').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button || !button.classList.contains('js-dnc-del')) return;
      removeDnc(button.dataset.key);
    });
  }

  bind();
  mount(load);
})();
