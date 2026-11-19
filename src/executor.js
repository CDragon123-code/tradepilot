// 执行台：读取云端已批准的回复，在阿里页面发送后回写结果
// 依赖 chrome.storage.local.aliCloudConfig（设置页登录后自动写入）
const $ = (id) => document.getElementById(id);
const ALI = 'https://message.alibaba.com/';

function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function say(text, ok) {
  const n = $('status');
  n.textContent = text;
  n.className = 'status' + (ok === true ? ' ok' : ok === false ? ' err' : '');
}

async function config() {
  const data = await chrome.storage.local.get('aliCloudConfig');
  return data.aliCloudConfig || {};
}

async function api(cfg, path, options) {
  const o = options || {};
  const headers = { authorization: 'Bearer ' + cfg.token };
  if (o.body) headers['content-type'] = 'application/json';
  const res = await fetch(cfg.baseUrl + path, {
    method: o.method || 'GET',
    headers: headers,
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || ('HTTP ' + res.status));
  return data;
}

let items = [];
let summary = { allowed: 0, blocked: 0 };

function gateText(it) {
  const g = it.gate || {};
  if (!g.allowed) {
    const why = (g.reasons || []).map((r) => r.label).join('；') || '当前不可发送';
    const until = g.next_allowed_at ? ('；最早 ' + new Date(g.next_allowed_at).toLocaleString('zh-CN')) : '';
    return '<span class="gate-block">' + esc(why + until) + '</span>';
  }
  const used = (g.daily_used || 0) + '/' + (g.daily_limit || 0);
  return '<span class="gate-ok">可发送 · 今日已用 ' + esc(used) + '</span>';
}

function render() {
  if (!items.length) {
    $('list').innerHTML = '<p class="hint">暂无待执行项。到云端「AI 运营台 → 待人工介入」通过一条草稿后，这里就会出现。</p>';
    return;
  }
  $('list').innerHTML = items.map((it) => (
    '<div class="item" data-id="' + esc(it.id) + '">'
    + '<div class="row"><div><span class="who">' + esc(it.customer_name || it.customer_key) + '</span>'
    + '<div class="meta">' + esc(it.country || '') + ' · ' + esc(it.subject || '') + ' · ID ' + esc(String(it.customer_key).replace(/^inquiry:/, '')) + '</div></div></div>'
    + '<div class="meta">' + (it.agent_name ? esc(it.agent_name) + ' · ' : '') + gateText(it) + '</div>'
    + '<div class="draft">' + esc(it.draft_text) + '</div>'
    + '<div class="actions">'
    + '<button class="sm" data-act="open">打开阿里聊天</button>'
    + '<button class="sm ghost" data-act="copy">复制话术</button>'
    + '<button class="sm ghost" data-act="sent">标记已发送</button>'
    + '<button class="sm ghost" data-act="failed">标记失败</button>'
    + '</div></div>'
  )).join('');
}

async function load() {
  const cfg = await config();
  if (!cfg.baseUrl || !cfg.token) {
    $('list').innerHTML = '';
    say('还没登录云端：到「设置 → 云端同步」用员工账号登录', false);
    return;
  }
  try {
    const d = await api(cfg, '/api/executions?limit=30');
    items = d.items || [];
    summary = { allowed: d.allowed_count || 0, blocked: d.blocked_count || 0 };
    render();
    say('共 ' + items.length + ' 条待执行；可发送 ' + summary.allowed + ' 条'
      + (summary.blocked ? ('，受限 ' + summary.blocked + ' 条') : ''), true);
  } catch (e) {
    say('读取失败：' + ((e && e.message) || e), false);
  }
}

async function mark(id, status) {
  const cfg = await config();
  let note = '';
  if (status === 'failed') note = window.prompt('失败原因（可选）') || '人工标记失败';
  try {
    await api(cfg, '/api/executions/' + id + '/result', {
      method: 'POST',
      body: { status: status, note: note },
    });
    await load();
  } catch (e) {
    say('回写失败：' + ((e && e.message) || e), false);
  }
}

$('list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  const item = btn.closest('.item');
  const id = item.getAttribute('data-id');
  const act = btn.getAttribute('data-act');
  if (act === 'open') {
    chrome.tabs.create({ url: ALI });
    return;
  }
  if (act === 'copy') {
    const data = items.filter((x) => x.id === id)[0];
    try {
      await navigator.clipboard.writeText((data && data.draft_text) || '');
      say('已复制，去阿里聊天窗口粘贴发送', true);
    } catch (e) {
      say('复制失败，请手动选中文本', false);
    }
    return;
  }
  if (act === 'sent') await mark(id, 'sent');
  if (act === 'failed') await mark(id, 'failed');
});

$('refresh') && ($('refresh').onclick = load);
$('regexec').onclick = load;
$('open-console').onclick = async () => {
  const cfg = await config();
  if (cfg.baseUrl) chrome.tabs.create({ url: cfg.baseUrl + '/console' });
  else chrome.runtime.openOptionsPage();
};
$('open-ali').onclick = () => chrome.tabs.create({ url: ALI });
$('open-options').onclick = () => chrome.runtime.openOptionsPage();
load();
