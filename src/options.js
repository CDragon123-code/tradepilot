// 统一把网络层错误翻译成可操作的提示（自签名证书是最常见的失败原因）
function friendlyNetError(err) {
  const msg = String((err && err.message) || err || '');
  if (/Failed to fetch|NetworkError|Load failed|ERR_CERT|net::/i.test(msg)) {
    const note = $('cert-note');
    if (note) note.style.display = '';
    return '连不上云端（Failed to fetch）：多为自签名证书未受信任。请点上方「打开服务地址（信任证书）」，在提示页选择「高级 → 继续前往」，再回来重试。';
  }
  return msg;
}

// 选项页：授权访问客户公司官网（用于「未转化客户跟进」的背调）
const $ = (id) => document.getElementById(id);
const has = (origin) => chrome.permissions.contains({ origins: [origin] }).catch(() => false);

async function refresh() {
  try {
    const https = await has('https://*/*');
    const http = await has('http://*/*');
    const ok = https || http;
    $('status').textContent = ok
      ? ('已授权：' + (https ? 'https' : '') + (https && http ? ' + ' : '') + (http ? 'http' : '') + '，可以抓取客户官网')
      : '未授权：客户官网不会被访问';
    $('status').style.color = ok ? '#15803d' : '#b45309';
    $('grant').textContent = ok ? '重新授权' : '授权访问客户官网';
  } catch (e) {
    $('status').textContent = '权限检查失败：' + ((e && e.message) || e);
    $('status').style.color = '#b91c1c';
  }
}

$('grant').onclick = async () => {
  let ok = false;
  // 先一并申请 https + http；失败再单独申请 https（多数官网只需 https）
  try {
    ok = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
  } catch (e) { /* 下一步单独试 */ }
  if (!ok) {
    try { ok = await chrome.permissions.request({ origins: ['https://*/*'] }); } catch (e) { /* ignore */ }
  }
  if (ok) {
    $('status').textContent = '授权成功，可以关闭本页，回到 AI 设置点「抓官网」';
    $('status').style.color = '#15803d';
  } else {
    $('status').textContent = '未授权：可能被浏览器/企业策略拦截，或被点了「取消」';
    $('status').style.color = '#b45309';
  }
  setTimeout(refresh, 300);
};

refresh();

// ---------------- 云端同步 ----------------
const cloudEls = {
  base: $('cloud-base'), token: $('cloud-token'), seller: $('cloud-seller'),
  enabled: $('cloud-enabled'), status: $('cloud-status'),
};

function sayCloud(text, ok) {
  cloudEls.status.textContent = text;
  cloudEls.status.style.color = ok === false ? '#b91c1c' : ok === true ? '#15803d' : '#6b7e96';
}

function describeCloudStatus(s) {
  if (!s) return '云端状态未知';
  const parts = ['本机队列 ' + (s.queued || 0) + ' 条 / ' + (s.queuedRows || 0) + ' 行'];
  if (s.uploaded) parts.push('上次上传 ' + s.uploaded + ' 行');
  if (s.lastError) parts.push('最近错误：' + friendlyNetError(s.lastError));
  else if (s.ok) parts.push('上次上传成功');
  return parts.join('；');
}

