// MV3 后台：① 下载文件（改名） ② 代理跨域请求（带 cookie） ③ 数据入库 + 打开看板 ④ AI 流式转发
importScripts('data-core.js', 'db.js', 'identity.js', 'order-match.js', 'analyze.js', 'ai-key-crypto.js', 'sync-state.js', 'cloud-outbox.js', 'sse.js', 'dify.js', 'autosend.js'); // 本地归并 / 数据层 / 身份层 / 订单归因 / 展会筛选 / AI 密钥加密 / 同步状态 / 云端队列 / SSE / Dify / 白名单自动发送

// 下载策略：
//   主世界注入：让页面自身创建 blob + <a download> 触发下载；
//   再用 onDeterminingFilename 把本次导出期望的文件名「盖」回去
//   （实测 message.alibaba.com 询盘页会吞掉 <a download> 的名字）。
//
// ⚠️ 关键：期望文件名必须**持久化**（chrome.storage.session），不能只放内存数组。
//   MV3 的 service worker 会在空闲时被回收；若下载事件到来时 SW 是刚被唤醒的新实例，
//   内存里的队列就是空的 → 改名失效 → 文件名退化成 blob URL 的 UUID（真机复现过）。
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PENDING_NAME_KEY = 'aliPendingDownloadName';
const AI_TAB_FOCUS_PREFIX = 'aliAiTabFocus:';

function showSyncBadge(progress) {
  const status = progress && !progress.dismissed ? progress.status : '';
  const value = Math.max(0, Math.min(99, Number(progress && progress.percent) || 0));
  const label = status === 'running' ? value + '%' : status === 'done' ? '✓' : status === 'error' ? '!' : '';
  chrome.action.setBadgeText({ text: label }).catch(() => {});
  if (label) chrome.action.setBadgeBackgroundColor({ color: status === 'done' ? '#198754' : status === 'error' ? '#c4423a' : '#1858c9' }).catch(() => {});
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.aliPlatformSyncProgress) showSyncBadge(changes.aliPlatformSyncProgress.newValue);
});
chrome.storage.local.get('aliPlatformSyncProgress').then((data) => showSyncBadge(data.aliPlatformSyncProgress)).catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(AI_TAB_FOCUS_PREFIX + tabId).catch(() => {});
  chrome.storage.local.get(['aliPlatformSyncLock', 'aliPlatformSyncProgress']).then((data) => {
    const run = data.aliPlatformSyncLock;
    if (!run || run.tabId !== tabId) return;
    chrome.storage.local.remove('aliPlatformSyncLock').catch(() => {});
    if (run.collectorTabId != null) chrome.tabs.remove(run.collectorTabId).catch(() => {});
    const progress = data.aliPlatformSyncProgress;
    if (progress && progress.status === 'running' && progress.runId === run.id) {
      chrome.storage.local.set({ aliPlatformSyncProgress: { ...progress, status: 'error',
        message: '更新任务页面已关闭，采集已中断；可重新点击自动更新', at: Date.now(), dismissed: false } }).catch(() => {});
    }
  }).catch(() => {});
});

// 员工可从浏览器工具栏直接进入今日待办；页面左侧入口仍用于当前页面操作。
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});
chrome.runtime.onInstalled.addListener((details) => {
  // 首次安装直接进设置页登录，登录后自动绑定云端与店铺
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  ensureSyncAlarm();
  ensureAdsAlarm();
  if (typeof ensureAutosendAlarm === 'function') ensureAutosendAlarm();
});

// 扩展独立运行：浏览器开启且首次导入完成后，定期启动后台标签页续传。
const SYNC_ALARM = 'aliPlatformIncrementalSync';
async function ensureSyncAlarm() {
  const alarm = await chrome.alarms.get(SYNC_ALARM);
  if (!alarm) await chrome.alarms.create(SYNC_ALARM, { delayInMinutes: 1, periodInMinutes: 15 });
}
async function runScheduledSync() {
  const now = Date.now();
  const workspace = await self.AliDB.activeWorkspace();
  const state = await self.AliSyncState.load(chrome.storage.local, workspace);
  if (!state.fingerprint || !state.bootstrapComplete) return;
  if (now - Number(state.syncAtMs || 0) < 15 * 60 * 1000) return;
  const saved = await chrome.storage.local.get(['aliPlatformSyncProgress', 'aliPlatformSyncLock']);
  const previous = saved.aliPlatformSyncProgress;
  const retryDelay = previous && previous.workspace === workspace && previous.status === 'error'
    ? 60 * 60 * 1000 : 15 * 60 * 1000;
  if (now - Number(state.autoAttemptAt || 0) < retryDelay) return;
  const lock = saved.aliPlatformSyncLock;
  if (lock && lock.tabId != null) {
    try { if (await chrome.tabs.get(lock.tabId)) return; } catch (e) { /* 旧任务已退出 */ }
  }
  if (previous && previous.status === 'running') {
    try { if (previous.runnerTabId && await chrome.tabs.get(previous.runnerTabId)) return; }
    catch (e) { /* 旧任务已退出 */ }
    if (now - Number(previous.at || 0) < 30 * 1000) return;
  }
  const runId = crypto.randomUUID();
  const url = new URL(chrome.runtime.getURL('dashboard.html'));
  url.searchParams.set('platformRunner', '1');
  url.searchParams.set('runId', runId);
  await self.AliSyncState.save(chrome.storage.local, workspace, { autoAttemptAt: now });
  await chrome.storage.local.set({ aliPlatformSyncProgress: {
    runId, status: 'running', completed: 0, total: 0, percent: 0,
    message: '正在启动定时增量更新…', at: now, dismissed: false, runnerTabId: null, workspace,
  } });
  try {
    const tab = await chrome.tabs.create({ url: url.href, active: false });
    chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
    const current = (await chrome.storage.local.get('aliPlatformSyncProgress')).aliPlatformSyncProgress;
    if (current && current.runId === runId)
      await chrome.storage.local.set({ aliPlatformSyncProgress: { ...current, runnerTabId: tab.id } });
  } catch (e) {
    await chrome.storage.local.set({ aliPlatformSyncProgress: {
      runId, status: 'error', message: '定时更新未能启动：' + e.message,
      at: Date.now(), dismissed: false, workspace,
    } });
  }
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) runScheduledSync().catch((e) => console.error('定时更新失败', e));
  else if (alarm.name === ADS_ALARM) runAdsDailySync().catch((e) => console.error('投流每日同步失败', e));
  else if (alarm.name === CLOUD_ALARM) {
    if (self.AliCloudOutbox) self.AliCloudOutbox.drain().catch((e) => console.error('云端上传失败', e));
  } else if (alarm.name === 'aliCloudDrainSoon') {
    if (self.AliCloudOutbox) self.AliCloudOutbox.drain().catch((e) => console.error('云端续传失败', e));
  } else if (alarm.name === HEARTBEAT_ALARM) {
    sendHeartbeat();
  } else if (alarm.name === AUTOSEND_ALARM) {
    if (self.AliAutoSend) self.AliAutoSend.runOnce().catch((e) => console.error('自动发送失败', e));
  } else if (alarm.name === COLLECTOR_SYNC_ALARM) {
    autoSyncCollector().catch((e) => console.error('登录态自动续期失败', e));
  } else if (alarm.name === 'aliExtensionUpdateCheck') {
    checkStagedUpdate().catch(() => {});
  }
});
ensureSyncAlarm().catch((e) => console.error('创建定时更新任务失败', e));

// 云端上传队列：每 5 分钟尝试一次，采集入库后也会立即触发
const CLOUD_ALARM = 'aliCloudUpload';
async function ensureCloudAlarm() {
  const alarm = await chrome.alarms.get(CLOUD_ALARM);
  if (!alarm) await chrome.alarms.create(CLOUD_ALARM, { delayInMinutes: 1, periodInMinutes: 5 });
}
ensureCloudAlarm().catch((e) => console.error('创建云端上传任务失败', e));

