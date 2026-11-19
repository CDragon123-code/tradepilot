'use strict';

// 云端工作台：数据源健康与员工待办处理
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'aliCloudToken';
const KIND_LABEL = {
  inquiry: '询盘', chat: '聊天', customer: '我的客户',
  public_customer: '公海客户', order: '订单', visitor: '访客', ad_report: '投流报表',
};
const STATUS_LABEL = { ok: '正常', stale: '延迟', empty: '空' };
let timer = null;
let canResolve = false;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function fmtTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function fmtRows(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

async function api(path, options = {}) {
  const token = sessionStorage.getItem(TOKEN_KEY) || sessionStorage.getItem('aliAdminToken') || '';
  const headers = token ? { authorization: 'Bearer ' + token } : {};
  if (options.body) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method: options.method || 'GET', headers,
    body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const e = new Error('unauthorized');
    e.status = 401;
    throw e;
  }
  if (!res.ok) throw new Error(data.message || data.error || ('HTTP ' + res.status));
  return data;
}

function showGate(message) {
  $('gate').classList.remove('hidden');
  $('view').classList.add('hidden');
  $('head-actions').classList.add('hidden');
  $('gate-msg').textContent = message || '';
}

function kpi(label, value, hint) {
  const box = el('div', 'kpi');
  box.appendChild(el('div', 'k', label));
  box.appendChild(el('div', 'v', value));
  if (hint) box.appendChild(el('div', 'h', hint));
  return box;
}

function renderKpis(s, home) {
  const box = $('kpis');
  box.textContent = '';
  const actionable = home && home.todos && home.todos[0] && home.todos[0].key === 'none'
    ? 0 : Number(home && home.todo_count || 0);
  const delayed = (s.sources || []).filter((src) => src.status !== 'ok').length
    + (s.gaps || []).filter((gap) => String(gap.title || '').startsWith('尚未同步')).length;
  box.appendChild(kpi('当前待处理', actionable, '根据近 3 天活动生成'));
  box.appendChild(kpi('当前态记录', fmtRows(s.totals.rows), '已入库业务资料'));
  box.appendChild(kpi('同步需核对', delayed, delayed ? '查看下方数据源状态' : '当前来源状态正常'));
  box.appendChild(kpi('资料缺口', s.totals.gap_count, s.totals.gap_count ? '影响客户判断' : '暂无高于阈值的缺口'));
}

function renderBriefing(s, home) {
  $('briefing-text').textContent = home && home.headline || '暂无业务简报，请先完成数据同步。';
  const delayed = (s.sources || []).filter((src) => src.status !== 'ok').length
    + (s.gaps || []).filter((gap) => String(gap.title || '').startsWith('尚未同步')).length;
  const badge = $('quality-badge');
  badge.className = 'quality-badge' + (delayed || s.totals.gap_count ? ' warn' : '');
  badge.textContent = delayed ? delayed + ' 个数据源需核对'
    : s.totals.gap_count ? s.totals.gap_count + ' 项资料缺口' : '数据源状态正常';
}