async function refreshFreshness() {
  const node = $('cloud-fresh');
  if (!node) return;
  const base = (cloudEls.base.value || '').trim();
  const token = (cloudEls.token.value || '').trim();
  if (!base || !token) { node.textContent = ''; return; }
  try {
    const res = await fetch(base.replace(/\/+$/, '') + '/api/freshness', {
      headers: { authorization: 'Bearer ' + token }, cache: 'no-store',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    const tier = { fresh: 0, delayed: 0, stale: 0, empty: 0, unknown: 0 };
    (d.kinds || []).forEach((k) => { tier[k.tier] = (tier[k.tier] || 0) + 1; });
    // 只认本扩展自己的心跳，避免测试/采集器的心跳混进来
    const me = (d.clients || []).filter((c) => c.client_id === chrome.runtime.id)[0]
      || (d.clients || []).filter((c) => c.client_id !== 'probe' && c.client_id !== 'cloud-collector')[0];
    const c = me;
    let text = '云端数据：新鲜 ' + (tier.fresh || 0) + ' · 延迟 ' + (tier.delayed || 0) + ' · 过期 ' + (tier.stale || 0);
    if (c) {
      const mins = Math.max(0, Math.round((Date.now() - Date.parse(c.last_seen_at)) / 60000));
      text += '；本机心跳 ' + mins + ' 分钟前，待传 ' + (c.queue_rows || 0) + ' 行';
      const miss = Object.keys(c.missing || {});
      if (miss.length) text += '；待补传：' + miss.map((k) => k + ' +' + c.missing[k]).join('、');
    } else {
      text += '；尚无本机心跳（扩展后台可能未运行，重新加载扩展后 1 分钟内出现）';
    }
    node.textContent = text;
    node.style.color = (tier.stale || 0) ? '#b45309' : '#8292a7';
  } catch (e) {
    node.textContent = '新鲜度读取失败：' + friendlyNetError(e);
    node.style.color = '#b91c1c';
  }
}

async function refreshCloud() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'cloudStatus' });
    if (!r || !r.ok) throw new Error((r && r.error) || '读取失败');
    cloudEls.base.value = r.config.baseUrl || '';
    cloudEls.token.value = r.config.token || '';
    cloudEls.seller.value = r.config.sellerId || '';
    cloudEls.enabled.checked = !!r.config.enabled;
    sayCloud(describeCloudStatus(r.status), r.status && r.status.ok);
    refreshFreshness();
    refreshCollector();
  } catch (e) {
    sayCloud('云端状态读取失败：' + ((e && e.message) || e), false);
  }
}

$('cloud-save').onclick = async () => {
  const baseUrl = cloudEls.base.value.trim();
  const token = cloudEls.token.value.trim();
  if (baseUrl) {
    let origin = '';
    try { origin = new URL(baseUrl).origin + '/*'; } catch (e) { origin = ''; }
    if (!origin) { sayCloud('服务地址格式不正确，请填完整 URL', false); return; }
    try { await chrome.permissions.request({ origins: [origin] }); } catch (e) { /* 授权失败时上传会提示 */ }
  }
  const r = await chrome.runtime.sendMessage({
    type: 'cloudSave',
    config: { baseUrl: baseUrl, token: token, sellerId: cloudEls.seller.value.trim(), enabled: cloudEls.enabled.checked },
  });
  if (!r || !r.ok) { sayCloud('保存失败：' + ((r && r.error) || '未知错误'), false); return; }
  if (r.sellerChanged) {
    sayCloud('已切换店铺，旧店铺待传队列已清空；请先在当前阿里账号下重新同步，再补传本机资料', false);
  } else {
    sayCloud('已保存' + (cloudEls.enabled.checked ? '，自动上传已开启' : '，自动上传未开启'), true);
  }
  setTimeout(refreshCloud, 300);
};

$('cloud-backfill').onclick = async () => {
  sayCloud('正在把现有资料库写入队列…');
  const r = await chrome.runtime.sendMessage({ type: 'cloudBackfill' });
  if (!r || !r.ok) { sayCloud('补传失败：' + ((r && r.error) || '未知错误'), false); return; }
  sayCloud('已入队 ' + r.rows + ' 行，队列剩余 ' + (r.result && r.result.remaining || 0) + ' 条', true);
  setTimeout(refreshCloud, 300);
};

$('cloud-drain').onclick = async () => {
  sayCloud('正在上传队列…');
  const r = await chrome.runtime.sendMessage({ type: 'cloudDrain' });
  if (!r || !r.ok) { sayCloud('上传失败：' + ((r && r.error) || '未知错误'), false); return; }
  const res = r.result || {};
  sayCloud('本次上传 ' + (res.uploaded || 0) + ' 行，队列剩余 ' + (res.remaining || 0) + ' 条'
    + (res.lastError ? ('；错误：' + res.lastError) : ''), !res.lastError);
  setTimeout(refreshCloud, 300);
};

refreshCloud();

// ---------------- 云端登录（内置地址，登录即用） ----------------
const CLOUD_CANDIDATES = ['https://api.example.com:8443'];
const SESSION_KEY = 'aliCloudSession';

// 依次探测内置地址，取第一个可用的；域名备案前通常回落公网 IP
async function pickCloudBase() {
  for (const base of CLOUD_CANDIDATES) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(base + '/health', { cache: 'no-store', signal: ctl.signal });
      clearTimeout(timer);
      if (r.ok) return base;
    } catch (e) { /* 试下一个 */ }
  }
  return '';
}