// 心跳：每 5 分钟向云端报告版本、待传队列与本机条数，用于新鲜度与对账
const HEARTBEAT_ALARM = 'aliCloudHeartbeat';
async function ensureHeartbeatAlarm() {
  const alarm = await chrome.alarms.get(HEARTBEAT_ALARM);
  if (!alarm) await chrome.alarms.create(HEARTBEAT_ALARM, { delayInMinutes: 1, periodInMinutes: 5 });
}
ensureHeartbeatAlarm().catch((e) => console.error('创建心跳任务失败', e));

// ---------------- 云端自动更新 ----------------
// 本机定时任务从云端下载新版本并覆盖扩展文件夹后，会写入 update-ready.json；
// 这里轮询该标记，发现新版本且当前没有发送任务时自动重载扩展。
const UPDATE_ALARM = 'aliExtensionUpdateCheck';
const UPDATE_READY_FILE = 'update-ready.json';
const UPDATE_LAST_VERSION_KEY = 'aliLastRunVersion';

function versionParts(v) {
  return String(v || '').split('.').map((x) => parseInt(x, 10) || 0);
}
function isNewerVersion(a, b) {
  const pa = versionParts(a), pb = versionParts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}
async function ensureUpdateAlarm() {
  const alarm = await chrome.alarms.get(UPDATE_ALARM);
  if (!alarm) await chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 2, periodInMinutes: 3 });
}
async function readStagedVersion() {
  // 1) 更新器写入的标记文件（新文件，不会被扩展资源缓存）
  try {
    const res = await fetch(chrome.runtime.getURL(UPDATE_READY_FILE) + '?t=' + Date.now(), { cache: 'no-store' });
    if (res.ok) {
      const info = await res.json();
      if (info && info.version) return String(info.version);
    }
  } catch (e) { /* 文件还不存在 */ }
  // 2) 兜底：文件已覆盖后，磁盘上的 manifest.json 版本也会变
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json') + '?t=' + Date.now(), { cache: 'no-store' });
    if (res.ok) {
      const m = await res.json();
      if (m && m.version) return String(m.version);
    }
  } catch (e) { /* ignore */ }
  return '';
}
async function checkStagedUpdate() {
  const staged = await readStagedVersion();
  if (!staged) return;
  const cur = chrome.runtime.getManifest().version;
  if (!isNewerVersion(staged, cur)) return;
  // 正在批量发送时不打断；等发送结束后的下一轮再重载（发送方最多持有 2 小时）
  const saved = await chrome.storage.local.get('aliUpdateHold').catch(() => ({}));
  const holdAt = Number(saved && saved.aliUpdateHold) || 0;
  if (holdAt && Date.now() - holdAt < 2 * 60 * 60 * 1000) return;
  console.log('[ali-export-ext] 检测到已下载的新版本', staged, '（当前', cur, '），自动重载扩展');
  try { chrome.runtime.reload(); } catch (e) { /* 下一轮再试 */ }
}
// 页面内提示条：扩展升级后，已打开的阿里页面仍运行旧内容脚本，需要刷新
function showUpdateBanner(version) {
  try {
    if (!document.body || document.getElementById('ali-update-banner')) return;
    const b = document.createElement('div');
    b.id = 'ali-update-banner';
    b.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;'
      + 'background:#111827;color:#fff;padding:9px 12px;border-radius:10px;'
      + 'font:13px/1.5 "Microsoft YaHei",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);display:flex;gap:10px;align-items:center;';
    const span = document.createElement('span');
    span.textContent = '外贸助手已更新到 v' + version + '，刷新页面后生效';
    const btn = document.createElement('button');
    btn.textContent = '立即刷新';
    btn.style.cssText = 'border:0;background:#2563eb;color:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;white-space:nowrap;';
    btn.onclick = () => location.reload();
    const later = document.createElement('button');
    later.textContent = '稍后';
    later.style.cssText = 'border:0;background:transparent;color:#9ca3af;cursor:pointer;white-space:nowrap;';
    later.onclick = () => b.remove();
    b.appendChild(span); b.appendChild(btn); b.appendChild(later);
    document.body.appendChild(b);
  } catch (e) { /* ignore */ }
}
// 浏览器里已打开的阿里页面不会自动换成新内容脚本：版本变化时提示刷新
async function maybeAnnounceUpdate() {
  const cur = chrome.runtime.getManifest().version;
  let saved = {};
  try { saved = await chrome.storage.local.get(UPDATE_LAST_VERSION_KEY); } catch (e) { return; }
  const last = saved && saved[UPDATE_LAST_VERSION_KEY];
  try { await chrome.storage.local.set({ [UPDATE_LAST_VERSION_KEY]: cur }); } catch (e) { /* ignore */ }
  if (!last || last === cur || !isNewerVersion(cur, last)) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: 'https://*.alibaba.com/*' }); } catch (e) { return; }
  for (const t of tabs) {
    if (t.id == null) continue;
    chrome.scripting.executeScript({ target: { tabId: t.id }, func: showUpdateBanner, args: [cur] }).catch(() => {});
  }
}
ensureUpdateAlarm().catch((e) => console.error('创建扩展更新检查任务失败', e));
checkStagedUpdate().catch(() => {});
maybeAnnounceUpdate().catch(() => {});