function renderSources(s) {
  const body = $('sources').querySelector('tbody');
  body.textContent = '';
  if (!s.sources.length) {
    const tr = el('tr');
    const td = el('td', 'muted', '还没有任何数据源，先在扩展里完成一次同步');
    td.colSpan = 6;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  s.sources.forEach((src) => {
    const tr = el('tr');
    tr.appendChild(el('td', null, KIND_LABEL[src.kind] || src.kind));
    tr.appendChild(el('td', null, fmtRows(src.rows)));
    tr.appendChild(el('td', null, src.batches));
    tr.appendChild(el('td', null, fmtTime(src.last_success_at)));
    tr.appendChild(el('td', null, fmtTime(src.last_business_at)));
    const td = el('td');
    const pill = el('span', 'pill ' + src.status, STATUS_LABEL[src.status] || src.status);
    td.appendChild(pill);
    if (src.status === 'stale' && src.age_hours) td.appendChild(el('span', 'muted', ' ' + src.age_hours + ' 小时前'));
    tr.appendChild(td);
    body.appendChild(tr);
  });
}

function renderGaps(s) {
  const box = $('gaps');
  box.textContent = '';
  if (!s.gaps.length) {
    box.appendChild(el('p', 'muted', '没有发现超过阈值的缺口。'));
    return;
  }
  s.gaps.forEach((g) => {
    const card = el('div', 'gap');
    const head = el('div', 'gap-head');
    const left = el('div');
    left.appendChild(el('span', 'gap-title', g.title));
    head.appendChild(left);
    const right = el('div');
    right.appendChild(el('span', 'lv ' + g.level, g.level));
    head.appendChild(right);
    card.appendChild(head);

    if (g.total) {
      const value = el('div', 'muted', g.count + ' / ' + g.total + '（' + g.ratio + '%）');
      card.appendChild(value);
      const bar = el('div', 'bar');
      const fill = el('i');
      fill.style.width = Math.max(2, Math.min(100, Number(g.ratio) || 0)) + '%';
      bar.appendChild(fill);
      card.appendChild(bar);
    }
    card.appendChild(el('div', 'gap-detail', g.detail || ''));
    if (g.action) card.appendChild(el('div', 'gap-action', '建议：' + g.action));
    box.appendChild(card);
  });
}

function renderRecent(s) {
  const body = $('recent').querySelector('tbody');
  body.textContent = '';
  if (!s.recent.length) {
    const tr = el('tr');
    const td = el('td', 'muted', '还没有已提交的导入批次');
    td.colSpan = 4;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  s.recent.forEach((b) => {
    const tr = el('tr');
    tr.appendChild(el('td', null, String(b.id || '').slice(0, 8)));
    tr.appendChild(el('td', null, KIND_LABEL[b.kind] || b.kind));
    tr.appendChild(el('td', null, fmtRows(b.rows)));
    tr.appendChild(el('td', null, fmtTime(b.committed_at)));
    body.appendChild(tr);
  });
}

function renderTodos(home) {
  const todos = home && home.todos || [];
  const resolved = home && home.resolved || [];
  $('todo-count').textContent = String(todos[0] && todos[0].key === 'none' ? 0 : Number(home && home.todo_count || 0));
  $('resolved-count').textContent = String(resolved.length);
  const box = $('todos');
  box.textContent = '';
  if (!todos.length) box.appendChild(el('div', 'empty-state', '目前没有待处理事项。'));
  todos.forEach((todo) => {
    const card = el('article', 'todo-item ' + String(todo.level || 'P2').toLowerCase());
    card.appendChild(el('span', 'pill ' + (todo.level === 'P0' ? 'stale' : 'ok'), todo.tag || '待办'));
    card.appendChild(el('div', 'todo-item-title', todo.title));
    card.appendChild(el('div', 'todo-meta', [todo.priorityLabel, todo.owner, todo.due].filter(Boolean).join(' · ')));
    if (todo.detail) card.appendChild(el('p', 'todo-detail', todo.detail));
    const actions = el('div', 'todo-actions');
    if (todo.url) {
      const link = el('a', null, todo.action || '打开原页面');
      link.href = todo.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      actions.appendChild(link);
    }
    if (canResolve && todo.key !== 'none') {
      const done = el('button', 'primary', '标记已处理');
      done.type = 'button'; done.onclick = () => decide(todo.id, 'done');
      const dismiss = el('button', null, '暂不处理');
      dismiss.type = 'button'; dismiss.onclick = () => decide(todo.id, 'dismissed');
      actions.appendChild(done); actions.appendChild(dismiss);
    }
    card.appendChild(actions);
    box.appendChild(card);
  });
  const resolvedBox = $('resolved'); resolvedBox.textContent = '';
  resolved.forEach((row) => {
    const item = el('div', 'todo-item');
    item.appendChild(el('div', 'todo-item-title', row.title || row.todo_id.slice(0, 8)));
    item.appendChild(el('div', 'todo-meta', (row.state === 'done' ? '已处理' : '暂不处理') + ' · ' + fmtTime(row.updated_at)));
    if (canResolve) {
      const actions = el('div', 'todo-actions');
      const reopen = el('button', null, '恢复');
      reopen.type = 'button'; reopen.onclick = () => decide(row.todo_id, 'open');
      actions.appendChild(reopen); item.appendChild(actions);
    }
    resolvedBox.appendChild(item);
  });
}

async function decide(id, state) {
  $('todo-msg').textContent = '正在保存…';
  try {
    await api('/api/todo-decisions', { method: 'PATCH', body: { id, state } });
    $('todo-msg').textContent = '已保存';
    await load();
  } catch (e) { $('todo-msg').textContent = '保存失败：' + e.message; }
}

function render(s, overview) {
  $('seller').textContent = '店铺 · ' + s.seller_id;
  $('updated').textContent = '更新于 ' + fmtTime(s.generated_at);
  renderBriefing(s, overview.home);
  renderKpis(s, overview.home);
  renderSources(s);
  renderGaps(s);
  renderRecent(s);
  renderTodos(overview.home);
  $('gate').classList.add('hidden');
  $('view').classList.remove('hidden');
  $('head-actions').classList.remove('hidden');
}

async function load() {
  const token = sessionStorage.getItem(TOKEN_KEY) || sessionStorage.getItem('aliAdminToken');
  if (!token) return showGate('');
  try {
    const [s, overview, me] = await Promise.all([
      api('/dashboard/summary'), api('/api/overview'), api('/auth/me'),
    ]);
    canResolve = me.kind === 'employee' && me.role !== 'viewer';
    render(s, overview);
  } catch (e) {
    if (e.status === 401) {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem('aliAdminToken');
      showGate('Token 无效或已变更，请重新输入');
      return;
    }
    if ($('view').classList.contains('hidden')) showGate('读取失败：' + e.message);
    else $('updated').textContent = '刷新失败：' + e.message;
  }
}

$('connect').onclick = () => {
  const token = $('token').value.trim();
  if (!token) { $('gate-msg').textContent = '请填写 API_TOKEN'; return; }
  sessionStorage.setItem(TOKEN_KEY, token);
  $('gate-msg').textContent = '';
  load();
};

$('login').onclick = async () => {
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!email || !password) { $('gate-msg').textContent = '请填写邮箱和密码'; return; }
  try {
    const res = await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '登录失败');
    sessionStorage.setItem(TOKEN_KEY, data.token);
    $('password').value = '';
    load();
  } catch (e) { $('gate-msg').textContent = e.message; }
};

$('token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('connect').click();
});

$('refresh').onclick = () => load();
$('switch-account').onclick = () => {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem('aliAdminToken');
  canResolve = false;
  showGate('');
};
$('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('login').click();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('view').classList.contains('hidden')) load();
});

timer = setInterval(() => {
  if (!document.hidden && !$('view').classList.contains('hidden')) load();
}, 60000);
window.addEventListener('beforeunload', () => clearInterval(timer));

load();