async function paintWho() {
  const data = await chrome.storage.local.get(SESSION_KEY);
  const s = data && data[SESSION_KEY];
  const who = $('cloud-who');
  if (!who) return;
  who.textContent = s && s.email
    ? ('已登录：' + (s.name || s.email) + '（店铺 ' + (s.sellerId || '-') + '）')
    : '未登录';
  who.style.color = s && s.email ? '#15803d' : '#8292a7';
}

// 补传后自动清队列：后台每轮只处理 2 条队列项
async function drainQueue(maxRuns) {
  for (let i = 0; i < (maxRuns || 6); i += 1) {
    const r = await chrome.runtime.sendMessage({ type: 'cloudDrain' });
    if (!r || !r.ok) return r;
    if (!r.result || !r.result.remaining) return r;
  }
  return null;
}

$('cloud-login').onclick = async () => {
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  if (!email || !password) { sayCloud('请填写员工邮箱和密码', false); return; }
  sayCloud('正在连接云端…');
  const base = await pickCloudBase();
  if (!base) {
    const note = $('cert-note');
    if (note) note.style.display = '';
    sayCloud('连不上云端：多为自签名证书未受信任。请点「打开服务地址（信任证书）」，在提示页选择「高级 → 继续前往」后再试', false);
    return;
  }
  let data = null;
  try {
    const res = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email, password: password }),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.message) || ('HTTP ' + res.status));
  } catch (e) {
    sayCloud('登录失败：' + friendlyNetError(e), false);
    return;
  }
  const session = {
    token: data.token,
    email: email,
    name: (data.employee && data.employee.name) || '',
    sellerId: data.seller_id || '',
    expiresAt: data.expires_at || '',
  };
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  const saved = await chrome.runtime.sendMessage({
    type: 'cloudSave',
    config: { baseUrl: base, token: data.token, sellerId: session.sellerId, enabled: true },
  });
  if (!saved || !saved.ok) { sayCloud('登录成功，但保存云端配置失败', false); return; }
  $('login-password').value = '';
  if (saved.sellerChanged) {
    sayCloud('已登录，店铺已切换为 ' + (session.sellerId || '-')
      + '；旧店铺待传队列已清空，本机资料未自动补传。请先在当前阿里账号下重新同步，再补传。', false);
    paintWho();
    refreshCloud();
    return;
  }
  sayCloud('已登录，正在补传现有资料库…', true);
  const bf = await chrome.runtime.sendMessage({ type: 'cloudBackfill' });
  const rows = bf && bf.ok ? bf.rows : 0;
  const drained = await drainQueue(6);
  const rest = drained && drained.result ? drained.result.remaining : 0;
  sayCloud('已登录并启用云端；本次入队 ' + rows + ' 行' + (rest ? ('，剩余 ' + rest + ' 条待上传') : '，队列已清空'), true);
  paintWho();
  refreshCloud();
};

$('cloud-logout').onclick = async () => {
  const data = await chrome.storage.local.get(SESSION_KEY);
  const s = data && data[SESSION_KEY];
  const base = (cloudEls.base.value || '').trim() || CLOUD_CANDIDATES[0];
  if (s && s.token) {
    try {
      await fetch(base + '/auth/logout', { method: 'POST', headers: { authorization: 'Bearer ' + s.token } });
    } catch (e) { /* 忽略 */ }
  }
  await chrome.storage.local.remove(SESSION_KEY);
  await chrome.runtime.sendMessage({ type: 'cloudSave', config: { baseUrl: '', token: '', sellerId: '', enabled: false } });
  sayCloud('已退出登录，自动上传已关闭', true);
  paintWho();
  refreshCloud();
};

$('open-executor').onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('executor.html') });
};

// 侧边栏工作台：与阿里页面同窗并排，不跳转
$('open-side').onclick = async () => {
  try {
    const win = await chrome.windows.getCurrent();
    if (chrome.sidePanel && chrome.sidePanel.open) {
      await chrome.sidePanel.open({ windowId: win.id });
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL('executor.html') });
    }
  } catch (e) {
    chrome.tabs.create({ url: chrome.runtime.getURL('executor.html') });
  }
};