// ---------------- 扩展内「版本更新」按钮 ----------------
// 扩展不能直接写自己的文件夹，更新动作交给本机更新服务（127.0.0.1:17878）执行。
const UPDATE_AGENT = 'http://127.0.0.1:17878';
async function extensionUpdateCheck() {
  const saved = await chrome.storage.local.get('aliCloudConfig').catch(() => ({}));
  const cfg = (saved && saved.aliCloudConfig) || {};
  const list = [cfg.baseUrl, 'https://api.example.com:8443']
    .filter(Boolean).map((u) => String(u).replace(/\/+$/, ''));
  const seen = new Set();
  let latest = '';
  let base = '';
  for (const u of list) {
    if (seen.has(u)) continue;
    seen.add(u);
    try {
      const r = await fetch(u + '/extension/version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.version) { latest = String(j.version); base = u; break; }
    } catch (e) { /* 试下一个入口 */ }
  }
  const cur = chrome.runtime.getManifest().version;
  if (!latest) return { ok: false, error: '连接云端失败，请检查网络或证书' };
  return { ok: true, current: cur, latest: latest, update: isNewerVersion(latest, cur), baseUrl: base };
}
async function extensionUpdateApply() {
  const saved = await chrome.storage.local.get('aliUpdateHold').catch(() => ({}));
  const holdAt = Number(saved && saved.aliUpdateHold) || 0;
  if (holdAt && Date.now() - holdAt < 2 * 60 * 60 * 1000) {
    return { ok: false, error: '正在发送消息，请等发送结束后再更新' };
  }
  try {
    const r = await fetch(UPDATE_AGENT + '/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    return { ok: false, error: '更新服务未启动：请运行「安装自动更新.cmd」后再试，或联系管理员' };
  }
}

async function sendHeartbeat() {
  try {
    const cfg = (await chrome.storage.local.get('aliCloudConfig')).aliCloudConfig;
    if (!cfg || !cfg.enabled || !cfg.baseUrl || !cfg.token) return;
    const kinds = ['inquiry', 'chat', 'customer', 'public_customer', 'order', 'visitor'];
    // 与云端口径对齐：按 platform_id 去重后计数（聊天是低置信度哈希，重复行会被云端合并）
    const counts = {};
    if (self.AliDB && self.AliDB.localDataset) {
      const data = await self.AliDB.localDataset(kinds);
      const outbox = self.AliCloudOutbox;
      kinds.forEach((k) => {
        const rows = data[k] || [];
        counts[k] = outbox && outbox.rowKey ? new Set(rows.map((r) => outbox.rowKey(k, r))).size : rows.length;
      });
    }
    const queue = (await chrome.storage.local.get('aliCloudOutbox')).aliCloudOutbox || [];
    const queueRows = queue.reduce((s, it) => s + (it.rows ? it.rows.length : 0), 0);
    const st = (await chrome.storage.local.get('aliCloudSyncStatus')).aliCloudSyncStatus || {};
    await fetch(String(cfg.baseUrl).replace(/\/+$/, '') + '/api/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.token },
      body: JSON.stringify({
        client_id: chrome.runtime.id,
        version: chrome.runtime.getManifest().version,
        queue_rows: queueRows,
        counts: counts,
        last_upload_at: st.at ? new Date(st.at).toISOString() : null,
      }),
    });
  } catch (e) { /* 心跳失败不打扰用户，下一轮再试 */ }
}

// 白名单自动发送：每 5 分钟看一次队列，是否真的发送由开关与白名单决定
const AUTOSEND_ALARM = 'aliAutoSend';
async function ensureAutosendAlarm() {
  const alarm = await chrome.alarms.get(AUTOSEND_ALARM);
  if (!alarm) await chrome.alarms.create(AUTOSEND_ALARM, { delayInMinutes: 2, periodInMinutes: 5 });
}
ensureAutosendAlarm().catch((e) => console.error('创建自动发送任务失败', e));

// 登录态托管：首次手动同步即视为授权自动续期，之后每 12 小时检查一次
const COLLECTOR_SYNC_ALARM = 'aliCollectorSyncAuto';
const COLLECTOR_META_KEY = 'aliCollectorSyncMeta';
// 阿里登录态特征 cookie：至少命中一个才算有登录痕迹（t 等通用 cookie 不算）
const LOGIN_COOKIE_NAMES = ['cookie2', '_m_h5_tk', '_m_h5_tk_enc', 'xlly_s', '__cn_logon__'];

async function ensureCollectorSyncAlarm() {
  const alarm = await chrome.alarms.get(COLLECTOR_SYNC_ALARM);
  if (!alarm) await chrome.alarms.create(COLLECTOR_SYNC_ALARM, { delayInMinutes: 5, periodInMinutes: 720 });
}
ensureCollectorSyncAlarm().catch((e) => console.error('创建登录态续期任务失败', e));

async function syncCollectorCookies(options) {
  const opts = options || {};
  const cfg = (await chrome.storage.local.get('aliCloudConfig')).aliCloudConfig;
  if (!cfg || !cfg.baseUrl || !cfg.token) return { ok: false, error: '还没登录云端' };
  const prev = (await chrome.storage.local.get(COLLECTOR_META_KEY))[COLLECTOR_META_KEY] || {};
  const auto = opts.enableAuto === undefined ? prev.auto !== false : !!opts.enableAuto;
  const cookies = await chrome.cookies.getAll({ domain: '.alibaba.com' });
  const sign = (cookies || []).filter((c) => LOGIN_COOKIE_NAMES.indexOf(c.name) >= 0 && c.value);
  if (!sign.length) {
    const info = Object.assign({}, prev, {
      at: Date.now(), auto: auto, lastError: '当前浏览器没有有效的阿里登录态（请先登录阿里国际站）',
    });
    await chrome.storage.local.set({ [COLLECTOR_META_KEY]: info }).catch(() => {});
    return { ok: false, error: info.lastError, auto: auto };
  }
  // 只比对登录相关 cookie，避免普通 cookie 变化导致无意义上传
  const fp = self.AliCloudOutbox && self.AliCloudOutbox.hash64
    ? self.AliCloudOutbox.hash64(sign.map((c) => c.name + '=' + String(c.value).slice(0, 64)).join('\u0001'))
    : String(sign.length);
  if (!opts.force && auto && prev.fingerprint === fp) {
    return { ok: true, skipped: 'unchanged', count: cookies.length, auto: auto };
  }
  const res = await fetch(String(cfg.baseUrl).replace(/\/+$/, '') + '/api/collector/cookies', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.token },
    body: JSON.stringify({ cookies: cookies }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const info = Object.assign({}, prev, { at: Date.now(), auto: auto, lastError: data.message || ('HTTP ' + res.status) });
    await chrome.storage.local.set({ [COLLECTOR_META_KEY]: info }).catch(() => {});
    return { ok: false, error: info.lastError, status: res.status, auto: auto };
  }
  const info = {
    fingerprint: fp, at: Date.now(), count: data.count,
    auto: auto, lastError: '',
  };
  await chrome.storage.local.set({ [COLLECTOR_META_KEY]: info });
  return { ok: true, count: data.count, auto: auto };
}

// 自动续期：仅在用户至少手动同步过一次、且没有关闭自动续期时执行
async function autoSyncCollector() {
  const meta = (await chrome.storage.local.get(COLLECTOR_META_KEY))[COLLECTOR_META_KEY];
  if (!meta || !meta.at || meta.auto === false) return;
  await syncCollectorCookies({ force: false });
}

// 投流诊断：每天 08:30 检查一次，数据超过 20 小时未更新才自动采集（首次使用前不打扰）
const ADS_ALARM = 'aliAdsDailySync';
async function ensureAdsAlarm() {
  const alarm = await chrome.alarms.get(ADS_ALARM);
  if (alarm) return;
  const now = new Date();
  const next = new Date(now);
  next.setHours(8, 30, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  await chrome.alarms.create(ADS_ALARM, { when: next.getTime(), periodInMinutes: 1440 });
}
async function runAdsDailySync() {
  const saved = await chrome.storage.local.get('aliAdsInsightSnapshot');
  const snap = saved && saved.aliAdsInsightSnapshot;
  if (!snap || !snap.raw) return;
  const at = Number(snap.meta && snap.meta.updatedAt || 0);
  if (Date.now() - at < 20 * 60 * 60 * 1000) return;
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') + '?adsAuto=1', active: false });
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
}
ensureAdsAlarm().catch((e) => console.error('创建投流每日同步任务失败', e));

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  (async () => {
    let name = '';
    try {
      const o = await chrome.storage.session.get(PENDING_NAME_KEY);
      name = (o && o[PENDING_NAME_KEY]) || '';
    } catch (e) { /* ignore */ }
    if (!name) { suggest(); return; } // 没有待办：按默认命名
    try { await chrome.storage.session.remove(PENDING_NAME_KEY); } catch (e) { /* ignore */ }
    console.log('[bg] onDeterminingFilename', item.filename, '->', name);
    suggest({ filename: name, conflictAction: 'uniquify' });
  })();
  return true; // 异步响应
});

// 主世界下载函数（在页面上下文执行；blob 归页面所有）
// 注意：部分页面会吞掉 <a download> 的名字，最终文件名由上面的改名监听兜住。
function pageDownload(data, name, type) {
  try {
    // 不透明源（sandbox 页面）无法用 <a download>，直接报错
    if (self.origin === 'null' || self.origin === '') return 'err:opaque-origin';
    const blob = new Blob([new Uint8Array(data)], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    // cancelable:false —— 页面若有全局 click 拦截(preventDefault)也不影响下载，同时避免被误判为失败
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: false, view: window }));
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
    return 'ok';
  } catch (e) { return 'err:' + (e && e.message); }
}

// AI 流式对话：content script 用长连接 Port，逐段把模型输出推回去
// （不能用 sendMessage —— 那是一次性的；且内容脚本直连模型会撞 CORS / 私网限制）
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'aiStream') return;
  const ctrl = new AbortController();
  let closed = false;
  const put = (m) => { if (!closed) { try { port.postMessage(m); } catch (e) { /* 端口已断 */ } } };
  port.onDisconnect.addListener(() => { closed = true; try { ctrl.abort(); } catch (e) { /* ignore */ } });
  port.onMessage.addListener(async (msg) => {
    if (!msg) return;
    if (msg.type === 'ping') { put({ type: 'pong' }); return; }
    if (msg.type === 'abort') { try { ctrl.abort(); } catch (e) { /* ignore */ } return; }
    if (msg.type !== 'aiStream') return;
    try {
      await self.AliSSE.streamChat(fetch, msg.url, msg.headers, msg.body, (d) => put({ type: 'delta', text: d }), ctrl.signal);
      put({ type: 'done' });
    } catch (e) {
      put({ type: 'error', error: (e && e.name === 'AbortError') ? '已停止' : String((e && e.message) || e) });
    }
  });
});

// Dify 智能客服流式对话：与 aiStream 相同的长连接模式，但走 Dify /chat-messages。
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'difyStream') return;
  const ctrl = new AbortController();
  let closed = false;
  const put = (m) => { if (!closed) { try { port.postMessage(m); } catch (e) { /* 端口已断 */ } } };
  port.onDisconnect.addListener(() => { closed = true; try { ctrl.abort(); } catch (e) { /* ignore */ } });
  port.onMessage.addListener(async (msg) => {
    if (!msg) return;
    if (msg.type === 'ping') { put({ type: 'pong' }); return; }
    if (msg.type === 'abort') { try { ctrl.abort(); } catch (e) { /* ignore */ } return; }
    if (msg.type !== 'difyStream') return;
    try {
      await self.AliDify.streamChat(fetch,
        { url: msg.url, headers: msg.headers, body: msg.body },
        (event) => put(Object.assign({ type: 'difyEvent' }, event)),
        ctrl.signal);
      put({ type: 'done' });
    } catch (e) {
      put({ type: 'error', error: (e && e.name === 'AbortError') ? '已停止' : String((e && e.message) || e) });
    }
  });
});

// ---- 临时诊断：抓取页面自身的「发送消息」请求（MAIN world）----
// 只在用户点「抓取发送接口」时安装；抓到后由页面侧按钮移除，不长期驻留。
function installSendProbe(marker) {
  if (window.__ALI_SEND_PROBE__) return 'already';
  const hits = (window.__ALI_SEND_PROBE__ = []);   // 命中标记的请求（可回放）
  const last = (window.__ALI_SEND_PROBE_LAST__ = []); // 最近非 GET 请求（仅诊断）
  window.__ALI_SEND_PROBE_ORIG__ = {
    fetch: window.fetch,
    open: XMLHttpRequest.prototype.open,
    send: XMLHttpRequest.prototype.send,
    ws: WebSocket.prototype.send,
    beacon: navigator.sendBeacon,
  };
  const hasMark = (s) => {
    const t = String(s || '');
    if (!marker) return false;
    if (t.indexOf(marker) >= 0) return true;
    try { return decodeURIComponent(t).indexOf(marker) >= 0; } catch (e) { return false; }
  };
  const push = (o) => {
    o.frame = String(location.href || '').slice(0, 200);
    o.ts = Date.now();
    if (last.length >= 12) last.shift();
    last.push({ via: o.via, url: String(o.url || '').slice(0, 200), method: o.method, len: String(o.body || '').length });
    if (marker && hasMark(o.body)) {
      if (hits.length >= 20) hits.shift();
      hits.push(o);
    }
  };
  // 不再按 URL 关键词过滤：所有非 GET 都看一眼，靠标记定位
  const of = window.fetch;
  window.fetch = function (input, init) {
    try {
      const u = typeof input === 'string' ? input : ((input && input.url) || '');
      const m = ((init && init.method) || 'GET').toUpperCase();
      if (m !== 'GET') {
        push({ via: 'fetch', url: String(u).slice(0, 500), method: m,
          headers: Object.assign({}, (init && init.headers) || {}),
          body: String((init && init.body) || '').slice(0, 8000) });
      }
    } catch (e) { /* ignore */ }
    return of.apply(this, arguments);
  };
  const oo = XMLHttpRequest.prototype.open;
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__aliProbe = { m: String(m || '').toUpperCase(), u: String(u || '') }; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    try {
      const p = this.__aliProbe;
      if (p && p.m !== 'GET') {
        push({ via: 'xhr', url: p.u.slice(0, 500), method: p.m, headers: {}, body: String(b || '').slice(0, 8000) });
      }
    } catch (e) { /* ignore */ }
    return os.apply(this, arguments);
  };
  const ows = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    try {
      let s = '';
      if (typeof d === 'string') s = d;
      else if (d && d instanceof ArrayBuffer) s = new TextDecoder('utf-8').decode(new Uint8Array(d));
      else if (typeof Blob !== 'undefined' && d instanceof Blob) s = '(blob)';
      if (s) push({ via: 'ws', url: String(this.url || '').slice(0, 300), method: 'WS', headers: {}, body: s.slice(0, 8000) });
    } catch (e) { /* ignore */ }
    return ows.apply(this, arguments);
  };
  if (navigator.sendBeacon) {
    const ob = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (u, d) {
      try { push({ via: 'beacon', url: String(u || '').slice(0, 500), method: 'POST', headers: {}, body: String(d || '').slice(0, 8000) }); } catch (e) { /* ignore */ }
      return ob(u, d);
    };
  }
  return 'installed';
}
function readSendProbe() {
  const out = {
    hits: window.__ALI_SEND_PROBE__ || [],
    last: window.__ALI_SEND_PROBE_LAST__ || [],
    frame: String(location.href || '').slice(0, 200),
  };
  const o = window.__ALI_SEND_PROBE_ORIG__;
  if (o) {
    try { window.fetch = o.fetch; } catch (e) { /* ignore */ }
    try { XMLHttpRequest.prototype.open = o.open; XMLHttpRequest.prototype.send = o.send; } catch (e) { /* ignore */ }
    try { WebSocket.prototype.send = o.ws; } catch (e) { /* ignore */ }
    try { if (o.beacon) navigator.sendBeacon = o.beacon; } catch (e) { /* ignore */ }
  }
  window.__ALI_SEND_PROBE__ = null;
  window.__ALI_SEND_PROBE_LAST__ = null;
  window.__ALI_SEND_PROBE_ORIG__ = null;
  return out;
}