// 托管当前阿里登录态到云端，供云端采集器使用
$('sync-state').onclick = async () => {
  sayCloud('正在同步登录态…');
  const r = await chrome.runtime.sendMessage({ type: 'collectorSync' });
  if (!r || !r.ok) {
    const text = friendlyNetError((r && r.error) || '未知错误');
    const hint = r && r.status === 403 ? '（需要管理员账号）' : '';
    sayCloud('同步失败：' + text + hint, false);
    refreshCollector();
    return;
  }
  sayCloud('已托管登录态（' + r.count + ' 条 cookie），云端采集将在下一轮使用', true);
  refreshCollector();
};

// 打开服务地址：用于首次信任自签名证书（浏览器提示页选「继续前往」）
$('open-cloud').onclick = async () => {
  const s = await chrome.storage.local.get(SESSION_KEY);
  const base = (s && s[SESSION_KEY] && s[SESSION_KEY].baseUrl) || CLOUD_CANDIDATES[0];
  chrome.tabs.create({ url: String(base).replace(/\/+$/, '') + '/health' });
  sayCloud('已打开服务地址：若提示证书不受信任，请选择「高级 → 继续前往」，然后回来重试', true);
};

// 登录态托管状态：是否已托管、最近同步时间、是否开启自动续期，并读取云端采集器的最近结论
async function refreshCollector() {
  const node = $('collector-state');
  const box = $('collector-auto');
  if (!node || !box) return;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'collectorStatus' });
    const meta = r && r.ok ? r.meta : null;
    // 云端采集器最近一次运行结论，比本地状态更能说明“现在能不能采”
    let cloudState = '';
    try {
      const base = (cloudEls.base.value || '').trim();
      const token = (cloudEls.token.value || '').trim();
      if (base && token) {
        const res = await fetch(base.replace(/\/+$/, '') + '/api/freshness', {
          headers: { authorization: 'Bearer ' + token }, cache: 'no-store',
        });
        if (res.ok) {
          const d = await res.json();
          const col = (d.clients || []).filter((c) => c.client_id === 'cloud-collector')[0];
          const m = col && /^collector:([a-z_]+):/.exec(String(col.version || ''));
          if (m) cloudState = m[1];
        }
      }
    } catch (e) { /* 云端状态读不到不影响本地显示 */ }
    if (!meta || !meta.at) {
      if (cloudState === 'login_expired') {
        node.textContent = '登录态云端托管：云端采集器报告登录态已失效，请在本机登录阿里国际站后点上方「同步登录态到云端」';
        node.style.color = '#b91c1c';
      } else if (cloudState === 'ok') {
        node.textContent = '登录态云端托管：云端采集器运行正常（本机未记录同步时间，可能是其他设备托管的）';
        node.style.color = '#15803d';
      } else {
        node.textContent = '登录态云端托管：未托管（云端采集器无法自动采集，关机后数据会停止更新）';
        node.style.color = '#b45309';
      }
      box.checked = false;
      return;
    }
    const mins = Math.max(0, Math.round((Date.now() - meta.at) / 60000));
    const when = mins < 60 ? (mins + ' 分钟前') : (Math.round(mins / 60) + ' 小时前');
    let text = '登录态云端托管：' + when + '同步（' + (meta.count || 0) + ' 条 cookie）';
    if (cloudState === 'login_expired') {
      text += '；云端采集器报告登录态已失效，请在本机登录阿里国际站后点右上「同步登录态到云端」';
    } else if (cloudState === 'ok') {
      text += '；云端采集器运行正常';
    }
    if (meta.lastError) text += '；最近错误：' + friendlyNetError(meta.lastError);
    node.textContent = text;
    node.style.color = (cloudState === 'login_expired' || meta.lastError) ? '#b91c1c' : '#15803d';
    box.checked = meta.auto !== false;
  } catch (e) {
    node.textContent = '登录态状态读取失败：' + ((e && e.message) || e);
    node.style.color = '#b91c1c';
  }
}

$('collector-auto').onchange = async () => {
  const r = await chrome.runtime.sendMessage({ type: 'collectorAuto', enabled: $('collector-auto').checked });
  if (!r || !r.ok) sayCloud('自动续期设置失败：' + ((r && r.error) || '未知错误'), false);
  else sayCloud(r.meta.auto ? '已开启登录态自动续期' : '已关闭登录态自动续期', true);
  refreshCollector();
};

paintWho();
refreshCollector();

// ---------------- 白名单自动发送 ----------------
function gapText(cfg) {
  return cfg.minGapSeconds + '-' + cfg.maxGapSeconds;
}

function parseGap(text, cfg) {
  const m = /^(\d+)\s*[-~到]\s*(\d+)$/.exec(String(text || '').trim());
  if (!m) return { minGapSeconds: cfg.minGapSeconds, maxGapSeconds: cfg.maxGapSeconds };
  const a = Number(m[1]);
  const b = Number(m[2]);
  return { minGapSeconds: Math.min(a, b), maxGapSeconds: Math.max(a, b) };
}

function sayAutoSend(text, ok) {
  const n = $('as-status');
  n.textContent = text;
  n.style.color = ok === false ? '#b91c1c' : ok === true ? '#15803d' : '#6b7e96';
}

function renderAutoSend(data) {
  const cfg = (data && data.config) || {};
  const st = (data && data.status) || {};
  $('as-enabled').checked = !!cfg.enabled;
  $('as-allowlist').value = (cfg.allowlist || []).join('\n');
  $('as-max').value = cfg.maxPerRun || 2;
  $('as-gap').value = cfg.minGapSeconds ? gapText(cfg) : '25-60';
  if (data && data.running) { sayAutoSend('正在执行中…'); return; }
  if (!st.at) { sayAutoSend('尚未运行'); return; }
  const mins = Math.max(0, Math.round((Date.now() - st.at) / 60000));
  const parts = ['上次运行 ' + mins + ' 分钟前', '成功 ' + (st.sent || 0), '失败 ' + (st.failed || 0)];
  if (st.uncertain) parts.push('待核实 ' + st.uncertain);
  if (st.skipped) parts.push('跳过 ' + st.skipped);
  if (st.lastError) parts.push('错误：' + st.lastError);
  sayAutoSend(parts.join('；'), !st.lastError);
}

async function refreshAutoSend() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'autoSendStatus' });
    if (!r || !r.ok) throw new Error((r && r.error) || '读取失败');
    renderAutoSend(r.data);
  } catch (e) {
    sayAutoSend('读取失败：' + ((e && e.message) || e), false);
  }
}

$('as-save').onclick = async () => {
  const allowlist = $('as-allowlist').value.split(/\n/).map((x) => x.trim()).filter(Boolean);
  if ($('as-enabled').checked && !allowlist.length) {
    sayAutoSend('启用前请至少填一个白名单客户', false);
    return;
  }
  const r = await chrome.runtime.sendMessage({
    type: 'autoSendSave',
    config: Object.assign({
      enabled: $('as-enabled').checked,
      allowlist: allowlist,
      maxPerRun: Number($('as-max').value) || 2,
    }, parseGap($('as-gap').value, { minGapSeconds: 25, maxGapSeconds: 60 })),
  });
  if (!r || !r.ok) { sayAutoSend('保存失败：' + ((r && r.error) || '未知错误'), false); return; }
  sayAutoSend('已保存' + (r.config.enabled ? '，自动发送已开启（仅白名单）' : '，自动发送未开启'), true);
  setTimeout(refreshAutoSend, 300);
};

$('as-run').onclick = async () => {
  sayAutoSend('正在跑一轮…');
  $('as-run').disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'autoSendNow' });
    if (!r || !r.ok) { sayAutoSend('执行失败：' + ((r && r.error) || '未知错误'), false); return; }
    const x = r.result || {};
    if (x.skipped === 'disabled') sayAutoSend('自动发送未开启（可先保存并勾选启用）', false);
    else if (x.skipped === 'no_allowlist') sayAutoSend('白名单为空，未发送', false);
    else if (x.skipped === 'no_cloud') sayAutoSend('还没登录云端', false);
    else if (x.skipped === 'busy') sayAutoSend('上一轮还在执行', false);
    else sayAutoSend('本轮成功 ' + (x.sent || 0) + '，失败 ' + (x.failed || 0)
      + (x.uncertain ? ('，待核实 ' + x.uncertain) : '') + (x.skipped ? ('，跳过 ' + x.skipped) : ''), !x.failed);
  } finally {
    $('as-run').disabled = false;
    setTimeout(refreshAutoSend, 300);
  }
};

refreshAutoSend();