// 读 .alibaba.com 下全部 cookie（含 HttpOnly）
// 同时枚举 url + domain + 全量过滤，避免 host-only cookie（未设 Domain 属性）漏读
async function readAlibabaCookie() {
  const out = [];
  const seen = new Set();
  const add = (list) => (list || []).forEach((c) => {
    if (!c || !c.name || seen.has(c.name)) return;
    seen.add(c.name);
    out.push(c.name + '=' + c.value);
  });
  try {
    add(await chrome.cookies.getAll({ url: 'https://message.alibaba.com/message/default.htm' }));
    add(await chrome.cookies.getAll({ domain: 'alibaba.com' }));
    const all = await chrome.cookies.getAll({});
    add(all.filter((c) => /(^|\.)alibaba\.com$/i.test(String(c.domain || ''))));
  } catch (e) { console.log('[bg] read cookie failed', e && e.message); }
  return out.join('; ');
}
function cookieOf(cookie, name) {
  const m = String(cookie || '').match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return m ? m[1] : '';
}
// ctoken 往往不是独立 cookie，而是嵌在 xman_us_t 等值里，且可能是 URL 编码的（甚至双重编码）
function findCtoken(cookie) {
  const raw = String(cookie || '');
  const layers = [raw];
  let cur = raw;
  for (let i = 0; i < 2; i++) {
    let next = cur;
    try { next = decodeURIComponent(cur); } catch (e) { break; }
    if (next === cur) break;
    layers.push(next);
    cur = next;
  }
  // 兼容 ctoken=xxx / "ctoken":"xxx" / ctoken:xxx，以及 URL 编码与双重编码
  const pats = [
    /(?:^|;\s*)ctoken=([^&;\s]+)/i,
    /[?&]ctoken=([^&;\s]+)/i,
    /ctoken["']?\s*[:=]\s*["']?([A-Za-z0-9_\-%\.]+)/i,
  ];
  for (const s of layers) {
    for (const p of pats) {
      const m = s.match(p);
      if (m && m[1]) {
        let v = m[1].trim();
        try { v = decodeURIComponent(v); } catch (e) { /* 保留原值 */ }
        if (v) return v;
      }
    }
  }
  return '';
}
function cookieNames(cookie) {
  return String(cookie || '').split(/;\s*/).map((p) => p.split('=')[0]).filter(Boolean).slice(0, 40);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // 扩展内「版本更新」：检查云端版本 / 调本地更新服务 / 更新后重载
  if (msg.type === 'extensionUpdateCheck') {
    extensionUpdateCheck()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'extensionUpdateApply') {
    extensionUpdateApply()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'extensionUpdateReload') {
    sendResponse({ ok: true });
    setTimeout(() => { try { chrome.runtime.reload(); } catch (e) { /* ignore */ } }, 400);
    return false;
  }

  // 临时诊断：在页面主世界安装/读取发送请求探针（覆盖所有 frame）
  if (msg.type === 'sendProbeInstall' || msg.type === 'sendProbeRead') {
    (async () => {
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) { sendResponse({ ok: false, error: '无 tabId（请在聊天页操作）' }); return; }
      try {
        const install = msg.type === 'sendProbeInstall';
        const args = install ? [msg.marker || ''] : [];
        const func = install ? installSendProbe : readSendProbe;
        let r;
        try {
          r = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func, args });
        } catch (e) {
          r = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
        }
        sendResponse({ ok: true, result: (r || []).map((x) => x && x.result) });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // 登录态回填：读 cookie → 组装询盘请求 → 推给本地常驻进程（127.0.0.1:39271）
  // 必须在这里做：chrome.cookies 只在扩展上下文可用，内容脚本拿不到 HttpOnly cookie
  if (msg.type === 'bridgeSync') {
    (async () => {
      try {
        const cookie = await readAlibabaCookie();
        if (!cookie) { sendResponse({ ok: false, error: '读不到 alibaba cookie：请在浏览器登录国际站' }); return; }
        const ctoken = findCtoken(cookie) || String(msg.ctokenFallback || '');
        const tb = cookieOf(cookie, '_tb_token_') || String(msg.tbFallback || '');
        const xsrf = cookieOf(cookie, 'XSRF-TOKEN');
        if (!tb) { sendResponse({ ok: false, error: 'cookie 里没有 _tb_token_：请先登录国际站' }); return; }

        // ctoken 可能有多个来源，逐个试，哪个能拉到数据就用哪个
        const cands = [];
        const push = (v) => {
          const s = String(v || '').trim();
          if (s && cands.indexOf(s) < 0) cands.push(s);
        };
        const xman = cookieOf(cookie, 'xman_us_t');
        if (xman) { try { push(findCtoken(decodeURIComponent(xman))); } catch (e) { push(findCtoken(xman)); } }
        push(cookieOf(cookie, 'ctoken'));
        push(msg.ctokenFallback);
        push(ctoken);
        if (!cands.length) {
          const names = cookieNames(cookie).join(',');
          console.log('[bg] ctoken 未找到，现有 cookie：', names, 'page=', msg.pageUrl);
          sendResponse({
            ok: false,
            error: 'cookie 里没有 ctoken（读到 ' + cookieNames(cookie).length + ' 个 cookie）。'
              + '当前页面：' + String(msg.pageUrl || '-').slice(0, 80) + '；字段：' + names.slice(0, 240),
          });
          return;
        }

        // 兜底：_tb_token_ 可能来自页面 document.cookie 而没进 Cookie 串，补进去
        let cookieHeader = cookie;
        if (!/(?:^|;\s*)_tb_token_=/.test(cookieHeader)) cookieHeader += '; _tb_token_=' + tb;
        if (xsrf && !/(?:^|;\s*)XSRF-TOKEN=/.test(cookieHeader)) cookieHeader += '; XSRF-TOKEN=' + xsrf;

        const pageSize = 20;
        const params = {
          system: 'feedback', listType: 'all', pageSize,
          pagination: { nextPage: 1, pageSize },
          filter: { isShowAtm: false },
          order: { order: 'desc', orderBy: 'latest_contact_time' },
          search: {},
        };
        const url = 'https://message.alibaba.com/message/ajax/feedback/subjectList.htm?'
          + new URLSearchParams({ ctoken: cands[0], _tb_token_: tb }).toString();
        const body = new URLSearchParams({
          _csrf_token_: xsrf || '', postId: '', params: JSON.stringify(params),
        }).toString();
        const payload = {
          url, method: 'POST', source: 'extension-sw',
          ctokenCandidates: cands,
          headers: {
            Cookie: cookieHeader,
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'https://message.alibaba.com',
            Referer: 'https://message.alibaba.com/message/default.htm',
            'X-XSRF-TOKEN': xsrf || '',
          },
          body,
        };

        const r = await fetch(msg.url + '/cookie', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const j = await r.json().catch(() => ({}));
        console.log('[bg] bridgeSync', r.status, j);
        sendResponse({ ok: r.ok && !!j.ok, status: r.status, error: (j && j.error) || '', result: j });
      } catch (e) {
        sendResponse({ ok: false, status: 0, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // 查询是否已授权访问外部网站（内容脚本拿不到 chrome.permissions）
  // https / http 任一已授权即可（抓官网默认走 https）
  if (msg.type === 'sitePerm') {
    (async () => {
      try {
        const https = await chrome.permissions.contains({ origins: ['https://*/*'] });
        const http = await chrome.permissions.contains({ origins: ['http://*/*'] });
        sendResponse({ ok: !!(https || http), https: !!https, http: !!http });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // 打开选项页（内容脚本拿不到 chrome.permissions，只能引导到扩展页授权官网抓取）
  if (msg.type === 'openOptions') {
    (async () => {
      try {
        await chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // AI 配置安全读写：AES-GCM 密文存 chrome.storage.local，CryptoKey 存扩展源 IndexedDB
  if (msg.type === 'secureGet' || msg.type === 'secureSet') {
    const allowed = { aliAiCfg: true, aliDifyCfg: true };
    const keyName = String(msg.key || '');
    if (!allowed[keyName]) { sendResponse({ ok: false, error: 'KEY_NOT_ALLOWED' }); return; }
    (async () => {
      try {
        if (msg.type === 'secureSet') {
          const env = await self.AliSecureStore.encryptJson(msg.value === undefined ? {} : msg.value, keyName);
          await chrome.storage.local.set({ [keyName]: env });
          sendResponse({ ok: true, encrypted: true });
          return;
        }
        const stored = await chrome.storage.local.get(keyName);
        const raw = stored && stored[keyName];
        if (raw === undefined || raw === null) { sendResponse({ ok: true, value: null }); return; }
        if (self.AliSecureStore.isEnvelope(raw)) {
          try {
            const value = await self.AliSecureStore.decryptJson(raw, keyName);
            sendResponse({ ok: true, value: value, encrypted: true });
          } catch (e) {
            sendResponse({ ok: false, error: 'DECRYPT_FAILED', message: 'AI 配置无法解密；请重新填写 API Key' });
          }
          return;
        }
        // 旧版明文：首次读取时自动加密迁移
        try {
          const env = await self.AliSecureStore.encryptJson(raw, keyName);
          await chrome.storage.local.set({ [keyName]: env });
          sendResponse({ ok: true, value: raw, migrated: true });
        } catch (e) {
          sendResponse({ ok: false, error: 'ENCRYPT_FAILED', message: String((e && e.message) || e) });
        }
      } catch (e) {
        sendResponse({ ok: false, error: 'SECURE_STORE_FAILED', message: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // 打开数据看板（扩展内置页，无需任何本地服务）
  if (msg.type === 'openDashboard') {
    const view = msg.view === 'library' ? '#library' : '';
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html' + view) });
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'openAiChat') {
    const customer = String(msg.customer || '').trim().slice(0, 200);
    const query = customer ? '?aliChat=' + encodeURIComponent(customer) + '&aliAiFocus=' + encodeURIComponent(customer) : '';
    chrome.tabs.create({ url: 'https://onetalk.alibaba.com/message/weblitePWA.htm' + query }, async (tab) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      if (customer && tab && tab.id) {
        try { await chrome.storage.session.set({ [AI_TAB_FOCUS_PREFIX + tab.id]: customer }); }
        catch (e) { /* URL 参数仍可传递客户 */ }
      }
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'getAiChatFocus') {
    (async () => {
      const key = AI_TAB_FOCUS_PREFIX + (sender.tab && sender.tab.id);
      try {
        const data = await chrome.storage.session.get(key);
        sendResponse({ ok: true, customer: data[key] || '' });
      } catch (e) { sendResponse({ ok: false, customer: '' }); }
    })();
    return true;
  }

  // 白名单自动发送：配置读写、手动跑一轮、读取状态
  if (msg.type === 'autoSendStatus') {
    (async () => {
      try {
        sendResponse({ ok: true, data: await self.AliAutoSend.status() });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.type === 'autoSendSave') {
    (async () => {
      try {
        const cfg = await self.AliAutoSend.saveConfig(msg.config || {});
        sendResponse({ ok: true, config: cfg });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.type === 'autoSendNow') {
    (async () => {
      try {
        sendResponse({ ok: true, result: await self.AliAutoSend.runOnce({ force: !!msg.force }) });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }

  // 云端队列：配置、状态、手动上传、首次把现有资料库补传
  if (msg.type === 'cloudStatus') {
    (async () => {
      try {
        const [s, cfg] = await Promise.all([self.AliCloudOutbox.status(), self.AliCloudOutbox.loadConfig()]);
        sendResponse({ ok: true, status: s, config: cfg });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  // 把当前浏览器的阿里登录态（cookie）托管到云端，供云端采集器使用
  // force=false 时用于自动续期：登录态没变化就跳过，避免重复上传
  if (msg.type === 'collectorSync') {
    (async () => {
      try {
        sendResponse(await syncCollectorCookies({ force: true, enableAuto: true }));
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.type === 'collectorStatus') {
    (async () => {
      try {
        const meta = (await chrome.storage.local.get(COLLECTOR_META_KEY))[COLLECTOR_META_KEY] || null;
        sendResponse({ ok: true, meta: meta });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.type === 'collectorAuto') {
    (async () => {
      try {
        const prev = (await chrome.storage.local.get(COLLECTOR_META_KEY))[COLLECTOR_META_KEY] || {};
        const meta = Object.assign({}, prev, { auto: !!msg.enabled });
        await chrome.storage.local.set({ [COLLECTOR_META_KEY]: meta });
        sendResponse({ ok: true, meta: meta });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.type === 'cloudSave') {
    (async () => {
      try {
        const before = (await chrome.storage.local.get('aliCloudConfig')).aliCloudConfig || {};
        const prevSeller = String(before.sellerId || '').trim();
        const nextSeller = String((msg.config && msg.config.sellerId) || '').trim();
        const cfg = await self.AliCloudOutbox.saveConfig(msg.config);
        const sellerChanged = Boolean(prevSeller && nextSeller && prevSeller !== nextSeller);
        if (sellerChanged) {
          // 切换店铺时清空旧队列并重置登录态指纹，避免主账号数据或旧 cookies 被带到子账号仓库
          await chrome.storage.local.set({ aliCloudOutbox: [] });
          await chrome.storage.local.remove(COLLECTOR_META_KEY);
        }
        sendResponse({ ok: true, config: cfg, sellerChanged: sellerChanged, previousSeller: prevSeller });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.type === 'cloudDrain') {
    (async () => {
      try {
        const r = await self.AliCloudOutbox.drain({ force: true });
        sendResponse({ ok: true, result: r });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.type === 'cloudBackfill') {
    (async () => {
      try {
        const kinds = ['inquiry', 'chat', 'customer', 'public_customer', 'order', 'visitor'];
        const data = await self.AliDB.localDataset(kinds);
        let items = 0;
        let rows = 0;
        for (const kind of kinds) {
          const list = data[kind] || [];
          if (!list.length) continue;
          const r = await self.AliCloudOutbox.enqueue({ kind: kind, name: 'backfill_' + kind, rows: list }, { force: true });
          if (r && r.ok) { items += r.items; rows += list.length; }
          // 逐类上传：避免全量聊天（2 万+）把队列撑到上限而丢掉其它类型
          await self.AliCloudOutbox.drain({ force: true });
        }
        const drained = await self.AliCloudOutbox.drain({ force: true });
        sendResponse({ ok: true, items: items, rows: rows, result: drained });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }

  // 导出成功后把数据写入 IndexedDB（content script 在页面源下，写不到扩展的库，所以走后台）
  if (msg.type === 'ingest') {
    (async () => {
      try {
        if (msg.file && msg.file.source === 'platform-auto') {
          const workspace = await self.AliDB.activeWorkspace();
          const state = await self.AliSyncState.load(chrome.storage.local, workspace);
          const lock = (await chrome.storage.local.get('aliPlatformSyncLock')).aliPlatformSyncLock;
          const mismatch = self.AliSyncState.autoWriteError(msg.file, workspace, state, lock);
          if (mismatch) throw new Error(mismatch);
          const identity = await chrome.tabs.sendMessage(lock.probeTabId, { type: 'platformAccountProbe' });
          const identityMismatch = self.AliSyncState.autoWriteError(msg.file, workspace, state, lock, identity);
          if (identityMismatch) throw new Error(identityMismatch);
        }
        const r = await self.AliDB.ingest(msg.file);
        if (r && r.ok && !r.skipped) {
          await chrome.storage.local.set({ aliDataChangedAt: Date.now() });
          // 入库成功后进入云端队列；上传失败会留在本机等下次续传
          if (self.AliCloudOutbox) {
            try {
              const q = await self.AliCloudOutbox.enqueue(msg.file);
              if (q && q.ok) self.AliCloudOutbox.drain().catch((e) => console.error('云端上传失败', e));
            } catch (e) { console.error('写入云端队列失败', e); }
          }
        }
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // AI 跟进名单只读取员工已导入的本地资料，不为筛选名单访问平台接口。
  if (msg.type === 'localFollowupData') {
    (async () => {
      try {
        const data = await self.AliDB.dataset(['inquiry', 'customer', 'public_customer', 'order']);
        data.stages = await self.AliDB.stageMap();
        sendResponse({ ok: true, data });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.type === 'localChatData') {
    (async () => {
      try {
        const data = await self.AliDB.dataset(['chat']);
        const begin = String(msg.startDate || '').slice(0, 10);
        const finish = String(msg.endDate || '').slice(0, 10);
        const rows = (data.chat || []).filter((m) => {
          const day = String(m['发送时间'] || '').slice(0, 10);
          return (!begin || day >= begin) && (!finish || day <= finish);
        }).map((m) => [m['发送时间'], m['角色'], m['发言人'], m['内容'], m['会话']]);
        sendResponse({ ok: true, rows });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.type === 'localBootstrapSnapshot') {
    (async () => {
      try {
        const r = await fetch('http://127.0.0.1:39272/bootstrap/snapshot', { method: 'POST' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || '本机历史库不可用，请启动新版 MCP 服务');
        sendResponse(j);
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }

  // 订单关联询盘：只用本地已入库询盘建索引，按客户名/公司名弱匹配，不发起任何平台请求
  if (msg.type === 'inquiryIndex') {
    (async () => {
      try {
        const data = await self.AliDB.dataset(['inquiry', 'customer', 'public_customer']);
        const index = self.AliOrderMatch
          ? self.AliOrderMatch.buildIndex(data)
          : { inquiries: [], customers: [] };
        sendResponse({ ok: true, inquiries: index.inquiries, customers: index.customers });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }

  // 展会通知：只读客户/公海/询盘，按国家筛选；不读取、不分析聊天记录
  if (msg.type === 'expoCustomers') {
    (async () => {
      try {
        const data = await self.AliDB.dataset(['inquiry', 'customer', 'public_customer']);
        const result = self.AliAnalyze.exhibition(data, String(msg.country || ''), {
          mineOnly: !!msg.mineOnly,
          hotOnly: !!msg.hotOnly,
          contactOnly: !!msg.contactOnly,
          countriesOnly: !!msg.countriesOnly,
          limit: 0,
        });
        sendResponse({ ok: true, result });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }

  // 客户分层索引：用已入库的「我的客户 / 公海客户」建 公司名称/联系人 → L0~L4
  // 同一来源内同名不同级 → 置空（宁可不填，不填错）；「我的客户」优先，公海只补空缺
  if (msg.type === 'crmLevelLookup') {
    (async () => {
      try {
        const data = await self.AliDB.dataset(['customer', 'public_customer']);
        const norm = (v) => String(v === undefined || v === null ? '' : v).toLowerCase()
          .replace(/[\s\u3000]+/g, '').replace(/[.,，。()（）"'&·-]/g, '').trim();
        const isL = (v) => /^L[0-4]$/i.test(String(v || '').trim());
        const map = new Map();
        const conflict = new Set();
        const put = (k, l, strict) => {
          const key = norm(k);
          if (!key) return;
          if (!map.has(key)) { map.set(key, l); return; }
          if (strict && map.get(key) !== l) conflict.add(key);
        };
        const mine = data.customer || [];
        const pub = data.public_customer || [];
        mine.forEach((c) => {
          const l = String(c['买家等级'] || '').trim().toUpperCase();
          if (!isL(l)) return;
          put(c['公司名称'], l, true);
          put(c['联系人'], l, true);
        });
        pub.forEach((c) => {
          const l = String(c['买家等级'] || '').trim().toUpperCase();
          if (!isL(l)) return;
          put(c['公司名称'], l, false);
          put(c['联系人'], l, false);
        });
        conflict.forEach((k) => map.set(k, ''));
        sendResponse({ ok: true, entries: Array.from(map.entries()), customers: mine.length + pub.length });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // 客户订单索引：公司名称/联系人 → { orders, follow, level }
  // 用于「未转化客户跟进」把已成交（订单数>0）客户排除掉；我的客户优先，公海只补空缺
  if (msg.type === 'crmOrderIndex') {
    (async () => {
      try {
        const data = await self.AliDB.dataset(['customer', 'public_customer']);
        const norm = (v) => String(v === undefined || v === null ? '' : v).toLowerCase()
          .replace(/[\s\u3000]+/g, '').replace(/[.,，。()（）"'&·-]/g, '').trim();
        const num = (v) => {
          const n = Number(String(v === undefined || v === null ? '' : v).replace(/[^0-9.\-]/g, ''));
          return isNaN(n) ? 0 : n;
        };
        const recOf = (c) => ({ orders: num(c['订单数']), follow: String(c['跟进状态'] || ''), level: String(c['买家等级'] || '') });
        const map = new Map();
        const put = (k, rec, overwrite) => {
          const key = norm(k);
          if (!key) return;
          if (!overwrite && map.has(key)) return;
          map.set(key, rec);
        };
        (data.customer || []).forEach((c) => {
          const rec = recOf(c);
          put(c['公司名称'], rec, true);
          put(c['联系人'], rec, true);
        });
        (data.public_customer || []).forEach((c) => {
          const rec = recOf(c);
          put(c['公司名称'], rec, false);
          put(c['联系人'], rec, false);
        });
        sendResponse({ ok: true, entries: Array.from(map.entries()), customers: (data.customer || []).length + (data.public_customer || []).length });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // 公司知识库：从已入库的导出数据聚合「事实型」摘要（产品词、国家、常见问题等）
  if (msg.type === 'companyKB') {
    (async () => {
      try {
        const data = await self.AliDB.dataset(['inquiry', 'customer', 'public_customer', 'chat', 'visitor', 'order']);
        const txt = (v) => String(v === undefined || v === null ? '' : v).trim();
        const num = (v) => { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
        const add = (m, k) => { const s = txt(k); if (!s || s === '-' || s === 'NA' || s === 'N/A') return; m.set(s, (m.get(s) || 0) + 1); };
        const top = (m, n) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => k + '(' + v + ')');

        const inv = data.inquiry || [];
        const products = new Map(), subjects = new Map(), countries = new Map(), levels = new Map();
        inv.forEach((r) => {
          add(products, r['咨询产品']); add(subjects, r['询盘主题']);
          add(countries, r['国家']); add(levels, r['买家等级']);
        });

        const mine = data.customer || [], pub = data.public_customer || [];
        const cats = new Map(), types = new Map(), custCountries = new Map();
        let won = 0;
        mine.forEach((c) => {
          if (num(c['订单数']) > 0) won++;
          add(cats, c['采购类目']); add(types, c['经营类型']); add(custCountries, c['国家/地区']);
        });

        const chats = data.chat || [];
        const sessions = new Set(chats.map((r) => txt(r['会话'])).filter(Boolean)).size;
        const terms = new Map();
        const asks = { price: 0, shipping: 0, moq: 0, sample: 0, oem: 0, cert: 0 };
        chats.forEach((r) => {
          const c = txt(r['内容']);
          if (!c) return;
          if (/price|how much|cost|报价|价格|precio|cu[aá]nto|цена|سعر/i.test(c)) asks.price++;
          if (/shipping|freight|delivery|运费|env[ií]o|доставка|شحن/i.test(c)) asks.shipping++;
          if (/moq|minimum order|起订|минимальн|الحد الأدنى/i.test(c)) asks.moq++;
          if (/sample|样品|образец|عينة/i.test(c)) asks.sample++;
          if (/oem|odm|贴牌|private label/i.test(c)) asks.oem++;
          if (/certificate|certification|\biso\b|\bce\b|sfda|认证|сертификат|شهادة/i.test(c)) asks.cert++;
          (c.match(/[A-Za-z][A-Za-z0-9 \-]{2,24}(resin|printer|sheet|aligner|denture|resina|смол[аы])/gi) || [])
            .forEach((x) => { const k = x.toLowerCase().trim(); if (k.length > 6) add(terms, k); });
        });

        const vis = data.visitor || [];
        const words = new Map();
        vis.forEach((r) => add(words, r['搜索关键词']));

        const lines = ['【已导出数据摘要（自动生成，' + new Date().toLocaleString('zh-CN') + '）】'];
        lines.push('询盘 ' + inv.length + ' 条；我的客户 ' + mine.length + '（有成交订单 ' + won + '）；公海 ' + pub.length
          + '；聊天 ' + sessions + ' 个会话 / ' + chats.length + ' 条；访客 ' + vis.length + ' 条。');
        // 历史成交对话样例：从「有订单」的客户里挑 2 段，供模型学习公司真实沟通风格与推进节奏
        const norm = (v) => String(v === undefined || v === null ? '' : v).toLowerCase()
          .replace(/[\s\u3000]+/g, '').replace(/[.,，。()（）"'&·-]/g, '').trim();
        const wonKeys = [];
        mine.forEach((c) => {
          if (num(c['订单数']) > 0) {
            [c['公司名称'], c['联系人']].forEach((k) => { const s = norm(k); if (s) wonKeys.push(s); });
          }
        });
        const bySess = new Map();
        chats.forEach((r) => {
          const s = txt(r['会话']);
          if (!s) return;
          if (!bySess.has(s)) bySess.set(s, []);
          bySess.get(s).push(r);
        });
        const samples = [];
        if (wonKeys.length) {
          for (const [name, rows] of bySess) {
            const nk = norm(name);
            const hit = nk && wonKeys.some((k) => k === nk || (k.length >= 4 && nk.indexOf(k) >= 0) || (nk.length >= 4 && k.indexOf(nk) >= 0));
            if (!hit || rows.length < 4) continue;
            samples.push('— 会话「' + name + '」：\n' + rows.slice(-6)
              .map((r) => txt(r['发送时间']) + ' ' + txt(r['角色']) + '：' + txt(r['内容']).slice(0, 100)).join('\n'));
            if (samples.length >= 2) break;
          }
        }
        if (countries.size) lines.push('询盘国家 Top：' + top(countries, 10).join('、'));
        if (products.size) lines.push('咨询产品 Top：' + top(products, 12).join('、'));
        if (subjects.size) lines.push('询盘主题 Top：' + top(subjects, 10).join('、'));
        if (levels.size) lines.push('买家等级分布：' + top(levels, 6).join('、'));
        if (cats.size) lines.push('客户采购类目：' + top(cats, 8).join('、'));
        if (types.size) lines.push('客户经营类型：' + top(types, 8).join('、'));
        if (custCountries.size) lines.push('成交/在管客户国家：' + top(custCountries, 10).join('、'));
        if (terms.size) lines.push('聊天高频产品词：' + top(terms, 12).join('、'));
        const askList = [['价格', asks.price], ['运费', asks.shipping], ['起订量', asks.moq], ['样品', asks.sample], ['OEM', asks.oem], ['认证', asks.cert]]
          .filter((x) => x[1]).map((x) => x[0] + ' ' + x[1]);
        if (askList.length) lines.push('客户高频问题（消息数）：' + askList.join('、'));
        if (words.size) lines.push('访客搜索词 Top：' + top(words, 12).join('、'));
        if (samples.length) lines.push('', '【历史成交对话样例（仅参考沟通风格与推进节奏，勿照抄价格）】\n' + samples.join('\n\n'));
        sendResponse({ ok: true, text: lines.join('\n').slice(0, 3000), sources: { inquiry: inv.length, customer: mine.length, chat: chats.length, visitor: vis.length } });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // 同步已入库数据 + 公司知识库到本地 MCP 服务（127.0.0.1:39272）
  if (msg.type === 'syncToMcp') {
    (async () => {
      const base = 'http://127.0.0.1:39272';
      try {
        try {
          const h = await fetch(base + '/health');
          if (!h.ok) throw new Error('health ' + h.status);
        } catch (e) {
          sendResponse({ ok: false, error: '连不上本地 MCP 服务：先运行 node mcp-server.js --http-only' });
          return;
        }
        const data = await self.AliDB.dataset(['inquiry', 'customer', 'public_customer', 'chat', 'visitor', 'order']);
        const idx = self.AliIdentity ? self.AliIdentity.build(data) : null;
        const stages = await self.AliDB.stageMap();
        const inquiryUid = new Map((data.inquiry || []).filter((r) => r['询盘ID']).map((r) => [String(r['询盘ID']), idx ? idx.uidOfInquiry(r) : '']));
        const clean = (rows) => (rows || []).map((r) => {
          const o = {};
          for (const k of Object.keys(r)) if (!k.startsWith('__')) o[k] = r[k];
          if (r.__mtime__) o['资料时间'] = r.__mtime__;
          if (r.__fields__) o['字段来源'] = r.__fields__;
          return o;
        });
        const enrich = (kind, row) => {
          const stage = kind === 'inquiry' ? stages[String(row['询盘ID'] || '')] : null;
          const base = stage ? Object.assign({}, row, { '机会阶段': stage.stage, '阶段依据': stage.evidence, '阶段时间': stage.at }) : row;
          if (!idx) return base;
          let uid = '';
          if (kind === 'inquiry') uid = idx.uidOfInquiry(base);
          else if (kind === 'customer' || kind === 'public_customer') uid = idx.uidOfCustomer(base);
          else if (kind === 'order') uid = inquiryUid.get(String(base['询盘ID'] || '')) || idx.uidOfCustomer(base);
          else if (kind === 'chat') {
            const p = idx.lookup(base['会话']);
            uid = p ? p.uid : '';
          }
          return uid ? Object.assign({}, base, { '客户身份ID': uid }) : base;
        };
        const jobs = [
          ['inquiry', data.inquiry],
          ['customer', data.customer],
          ['public_customer', data.public_customer],
          ['chat', data.chat],
          ['visitor', data.visitor],
          ['order', data.order],
        ];
        const datasets = jobs.map(([kind, rows]) => ({ kind, rows: clean(rows || []).map((r) => enrich(kind, r)) }));
        const workspace = await self.AliDB.activeWorkspace();
        const batch = await fetch(base + '/sync-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace, datasets }),
        });
        if (batch.status !== 404) {
          const j = await batch.json().catch(() => ({}));
          if (!batch.ok || !j.ok) throw new Error(j.error || '批量同步失败');
          sendResponse({ ok: true, results: j.results || [] });
          return;
        }
        // 兼容尚未升级的本地 MCP 服务；升级后使用单事务批量同步。
        const results = [];
        for (const { kind, rows } of datasets) {
          const res = await fetch(base + '/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind, rows }),
          });
          const j = await res.json().catch(() => ({}));
          results.push({ kind, ok: res.ok && !!j.ok, count: j.count || 0, error: j.error });
        }
        sendResponse({ ok: results.every((r) => r.ok !== false), results });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'download') {
    (async () => {
      const filename = msg.filename || 'export.xlsx';
      const mime = msg.mime || MIME_XLSX;
      const tabId = sender && sender.tab && sender.tab.id;
      const clearName = async () => {
        try {
          const o = await chrome.storage.session.get(PENDING_NAME_KEY);
          if (o && o[PENDING_NAME_KEY] === filename) await chrome.storage.session.remove(PENDING_NAME_KEY);
        } catch (e) { /* ignore */ }
      };

      // 期望文件名持久化入队：下载事件触发时由 onDeterminingFilename 盖回下载名
      try { await chrome.storage.session.set({ [PENDING_NAME_KEY]: filename }); } catch (e) { /* ignore */ }

      if (tabId == null || !chrome.scripting) {
        await clearName();
        sendResponse({ ok: false, name: filename, error: 'page:无 tabId 或无 scripting' });
        return;
      }
      try {
        const r = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN', func: pageDownload, args: [msg.data, filename, mime],
        });
        const res = r && r[0] && r[0].result;
        console.log('[bg] MAIN-world download:', res);
        if (res === 'ok') { sendResponse({ ok: true, via: 'page', name: filename }); return; }
        await clearName();
        sendResponse({ ok: false, name: filename, error: String(res) });
      } catch (e) {
        await clearName();
        sendResponse({ ok: false, name: filename, error: 'page:' + (e && e.message) });
      }
    })();
    return true;
  }

  // AI 模型代理：由 service worker 发起（扩展上下文 + host 权限可绕过 CORS）
  if (msg.type === 'aiChat') {
    (async () => {
      try {
        const r = await fetch(msg.url, {
          method: msg.method || 'POST',
          headers: msg.headers || {},
          body: msg.body,
          signal: AbortSignal.timeout(300000),
        });
        const text = await r.text();
        sendResponse({ ok: r.ok, status: r.status, text });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // Dify 连接测试：阻塞模式，返回答案或可读错误。
  if (msg.type === 'difyTest') {
    (async () => {
      try {
        const result = await self.AliDify.chatOnce(fetch,
          { baseUrl: msg.baseUrl, apiKey: msg.apiKey }, '只回复：你好', msg.inputs || {});
        sendResponse({ ok: true, answer: result.answer, conversationId: result.conversationId });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // 代理请求
  if (msg.type === 'proxyFetch') {
    (async () => {
      try {
        const r = await fetch(msg.url, {
          method: msg.method || 'GET',
          headers: msg.headers || {},
          body: msg.body,
          credentials: 'include',
        });
        const text = await r.text();
        sendResponse({ ok: r.ok, status: r.status, text });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
});
