// 数据看板（扩展内置页）：数据来自 IndexedDB，AI 复用扩展里配置的模型
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const A = self.AliAnalyze;
  const DB = self.AliDB;
  const AI_KEY = 'aliAiCfg';
  const DIFY_KEY = 'aliDifyCfg';
  const AI_PRESETS = [
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'qwen', label: '通义千问（阿里）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'glm', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  ];
  const NAV = [
    ['home', '今日待办'], ['inbox', '智能客服'], ['inquiry', '询盘线索'], ['customers', '客户资产'], ['expo', '展会通知'],
    ['overview', '经营总览'], ['shadow', '智能客服试运行'], ['identity', '客户归并'], ['demand', '需求词库'], ['ads', '投流诊断'], ['library', '资料库'], ['report', '复盘报表'], ['settings', '设置'],
  ];
  const NAV_GROUPS = [
    ['日常工作', ['home', 'inbox', 'inquiry', 'customers', 'expo']],
    ['分析与复盘', ['overview', 'shadow', 'demand', 'ads', 'report', 'identity']],
    ['数据与配置', ['library', 'settings']],
  ];
  const KINDS = DB.KINDS;
  const ID = self.AliIdentity;
  const CP = self.AliCustomerProfile;
  const CORE = self.AliDataCore;
  const DAI = self.AliDashboardAI;
  const SHADOW = self.AliUnattendedShadow;
  const INBOX = self.AliInquiryReply;
  const SYNC = self.AliSyncState;
  const WORKSPACE_LIST_KEY = 'aliWorkspaces';
  const WORKSPACE_ACTIVE_KEY = 'aliActiveWorkspace';
  const TODO_STATE_KEY = 'aliTodoState:';
  const TODO_RETURN_KEY = 'aliTodoReturnCheck';
  const PROGRESS_KEY = 'aliPlatformSyncProgress';
  const SHADOW_REVIEW_PREFIX = 'aliShadowReview:';
  const SHADOW_RECORD_PREFIX = 'aliShadowRecordV2:';
  const SHADOW_REVIEWER_KEY = 'aliShadowReviewer:';
  const INBOX_RECORD_PREFIX = 'aliInboxRecords:';
  const INBOX_FACTS_PREFIX = 'aliInboxFacts:';
  const INBOX_TEST_PREFIX = 'aliInboxTest:';
  const INBOX_PROBE_KEY = 'aliInboxProbe';
  const INBOX_PROBE_RESULT_KEY = 'aliInboxProbeResult';
  const INBOX_AUTOTEST_KEY = 'aliInboxAutoTest';
  const INBOX_AUTOTEST_RESULT_KEY = 'aliInboxAutoTestResult';
  const SMART_REPLY_KEY = 'aliSmartReply';
  const SMART_REPLY_RESULT_KEY = 'aliSmartReplyResult';
  const runnerParams = new URL(location.href).searchParams;
  const RUNNER_MODE = runnerParams.get('platformRunner') === '1';
  const RUNNER_ID = runnerParams.get('runId') || '';
  const loadTodoState = (workspace) => { try { return JSON.parse(localStorage.getItem(TODO_STATE_KEY + workspace) || '{}'); } catch (e) { return {}; } };
  const saveTodoState = (workspace, state) => localStorage.setItem(TODO_STATE_KEY + workspace, JSON.stringify(state));
  const todoId = (t) => t.tag + '::' + (t.key || t.title);
  const todoVersion = (t) => JSON.stringify([t.title, t.detail, t.ai && t.ai.interaction,
    t.ai && t.ai.behavior, t.ai && t.ai.value, t.ai && t.ai.background]);
  let cur = 'home';
  let CACHE = null;                       // 当前数据集（分析用）
  let CACHE_PENDING = null;
  let HOME_CACHE = null;
  let HOME_PENDING = null;
  let HOME_RESULT = null;
  let cacheVersion = 0;
  const AI_SESSIONS = new Map();
  let syncRunning = false;
  let syncKind = '';
  let syncStatus = null;
  let syncMessage = '';
  let syncCompleted = 0;
  let syncTotal = 0;
  let lastProgress = null;
  let activeWorkspaceId = '';
  let progressWrite = Promise.resolve();
  let libraryRefreshTimer = null;
  let shadowStream = null;
  let inboxStream = null;
  let inboxTimer = null;
  const charts = {};
  const EXPO_DEFAULT_TEMPLATE = 'Hi {name},\n\nWe will be exhibiting at {exhibition} on {date} at {venue}, booth {booth}. We would be glad to meet you and show our latest products.\n\nBest regards,\n{sender}';
  let EXPO_STATE = {
    country: '', mineOnly: false, hotOnly: false, contactOnly: false,
    exhibition: '', date: '', venue: '', booth: '', sender: '',
    template: EXPO_DEFAULT_TEMPLATE,
  };
  let EXPO_RESULT = null;
  let EXPO_DATA = null;
  let EXPO_INDEX = null;

  function renderProgress(state) {
    lastProgress = state || null;
    const banner = $('#platform-sync-banner');
    if (!banner) return;
    if (state && activeWorkspaceId && state.workspace !== activeWorkspaceId) {
      banner.hidden = true;
      return;
    }
    banner.hidden = !state || !!state.dismissed;
    if (banner.hidden) return;
    banner.classList.toggle('is-error', state.status === 'error');
    banner.classList.toggle('is-done', state.status === 'done');
    const percent = Math.max(0, Math.min(100, Number(state.percent) || 0));
    $('#platform-sync-title').textContent = state.status === 'done' ? '平台数据更新完成'
      : state.status === 'error' ? '平台数据更新暂停' : '平台数据更新中 · ' + (state.completed || 0) + '/' + (state.total || '?') + ' 项';
    $('#platform-sync-percent').textContent = state.status === 'running' ? '约 ' + percent + '%' : percent + '%';
    $('#platform-sync-bar').value = percent;
    $('#platform-sync-detail').textContent = state.message || '';
    $('#platform-sync-dismiss').hidden = state.status === 'running';
    ['#home-refresh', '#l-platform', '#s-platform', '#d-visitor-sync'].forEach((selector) => {
      const button = $(selector); if (button) button.disabled = state.status === 'running';
    });
    ['#l-workspace', '#l-workspace-add', '#s-workspace'].forEach((selector) => {
      const control = $(selector); if (control) control.disabled = state.status === 'running';
    });
    ['#home-sync-status', '#l-platform-status', '#s-platform-status', '#d-visitor-status'].forEach((selector) => {
      const node = $(selector); if (node) node.textContent = state.message || '';
    });
  }
  function publishProgress(update) {
    const next = { ...(lastProgress || {}), ...update, at: Date.now() };
    renderProgress(next);
    progressWrite = progressWrite.catch(() => {}).then(() => chrome.storage.local.set({ [PROGRESS_KEY]: next }));
    return progressWrite;
  }

  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }
  function chart(id, option) {
    const dom = document.getElementById(id); if (!dom) return;
    if (charts[id]) charts[id].dispose();
    const c = echarts.init(dom); c.setOption(option); charts[id] = c;
  }
  function tbl(header, rows, limit) {
    if (!rows || !rows.length) return '<div class="muted" style="padding:6px 2px;">暂无数据</div>';
    const n = limit || rows.length;
    return '<div class="scroll"><table><thead><tr>' + header.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>'
      + rows.slice(0, n).map((r) => '<tr>' + r.map((c) => '<td>' + (c === null || c === undefined ? '' : c) + '</td>').join('') + '</tr>').join('')
      + '</tbody></table></div>';
  }
  function cards(items) {
    return '<div class="cards">' + items.map(([k, v, h]) =>
      '<div class="card"><div class="k">' + k + '</div><div class="v">' + (v === null || v === undefined ? '-' : v) + '</div><div class="h">' + (h || '') + '</div></div>').join('') + '</div>';
  }
  const concl = (text, note) => '<div class="concl">' + text + (note ? '<small>' + note + '</small>' : '') + '</div>';
  function barKv(title, pairs, horizontal) {
    return {
      title: { text: title, left: 0, textStyle: { fontSize: 13, color: '#374151' } },
      grid: { left: 8, right: 20, top: 34, bottom: 6, containLabel: true },
      tooltip: { trigger: 'axis' },
      xAxis: horizontal ? { type: 'value' } : { type: 'category', data: pairs.map((p) => p[0]), axisLabel: { interval: 0, rotate: 25, fontSize: 11 } },
      yAxis: horizontal ? { type: 'category', data: pairs.map((p) => p[0]), axisLabel: { fontSize: 11 } } : { type: 'value' },
      series: [{ type: 'bar', data: pairs.map((p) => p[1]), itemStyle: { color: '#2563eb', borderRadius: 4 }, barMaxWidth: 20 }],
    };
  }

  function navBar() {
    const names = Object.fromEntries(NAV);
    $('#nav').innerHTML = NAV_GROUPS.map(([group, ids]) => '<div class="nav-group-title">' + group + '</div>'
      + ids.map((k) => '<button type="button" data-k="' + k + '" class="' + (k === cur ? 'on' : '') + '"'
        + (k === cur ? ' aria-current="page"' : '') + '>' + names[k] + '</button>').join('')).join('');
    $('#nav').querySelectorAll('button').forEach((b) => { b.onclick = () => go(b.dataset.k); });
    $('#page-title').textContent = names[cur] || '工作区';
  }
  function go(k) {
    if (cur === 'shadow' && k !== 'shadow' && shadowStream) {
      shadowStream.abort();
      shadowStream = null;
    }
    if (cur === 'inbox' && k !== 'inbox') {
      if (inboxStream) { inboxStream.abort(); inboxStream = null; }
      if (inboxTimer) { clearInterval(inboxTimer); inboxTimer = null; }
    }
    if (cur === 'ads' && k !== 'ads' && self.AliAdsInsight) self.AliAdsInsight.destroy();
    cur = k;
    Object.keys(charts).forEach((id) => { charts[id].dispose(); delete charts[id]; });
    navBar();
    window.scrollTo(0, 0);
    const fn = { home: loadHome, inbox: loadInbox, inquiry: loadInquiry, customers: loadCustomers, expo: loadExpo, shadow: loadShadow,
      overview: loadStoreOverview,
      identity: loadIdentity, demand: loadDemand, ads: loadAds,
      library: loadLibrary, report: loadReport, settings: loadSettings }[k];
    if (fn) {
      const result = fn();
      Promise.resolve(result).then(() => renderProgress(lastProgress)).catch(() => {});
      return result;
    }
  }
  async function data() {
    if (CACHE) return CACHE;
    if (CACHE_PENDING) return CACHE_PENDING;
    const version = cacheVersion;
    const pending = (async () => {
      const rows = await DB.dataset(['inquiry', 'chat', 'customer', 'public_customer', 'visitor', 'order']);
      const [stages, visitorMeta] = await Promise.all([DB.stageMap(), DB.list('visitor')]);
      rows.stages = stages;
      rows.visitorSnapshot = visitorMeta.length > 0;
      rows.visitorLastImportAt = visitorMeta.length ? visitorMeta[0].mtime : '';
      if (version !== cacheVersion) return data();
      CACHE = rows;
      HOME_CACHE = rows;
      return rows;
    })();
    CACHE_PENDING = pending;
    try { return await pending; }
    finally { if (CACHE_PENDING === pending) CACHE_PENDING = null; }
  }
  async function homeData() {
    if (CACHE) return CACHE;
    if (CACHE_PENDING) return CACHE_PENDING;
    if (HOME_CACHE) return HOME_CACHE;
    if (HOME_PENDING) return HOME_PENDING;
    const version = cacheVersion;
    const pending = (async () => {
      const [rows, stages] = await Promise.all([
        DB.dataset(['inquiry', 'chat', 'customer', 'public_customer']), DB.stageMap(),
      ]);
      rows.stages = stages;
      if (version !== cacheVersion) return homeData();
      HOME_CACHE = rows;
      return rows;
    })();
    HOME_PENDING = pending;
    try { return await pending; }
    finally { if (HOME_PENDING === pending) HOME_PENDING = null; }
  }
  function invalidate() {
    CACHE = null; CACHE_PENDING = null; HOME_CACHE = null; HOME_PENDING = null; HOME_RESULT = null; cacheVersion++;
    AI_SESSIONS.forEach((state) => { if (state.stream) state.stream.abort(); });
    AI_SESSIONS.clear();
  }
  async function workspaces() {
    const o = await chrome.storage.local.get([WORKSPACE_LIST_KEY, WORKSPACE_ACTIVE_KEY]);
    const saved = Array.isArray(o[WORKSPACE_LIST_KEY]) ? o[WORKSPACE_LIST_KEY] : [];
    const items = [{ id: 'default', label: '原有资料 / 默认工作区' }, ...saved.filter((x) => x && x.id && x.id !== 'default')];
    const active = String(o[WORKSPACE_ACTIVE_KEY] || 'default');
    activeWorkspaceId = active;
    return { items, active };
  }
  async function switchWorkspace(id) {
    const progress = (await chrome.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY];
    if (progress && progress.status === 'running') {
      toast('数据更新中，完成后再切换员工或店铺工作区');
      go('library');
      return;
    }
    await chrome.storage.local.set({ [WORKSPACE_ACTIVE_KEY]: id });
    activeWorkspaceId = id;
    renderProgress(lastProgress);
    invalidate(); await loadStats(); go('library');
  }
  function downloadText(name, text) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }));
    link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  }
  function downloadCsv(name, header) {
    downloadText(name, header.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(',') + '\r\n');
  }

  async function loadStats() {
    const metas = await DB.list();
    const rows = metas.reduce((s, m) => s + (m.rows || 0), 0);
    $('#statLine').innerHTML = '本机资料：<b>' + metas.length + '</b> 个文件 · <b>' + rows + '</b> 行';
  }

  function emptyHint() {
    return '<div class="panel"><h3 style="margin-top:0;">正在准备首次数据</h3>'
      + '<div class="muted">扩展会从已登录的当前账号自动读取客户、询盘、订单、近期聊天和访客，直接写入本机资料库。</div>'
      + '<button type="button" id="empty-import">查看自动初始化</button></div>';
  }

  const PLATFORM_JOBS = [
    { kind: 'customer', label: '我的客户', url: 'https://i.alibaba.com/hub/alicrm/my_customer' },
    { kind: 'public_customer', label: '公海客户', url: 'https://i.alibaba.com/hub/alicrm/public_customer' },
    { kind: 'inquiry', label: '询盘', url: 'https://message.alibaba.com/message/default.htm' },
    { kind: 'chat', label: '聊天', url: 'https://onetalk.alibaba.com/message/weblitePWA.htm' },
    { kind: 'order', label: '订单', url: 'https://biz.alibaba.com/ta/list/scene/mainList.htm' },
    { kind: 'visitor', label: '访客', url: 'https://data.alibaba.com/marketing/visitor' },
  ];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function openAccountProbe() {
    const tab = await chrome.tabs.create({ url: 'https://onetalk.alibaba.com/message/weblitePWA.htm', active: false });
    if (!tab || tab.id == null) throw new Error('无法打开账号核实页面');
    // 后台标签页可能被浏览器冻结/丢弃，先标记为不可丢弃
    try { chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (e) { /* ignore */ }
    let ready = false;
    let loginRedirect = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      await wait(1000);
      try {
        const info = await chrome.tabs.get(tab.id);
        const u = String((info && info.url) || '');
        // 被重定向到登录页：直接给出明确提示，不再空等
        if (/login\.alibaba\.com|passport\.alibaba\.com|\/login/i.test(u)) { loginRedirect = true; break; }
      } catch (e) { break; } // 标签页被关闭
      try {
        const pong = await chrome.tabs.sendMessage(tab.id, { type: 'platformCollectPing' });
        if (pong && pong.ok) { ready = true; break; }
      } catch (e) { /* 等待页面和内容脚本 */ }
      // 页面已加载但内容脚本没注入（扩展刚更新/页面缓存）：补注入一次
      if (attempt === 10) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['vendor/xlsx.full.min.js', 'src/identity.js', 'src/order-match.js',
              'src/platform-job.js', 'src/sync-state.js', 'src/content.js'],
          });
        } catch (e) { /* 页面还没就绪，继续等 */ }
      }
    }
    if (!ready) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      if (loginRedirect) throw new Error('阿里/OneTalk 登录已失效：请先在 Edge 登录阿里国际站和 OneTalk，再点「自动更新」');
      throw new Error('无法核实卖家账号：OneTalk 页面 60 秒内未就绪。请先打开 https://onetalk.alibaba.com/message/weblitePWA.htm 确认能正常进入，再重新更新');
    }
    return {
      tabId: tab.id,
      read: async () => {
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'platformAccountProbe' });
        if (!result || !result.ok || !result.fingerprint) throw new Error(result && result.error || '无法核实卖家账号');
        return result;
      },
      close: () => chrome.tabs.remove(tab.id).catch(() => {}),
    };
  }
  async function workspaceSync() {
    const workspace = await DB.activeWorkspace();
    return { workspace, state: await SYNC.load(chrome.storage.local, workspace) };
  }
  async function waitForPlatformJob(jobId, tabId) {
    const resultKey = self.AliPlatformJob.key(jobId);
    const startedAt = Date.now();
    let polls = 0;
    while (Date.now() - startedAt < 30 * 60 * 1000) {
      const saved = (await chrome.storage.local.get(resultKey))[resultKey];
      if (saved) {
        await chrome.storage.local.remove(resultKey);
        return saved;
      }
      if (Date.now() - Number(lastProgress && lastProgress.at || startedAt) > 4 * 60 * 1000)
        throw new Error('采集页面超过 4 分钟没有新进度，请确认平台页面仍可使用');
      if (++polls % 6 === 0) {
        try { await chrome.tabs.get(tabId); }
        catch (e) { throw new Error('采集页面已关闭，请重新自动更新'); }
      }
      await wait(1500);
    }
    throw new Error('单项采集超过 30 分钟，已停止本次更新');
  }
  async function runPlatformSync({ button, status, full, kinds }) {
    if (syncRunning) { if (status) status.textContent = '自动更新正在进行，请等待完成'; return; }
    if (!RUNNER_MODE) {
      const prior = (await chrome.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY];
      const activeLock = (await chrome.storage.local.get('aliPlatformSyncLock')).aliPlatformSyncLock;
      if (activeLock && activeLock.tabId != null) {
        try {
          if (await chrome.tabs.get(activeLock.tabId)) {
            if (status) status.textContent = prior && prior.message || '更新任务正在运行';
            renderProgress(prior);
            return;
          }
        } catch (e) { /* 上次任务页已关闭 */ }
      }
      if (prior && prior.status === 'running' && Date.now() - Number(prior.at || 0) < 15 * 60 * 1000) {
        let alive = false;
        try { alive = !!(prior.runnerTabId && await chrome.tabs.get(prior.runnerTabId)); } catch (e) { /* ignore */ }
        if (alive || Date.now() - Number(prior.at || 0) < 30 * 1000) {
          if (status) status.textContent = prior.message || '更新任务正在运行';
          renderProgress(prior);
          return;
        }
      }
      const launchId = crypto.randomUUID();
      const url = new URL(chrome.runtime.getURL('dashboard.html'));
      url.searchParams.set('platformRunner', '1');
      url.searchParams.set('runId', launchId);
      if (full) url.searchParams.set('full', '1');
      if (Array.isArray(kinds) && kinds.length) url.searchParams.set('kinds', kinds.join(','));
      if (button) button.disabled = true;
      try {
        await publishProgress({ runId: launchId, workspace: await DB.activeWorkspace(), status: 'running', completed: 0, total: 0,
          percent: 0, message: '正在启动独立更新任务…', dismissed: false, runnerTabId: null });
        const tab = await chrome.tabs.create({ url: url.href, active: false });
        chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
        const latest = (await chrome.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY];
        if (latest && latest.runId === launchId) {
          const next = { ...latest, runnerTabId: tab.id };
          await chrome.storage.local.set({ [PROGRESS_KEY]: next });
          renderProgress(next);
        }
      } catch (e) {
        await publishProgress({ status: 'error', message: '启动更新任务失败：' + e.message });
      }
      return;
    }
    const workspace = await DB.activeWorkspace();
    let syncState = await SYNC.load(chrome.storage.local, workspace);
    let accountProbe;
    try {
      accountProbe = await openAccountProbe();
      const identity = await accountProbe.read();
      const existing = await DB.list();
      const error = SYNC.accountError(syncState, identity.fingerprint, existing.length > 0);
      if (error) throw new Error(error);
      if (!syncState.fingerprint)
        syncState = await SYNC.save(chrome.storage.local, workspace,
          { fingerprint: identity.fingerprint, boundAt: Date.now(), accountCount: identity.accountCount, accountError: '' });
      else if (syncState.accountError)
        syncState = await SYNC.save(chrome.storage.local, workspace, { accountError: '' });
    } catch (e) {
      if (accountProbe) await accountProbe.close();
      await SYNC.save(chrome.storage.local, workspace, { accountError: e.message, autoAttemptAt: Date.now() });
      await publishProgress({ workspace, status: 'error', message: e.message, dismissed: false });
      return;
    }
    if (!syncState.bootstrapComplete && !(Array.isArray(kinds) && kinds.length)) full = true;
    const lockKey = 'aliPlatformSyncLock';
    const stored = await chrome.storage.local.get(lockKey);
    if (stored[lockKey] && Date.now() - stored[lockKey].at < 15 * 60 * 1000) {
      let ownerOpen = false;
      try {
        const owner = stored[lockKey].tabId && await chrome.tabs.get(stored[lockKey].tabId);
        ownerOpen = !!owner;
      } catch (e) { /* 原工作台已关闭 */ }
      if (ownerOpen) { await accountProbe.close(); if (status) status.textContent = '另一工作台正在更新，稍后查看资料库'; return; }
    }
    const runId = RUNNER_ID || crypto.randomUUID();
    const ownTab = await chrome.tabs.getCurrent().catch(() => null);
    await chrome.storage.local.set({ [lockKey]: { id: runId, at: Date.now(), tabId: ownTab && ownTab.id,
      probeTabId: accountProbe.tabId, workspace, fingerprint: syncState.fingerprint } });
    syncState = await SYNC.save(chrome.storage.local, workspace, { autoAttemptAt: Date.now() });
    syncRunning = true; syncStatus = status;
    if (button) button.disabled = true;
    const byKind = { ...syncState.byKind };
    const targeted = !full && Array.isArray(kinds) && kinds.length > 0;
    const preserved = full && !syncState.bootstrapComplete
      ? await self.AliPlatformJob.recentSnapshots(PLATFORM_JOBS, byKind,
        async (kind) => {
          const source = syncState.sources[kind] || {};
          return !source.error && !source.truncated && !source.coverageGap && (await DB.list(kind)).length > 0;
        })
      : [];
    if (full) {
      for (const kind of ['inquiry', 'visitor']) {
        if (!syncState.cursors[kind]) continue;
        const pos = preserved.indexOf(kind);
        if (pos >= 0) preserved.splice(pos, 1);
      }
    }
    const jobs = full ? PLATFORM_JOBS.filter((x) => !preserved.includes(x.kind))
      : targeted ? PLATFORM_JOBS.filter((x) => kinds.includes(x.kind))
      : PLATFORM_JOBS.filter((x) => ['inquiry', 'chat', 'order'].includes(x.kind)
        || Date.now() - Number(byKind[x.kind] || 0) > (x.kind === 'customer' ? 60 : 24 * 60) * 60 * 1000);
    const summary = [];
    syncTotal = jobs.length; syncCompleted = 0;
    const say = (message, update) => {
      syncMessage = message;
      if (syncStatus) syncStatus.textContent = message;
      return publishProgress({ runId, runnerTabId: ownTab && ownTab.id, status: 'running', message, completed: syncCompleted,
        total: syncTotal, percent: syncTotal ? Math.round(syncCompleted / syncTotal * 100) : 0,
        dismissed: false, workspace, ...(update || {}) });
    };
    try {
      await say('正在准备 ' + jobs.length + ' 项数据更新…');
      for (const job of jobs) {
        if (await DB.activeWorkspace() !== workspace) throw new Error('工作区在更新期间发生变化，已暂停写入');
        const accountNow = await accountProbe.read();
        if (accountNow.fingerprint !== syncState.fingerprint)
          throw new Error('更新期间卖家账号发生变化，已暂停后续写入；请核对工作区');
        syncKind = job.kind;
        const jobFull = full || (job.kind === 'visitor' && !byKind.visitor);
        const jobStartedAt = Date.now();
        const sinceMs = self.AliPlatformJob.sinceMs(byKind[job.kind], jobStartedAt);
        const reconcile = job.kind === 'order' && !full
          && jobStartedAt - Number(syncState.orderReconcileAt || 0) >= 24 * 60 * 60 * 1000;
        await chrome.storage.local.set({ [lockKey]: { id: runId, at: Date.now(), tabId: ownTab && ownTab.id,
          probeTabId: accountProbe.tabId, workspace, fingerprint: syncState.fingerprint } });
        await say('自动读取 ' + job.label + '（' + (summary.length + 1) + '/' + jobs.length + '）…', { currentKind: job.kind });
        let tab;
        try {
          tab = await chrome.tabs.create({ url: job.url, active: false });
          if (!tab || tab.id == null) throw new Error('无法打开平台页面');
          await chrome.storage.local.set({ [lockKey]: { id: runId, at: Date.now(), tabId: ownTab && ownTab.id,
            collectorTabId: tab.id, probeTabId: accountProbe.tabId, workspace, fingerprint: syncState.fingerprint } });
          let ready = false;
          for (let attempt = 0; attempt < 30; attempt++) {
            await wait(1000);
            try {
              const pong = await chrome.tabs.sendMessage(tab.id, { type: 'platformCollectPing' });
              if (pong && pong.ok) { ready = true; break; }
            } catch (e) { /* 等待平台页面和内容脚本加载 */ }
          }
          if (!ready) throw new Error('平台页面未能加载采集模块；请确认已登录并能正常打开 ' + job.label + ' 页面');
          const hasCursor = job.kind === 'inquiry' || job.kind === 'visitor';
          let page = jobFull && hasCursor ? Number(syncState.cursors[job.kind]) || 1 : 1;
          let result, kindRows = 0, chunk = 0;
          let truncated = false, coverageGap = false, expectedTotal = null, latestBusinessAt = '';
          do {
            const jobId = runId + ':' + job.kind + ':' + summary.length + ':' + chunk++;
            const resultKey = self.AliPlatformJob.key(jobId);
            await chrome.storage.local.remove(resultKey);
            const ack = await chrome.tabs.sendMessage(tab.id, {
              type: 'platformCollectRun', kind: job.kind, full: jobFull, jobId, sinceMs, reconcile, startPage: page,
              workspace, accountFingerprint: syncState.fingerprint,
            });
            if (!ack || !ack.ok || !ack.started) throw new Error(ack && ack.error || '采集页面未确认启动');
            result = await waitForPlatformJob(jobId, tab.id);
            if (!result || !result.ok) throw new Error(result && result.error || '采集失败');
            kindRows += Number(result.rows) || 0;
            truncated = truncated || !!(result.truncated && !result.nextPage);
            coverageGap = coverageGap || !!result.coverageGap;
            if (result.expectedTotal != null && Number.isFinite(Number(result.expectedTotal))) expectedTotal = Number(result.expectedTotal);
            if (result.latestBusinessAt && result.latestBusinessAt > latestBusinessAt) latestBusinessAt = result.latestBusinessAt;
            page = Number(result.nextPage) || 0;
            if (hasCursor && page) {
              if (jobFull) syncState = await SYNC.save(chrome.storage.local, workspace,
                { cursors: { ...syncState.cursors, [job.kind]: page } });
              await say(job.label + '已入库 ' + kindRows + ' 条，继续读取第 ' + page + ' 页…');
              await wait(3000 + Math.floor(Math.random() * 2000));
            }
          } while (page);
          if (jobFull && hasCursor) {
            const cursors = { ...syncState.cursors }; delete cursors[job.kind];
            syncState = await SYNC.save(chrome.storage.local, workspace, { cursors });
          }
          const accountAfter = await accountProbe.read();
          if (accountAfter.fingerprint !== syncState.fingerprint) throw new Error('卖家账号在本项采集期间变化；请核对已入库资料');
          syncKind = '';
          summary.push(job.label + ' ' + kindRows + ' 条'
            + (truncated ? '（达到安全页数上限）' : '')
            + (coverageGap ? '（停用超30天，较早访客需另行补录）' : ''));
          syncCompleted = summary.length;
          await say(job.label + ' 已完成 · ' + kindRows + ' 条', {
            currentKind: '', ...(summary.length === jobs.length ? { percent: 96 } : {}),
          });
          // 从采集开始时刻续传，下一轮会再读 1 小时重叠区，避免运行期间的更新漏采。
          byKind[job.kind] = jobStartedAt;
          const previousSource = syncState.sources[job.kind] || {};
          syncState = await SYNC.save(chrome.storage.local, workspace, {
            byKind, sources: { ...syncState.sources, [job.kind]: {
              lastSuccessMs: Date.now(), lastStartedMs: jobStartedAt, rowsThisRun: kindRows,
              truncated: truncated || (!jobFull && !!previousSource.truncated),
              coverageGap: coverageGap || !!previousSource.coverageGap,
              expectedTotal,
              latestBusinessAt: latestBusinessAt > String(previousSource.latestBusinessAt || '')
                ? latestBusinessAt : String(previousSource.latestBusinessAt || ''),
              error: '', full: jobFull,
            } }, ...(job.kind === 'order' && (full || reconcile)
              ? { orderReconcileAt: jobStartedAt } : {}),
          });
          invalidate(); await loadStats();
        } finally {
          if (tab && tab.id != null) await chrome.tabs.remove(tab.id).catch(() => {});
        }
        if (summary.length < jobs.length) await wait(3000 + Math.floor(Math.random() * 2000));
      }
      const at = new Date().toLocaleString('zh-CN');
      syncState = await SYNC.save(chrome.storage.local, workspace, targeted ? { actionCheckAt: at }
        : { syncAt: at, syncAtMs: Date.now(), summary,
          ...(full ? { bootstrapComplete: true } : {}) });
      let localService = '本机背调服务未连接，浏览器资料已保存';
      try {
        let timer;
        const result = await Promise.race([
          chrome.runtime.sendMessage({ type: 'syncToMcp' }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('本机服务同步超时')), 20000); }),
        ]).finally(() => clearTimeout(timer));
        if (result && result.ok) localService = '本机背调服务已同步';
      } catch (e) { /* 本机服务是可选项 */ }
      await publishProgress({ runId, status: 'done', completed: jobs.length, total: jobs.length,
        percent: 100, currentKind: '', message: '已自动入库：' + (summary.join(' · ') || '本轮无需重复采集')
          + (preserved.length ? '；沿用已入库：' + preserved.map((kind) => (PLATFORM_JOBS.find((x) => x.kind === kind) || {}).label).join('、') : '')
          + '。' + localService + '。', dismissed: false });
      invalidate(); await loadStats();
      if (!RUNNER_MODE && cur === 'home') loadHome();
    } catch (e) {
      if (/账号|OneTalk|登录/.test(e.message))
        syncState = await SYNC.save(chrome.storage.local, workspace, { accountError: e.message });
      if (syncKind) {
        syncState = await SYNC.save(chrome.storage.local, workspace, {
          sources: { ...syncState.sources, [syncKind]: { ...(syncState.sources[syncKind] || {}), error: e.message, lastErrorMs: Date.now() } },
        });
      }
      await publishProgress({ runId, status: 'error', completed: summary.length, total: jobs.length,
        percent: jobs.length ? Math.round(summary.length / jobs.length * 100) : 0, currentKind: '',
        message: '自动更新暂停：' + e.message + (summary.length ? '；已写入：' + summary.join(' · ') : '')
          + (preserved.length ? '；已沿用：' + preserved.map((kind) => (PLATFORM_JOBS.find((x) => x.kind === kind) || {}).label).join('、') : '')
          + '。检查平台页面状态后可重新自动更新。', dismissed: false });
    } finally {
      await accountProbe.close();
      const current = await chrome.storage.local.get(lockKey);
      if (current[lockKey] && current[lockKey].id === runId) await chrome.storage.local.remove(lockKey);
      syncRunning = false; syncKind = ''; syncStatus = null;
      if (button) button.disabled = false;
      ['#home-refresh', '#l-platform', '#s-platform', '#d-visitor-sync'].forEach((selector) => {
        const currentButton = $(selector);
        if (currentButton) currentButton.disabled = false;
      });
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (RUNNER_MODE && syncRunning && msg && msg.type === 'platformCollectProgress' && msg.kind === syncKind) {
      syncMessage = '自动读取' + (PLATFORM_JOBS.find((x) => x.kind === syncKind) || {}).label + '：' + msg.message;
      if (syncStatus) syncStatus.textContent = syncMessage;
      const message = String(msg.message || '');
      const ratio = ['customer', 'public_customer', 'order', 'visitor'].includes(syncKind)
        ? message.match(/(\d+)\/(\d+)/) : null;
      let fraction = ratio && Number(ratio[2]) > 0 ? Math.min(.95, Number(ratio[1]) / Number(ratio[2])) : 0;
      if (syncKind === 'inquiry') {
        const page = message.match(/已读取\s*(\d+)\s*页/);
        if (page) fraction = Math.min(.95, Number(page[1]) / 100);
      }
      if (syncKind === 'chat') {
        const sessions = message.match(/已读取\s*(\d+)\s*个会话/);
        if (sessions) fraction = Math.min(.95, Number(sessions[1]) / 400);
      }
      const percent = syncTotal ? Math.min(99, Math.round((syncCompleted + fraction) / syncTotal * 100)) : 0;
      publishProgress({ status: 'running', currentKind: syncKind, message: syncMessage,
        completed: syncCompleted, total: syncTotal, percent, dismissed: false });
    }
  });

  // ---------------- 今日待办 ----------------
  async function loadHome() {
    $('#view').innerHTML = '<h2>今日待办</h2><div class="muted">加载中…</div>';
    const rows = await homeData();
    if (cur !== 'home') return;
    const day = new Date().toDateString();
    if (!HOME_RESULT || HOME_RESULT.rows !== rows || HOME_RESULT.day !== day)
      HOME_RESULT = { rows, day, value: A.home(rows) };
    const d = { ...HOME_RESULT.value, asOf: A.fmtDT(new Date()) };
    const files = await DB.list();
    if (cur !== 'home') return;
    if (!files.length) { $('#view').innerHTML = '<h2>今日待办</h2>' + emptyHint(); $('#empty-import').onclick = () => go('settings'); return; }
    const ws = await workspaces();
    if (cur !== 'home') return;
    const state = loadTodoState(ws.active);
    const todos = d.todos.filter((t) => {
      const saved = state[todoId(t)];
      return !saved || saved.version !== todoVersion(t) || (saved.status === 'later' && Date.now() >= saved.until);
    });
    const hidden = d.todos.length - todos.length;
    const sync = await workspaceSync();
    if (cur !== 'home') return;
    const staleKinds = ['inquiry', 'chat'].filter((kind) => SYNC.health(sync.state, kind).status !== '已更新');
    const kpi = d.kpi.map((item) => item[0] === 'P0 待办' ? [item[0], todos.filter((t) => t.level === 'P0').length, item[2]] : item);
    $('#view').innerHTML = '<h2>今日待办</h2>'
      + concl(esc(d.headline), '看板时间 ' + d.asOf + ' · 当前工作区平台上次更新 ' + esc(sync.state.syncAt || '尚未自动更新')
        + ' · 待办仅采用最近3个本机自然日的业务活动（含今天）')
      + (staleKinds.length ? '<div class="panel warn">询盘或聊天存在未绑定、未同步、超过 2 小时、截断或失败的数据源；当前待办只反映已入库资料。请到资料库查看逐源状态并核实客户。</div>' : '')
      + '<div class="bar"><button type="button" id="home-refresh">更新平台数据</button><span id="home-sync-status" class="muted" aria-live="polite">处理事项后可直接标记已完成；新客户活动会重新列出。</span></div>'
      + cards(kpi)
      + (d.identity ? '<div style="margin:6px 0 10px;font-size:12.5px;color:#4b5563;">身份统一：' + d.identity.profiles + ' 个客户档案，合并 ' + d.identity.duplicateGroups
        + ' 组重复客户，已关联询盘 ' + d.identity.linkedInquiries + '/' + d.identity.inquiries + '、聊天会话 ' + d.identity.linkedChatSessions + '/' + d.identity.chatSessions
        + ' <button type="button" class="ilink" data-go="identity">查看 →</button></div>' : '')
      + '<div class="pill-title">优先跟进 <span class="pill-count">' + todos.length + ' 项</span></div>'
      + todos.map((t) => {
        const chips = '<span class="chip ' + (t.level === 'P0' ? 'high' : 'mid') + '">' + esc(t.priorityLabel || t.level) + '</span>'
          + '<span class="chip tag">' + esc(t.tag) + '</span>'
          + (t.action ? '<span class="chip act">' + esc(t.action) + '</span>' : '');
        const ai = t.ai ? '<details class="ai-box"><summary>查看分析依据</summary><div class="ai-head"><span class="ai-pill">客户分析</span>'
          + '<button type="button" class="ai-more" data-act="full">查看完整分析</button></div>'
          + '<div class="ai-row"><b>客户互动总结：</b>' + esc(t.ai.interaction) + '</div>'
          + '<div class="ai-row"><b>国际站行为&偏好洞察：</b>' + esc(t.ai.behavior) + '</div>'
          + '<div class="ai-row"><b>客户价值与趋势：</b>' + esc(t.ai.value) + '</div>'
          + '<div class="ai-row"><b>背调分析：</b>' + esc(t.ai.background) + '</div></details>' : '';
        return '<div class="todo-card" data-index="' + todos.indexOf(t) + '">'
          + '<div class="chips">' + chips + '</div>'
          + '<div class="t">' + esc(t.title) + '</div>'
          + '<div class="kv"><span class="k">推荐理由</span><div class="v">' + esc(t.detail) + '</div>'
          + '<span class="k">截止日期</span><div class="v">' + esc(t.due || '今天') + '</div></div>'
          + '<div class="kv"><span class="k">跟进人</span><div class="v">' + esc(t.owner || '未分配') + '</div>'
          + '<span class="k">优先级</span><div class="v">' + esc(t.level) + '</div></div>'
          + '<div class="todo-foot"><button type="button" class="link" data-act="draft">复制话术提示词</button><button type="button" class="link" data-act="done">标记已处理</button><button type="button" class="link" data-act="later">明天再看</button>'
          + (t.inquiryId ? '<button type="button" class="link" data-act="missing">确认询盘已不存在</button>' : '')
          + (t.url ? '<a class="btn" href="' + esc(t.url) + '" target="_blank" rel="noopener">' + esc(t.action || '去处理') + ' →</a>' : '')
          + '</div>' + ai + '</div>';
      }).join('')
      + '<div class="muted" style="margin-top:10px;">这里仅显示最近3天活动产生的优先事项；历史名单可在「询盘线索」和「客户资产」查看。'
      + (hidden ? ' · 已处理或稍后 <b>' + hidden + '</b> 条，<button type="button" class="unignore">恢复显示</button>' : '') + '</div>';
    $('#view').querySelectorAll('.todo-card').forEach((card) => {
      const t = todos[Number(card.dataset.index)];
      if (!t) return;
      const draft = card.querySelector('[data-act="draft"]');
      if (draft) draft.onclick = () => {
        const prompt = '请针对客户「' + t.title + '」生成跟进话术。推荐理由：' + t.detail
          + '。要求：60-90 词、英文、含一个容易回答的问题；价格/交期/认证标【需人工确认】。';
        navigator.clipboard.writeText(prompt).then(() => toast('已复制话术提示词，去「聊天分析（AI）」粘贴生成')).catch(() => toast('复制失败，请手动复制'));
      };
      for (const action of ['done', 'later']) {
        const button = card.querySelector('[data-act="' + action + '"]');
        if (button) button.onclick = () => {
          const next = loadTodoState(ws.active);
          next[todoId(t)] = { status: action, version: todoVersion(t), at: Date.now(),
            until: action === 'later' ? Date.now() + 24 * 60 * 60 * 1000 : 0 };
          saveTodoState(ws.active, next);
          toast(action === 'done' ? '已处理：' + t.title : '明天再看：' + t.title);
          loadHome();
        };
      }
      const missing = card.querySelector('[data-act="missing"]');
      if (missing) missing.onclick = async () => {
        const note = window.prompt('请先在平台询盘页核实，再填写“该询盘已不存在”的依据：');
        if (!note || !note.trim()) return;
        try {
          await DB.setStage(t.inquiryId, '无效询盘', note.trim());
          invalidate(); await loadHome(); toast('已记录核实依据，待办已关闭');
        } catch (e) { toast('保存失败：' + e.message); }
      };
      const full = card.querySelector('[data-act="full"]');
      if (full) full.onclick = () => go(t.tag === '客户流失预警' || t.tag === '公海捡漏' ? 'customers' : 'inquiry');
      const link = card.querySelector('.todo-foot a.btn');
      if (link) link.onclick = () => {
        try {
          const url = new URL(link.href);
          const kinds = ['高价值待核实', '批量待核实'].includes(t.tag)
            ? ['customer', 'public_customer', 'inquiry']
            : url.hostname === 'onetalk.alibaba.com' ? ['chat']
            : url.hostname === 'biz.alibaba.com' ? ['order']
              : url.pathname.includes('public_customer') ? ['public_customer', 'customer', 'inquiry']
                : url.hostname === 'i.alibaba.com' ? ['customer', 'inquiry'] : ['inquiry'];
          sessionStorage.setItem(TODO_RETURN_KEY, JSON.stringify({ kinds, at: Date.now(), checkedAt: 0 }));
        } catch (e) { /* 链接仍正常打开 */ }
      };
    });
    const un = $('#view').querySelector('.unignore');
    if (un) un.onclick = () => { try { localStorage.removeItem(TODO_STATE_KEY + ws.active); } catch (e) { /* ignore */ } loadHome(); };
    const il = $('#view').querySelector('.ilink');
    if (il) il.onclick = () => go('identity');
    $('#home-refresh').onclick = (e) => runPlatformSync({ button: e.currentTarget, status: $('#home-sync-status'), full: false });
    if (syncRunning) { syncStatus = $('#home-sync-status'); syncStatus.textContent = syncMessage; $('#home-refresh').disabled = true; }
  }

  // ---------------- 智能客服离线试运行 ----------------
  const shadowStamp = (d) => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0') + '_' + String(d.getHours()).padStart(2, '0')
    + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0');
  const shadowRecordKey = (workspace) => SHADOW_RECORD_PREFIX + encodeURIComponent(workspace);

  function loadShadowRecords(workspace, samples) {
    let records = {};
    try { records = JSON.parse(localStorage.getItem(shadowRecordKey(workspace)) || '{}') || {}; } catch (e) { records = {}; }
    let legacy = {};
    try { legacy = JSON.parse(localStorage.getItem(SHADOW_REVIEW_PREFIX + encodeURIComponent(workspace)) || '{}') || {}; } catch (e) { legacy = {}; }
    samples.forEach((item) => {
      const id = item.check.inquiryId;
      if (!id || records[id] || !legacy[id]) return;
      const migrated = SHADOW.migrateLegacy(legacy[id], item.check, workspace);
      if (migrated) records[id] = migrated;
    });
    return records;
  }
  function saveShadowRecords(workspace, records) {
    localStorage.setItem(shadowRecordKey(workspace), JSON.stringify(records));
  }

  async function loadShadow() {
    $('#view').innerHTML = '<h2>智能客服试运行</h2><div class="muted">读取本机询盘样本…</div>';
    const openingWorkspace = await DB.activeWorkspace();
    const [dataset, sync] = await Promise.all([DB.dataset(['inquiry']), workspaceSync()]);
    if (cur !== 'shadow') return;
    if (sync.workspace !== openingWorkspace || await DB.activeWorkspace() !== openingWorkspace) {
      $('#view').innerHTML = '<h2>智能客服试运行</h2><div class="panel warn">工作区在读取期间发生变化，请重新进入本页。</div>';
      return;
    }
    const inquiryHealth = SYNC.health(sync.state, 'inquiry').status || '未知';
    const chatHealth = SYNC.health(sync.state, 'chat').status || '未知';
    const built = SHADOW.sampleRows(dataset.inquiry || [], inquiryHealth, chatHealth, { limit: 100, now: Date.now() });
    const samples = built.samples;
    const records = loadShadowRecords(sync.workspace, samples);
    const reviewerKey = SHADOW_REVIEWER_KEY + encodeURIComponent(sync.workspace);
    const reviewer = localStorage.getItem(reviewerKey) || '';
    const initialStats = SHADOW.summary(samples, records);
    let selected = -1;

    const recordFor = (item) => {
      const id = item.check.inquiryId;
      const saved = id ? records[id] : null;
      if (saved) {
        const blank = SHADOW.emptyRecord(item.check);
        if (!saved.workspace) saved.workspace = sync.workspace;
        if (!saved.draft) saved.draft = blank.draft;
        if (!saved.platform) saved.platform = blank.platform;
        if (!saved.review) saved.review = blank.review;
        return saved;
      }
      const blank = SHADOW.emptyRecord(item.check);
      blank.workspace = sync.workspace;
      return blank;
    };
    const stratumCounts = () => {
      const out = {};
      built.strata.forEach((row) => { out[row.name] = { reviewed: 0, auto: 0, human: 0, noReply: 0, reject: 0 }; });
      samples.forEach((item) => {
        const record = records[item.check.inquiryId];
        const disposition = record && record.review && record.review.disposition;
        const bucket = out[item.check.stratum];
        if (!disposition || !bucket) return;
        bucket.reviewed += 1;
        if (disposition === '可自动确认') bucket.auto += 1;
        else if (disposition === '需人工') bucket.human += 1;
        else if (disposition === '无需回复') bucket.noReply += 1;
        else if (disposition === '不应回复') bucket.reject += 1;
      });
      return out;
    };
    const optionHtml = (list, current, empty) => '<option value="">' + esc(empty) + '</option>'
      + list.map((value) => '<option value="' + esc(value) + '"' + (value === current ? ' selected' : '') + '>'
        + esc(value) + '</option>').join('');
    const counts = stratumCounts();

    $('#view').innerHTML = '<h2>智能客服试运行</h2>'
      + '<div class="panel warn"><b>仅供离线评估与员工草稿验证</b><div class="muted">这里没有发送按钮，也不会自动向客户回复。每条样本都要回到平台核对最新买家消息与回复状态；未核对不能标记“可自动确认”。</div></div>'
      + cards([
        ['已入库询盘', built.total, '当前工作区'],
        ['分层抽样', samples.length, '上限 100 条'],
        ['已评估', '<span id="shadow-stat-reviewed">' + initialStats.reviewed + ' / ' + samples.length + '</span>', '本机保存'],
        ['平台已核对', '<span id="shadow-stat-platform">' + initialStats.platformChecked + ' / ' + samples.length + '</span>', '含核对人和时间'],
        ['可自动确认', '<span id="shadow-stat-auto">' + (initialStats.dispositions['可自动确认'] || 0) + '</span>', '仍需平台授权'],
        ['阻断项', '<span id="shadow-stat-blocking">' + initialStats.blockingTotal + '</span>', '错客户/无依据/过期/重复'],
        ['草稿已生成', '<span id="shadow-stat-drafts">' + initialStats.drafts + '</span>', '仅存档，不发送'],
      ])
      + '<div class="panel"><b>数据状态：</b>询盘 ' + esc(inquiryHealth) + ' · 聊天 ' + esc(chatHealth)
      + '<div class="muted">即使两个来源均显示已更新，仍不能据此认定最新消息完整；平台核对结果以员工填写的最新消息时间和消息ID为准。</div></div>'
      + '<div class="bar"><button type="button" id="shadow-export" class="ghost">导出评估 CSV</button>'
      + '<span class="muted">包含全部抽样、未评估项、平台核对、草稿正文与校验结果；不含客户联系方式。</span></div>'
      + '<div class="panel"><h3 style="margin-top:0">分层覆盖</h3>'
      + '<div class="muted">按最近创建时间与分层轮转抽取，避免只取到已回复或同一类样本。</div>'
      + '<div class="scroll" style="margin-top:8px"><table><thead><tr><th>分层</th><th>可用样本</th><th>抽样</th><th>已评估</th><th>可自动确认</th><th>需人工</th><th>无需回复</th><th>不应回复</th></tr></thead><tbody>'
      + built.strata.map((row, index) => {
        const bucket = counts[row.name] || { reviewed: 0, auto: 0, human: 0, noReply: 0, reject: 0 };
        return '<tr data-stratum-index="' + index + '"><td>' + esc(row.name) + '</td><td>' + row.available + '</td><td>' + row.selected + '</td>'
          + '<td data-stratum-field="reviewed">' + bucket.reviewed + '</td><td data-stratum-field="auto">' + bucket.auto + '</td>'
          + '<td data-stratum-field="human">' + bucket.human + '</td><td data-stratum-field="noReply">' + bucket.noReply + '</td>'
          + '<td data-stratum-field="reject">' + bucket.reject + '</td></tr>';
      }).join('')
      + '</tbody></table></div></div>'
      + '<div class="panel"><h3 style="margin-top:0">历史样本</h3>'
      + (samples.length ? '<div class="scroll"><table><thead><tr><th>时间</th><th>客户</th><th>分层</th><th>历史回复</th><th>平台核对</th><th>处置</th><th>草稿</th><th>操作</th></tr></thead><tbody>'
        + samples.map((item, index) => {
          const record = records[item.check.inquiryId];
          const disposition = record && record.review && record.review.disposition || '未评估';
          const platform = record && record.platform && record.platform.status || '未核对';
          const draft = record && record.draft && record.draft.text ? '已生成'
            : record && record.draft && record.draft.error ? '失败' : '未生成';
          return '<tr data-shadow-row="' + index + '"><td>' + esc(item.check.createdAt) + '</td><td>'
            + esc(item.check.customer || item.check.company || '-') + '</td><td>' + esc(item.check.stratum)
            + '</td><td>' + esc(item.check.replyStatus || '未知') + '</td><td data-cell="platform">' + esc(platform)
            + '</td><td data-cell="disposition">' + esc(disposition) + '</td><td data-cell="draft">' + esc(draft)
            + '</td><td><button type="button" class="ghost" data-shadow-index="' + index + '">查看</button></td></tr>';
        }).join('')
        + '</tbody></table></div>' : '<div class="muted">暂无询盘资料，请先在资料库完成导入。</div>') + '</div>'
      + '<div id="shadow-detail" class="panel" aria-live="polite">选择一条历史询盘，查看草稿与平台核对条件。</div>';

    const refreshStats = () => {
      const next = SHADOW.summary(samples, records);
      const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
      set('shadow-stat-reviewed', next.reviewed + ' / ' + samples.length);
      set('shadow-stat-platform', next.platformChecked + ' / ' + samples.length);
      set('shadow-stat-auto', next.dispositions['可自动确认'] || 0);
      set('shadow-stat-blocking', next.blockingTotal);
      set('shadow-stat-drafts', next.drafts);
      const nextCounts = stratumCounts();
      $('#view').querySelectorAll('[data-stratum-index]').forEach((row) => {
        const entry = built.strata[Number(row.dataset.stratumIndex)];
        const bucket = nextCounts[entry && entry.name] || { reviewed: 0, auto: 0, human: 0, noReply: 0, reject: 0 };
        const setCell = (field, value) => {
          const cell = row.querySelector('[data-stratum-field="' + field + '"]');
          if (cell) cell.textContent = value;
        };
        setCell('reviewed', bucket.reviewed); setCell('auto', bucket.auto); setCell('human', bucket.human);
        setCell('noReply', bucket.noReply); setCell('reject', bucket.reject);
      });
    };

    const exportButton = $('#shadow-export');
    exportButton.onclick = () => {
      if (!samples.length) { toast('暂无可导出的样本'); return; }
      try {
        const rows = samples.map((item) => {
          const record = recordFor(item);
          record.workspace = sync.workspace;
          return record;
        });
        downloadText('智能客服影子评估_' + shadowStamp(new Date()) + '.csv', SHADOW.csv(rows));
        toast('已导出 ' + rows.length + ' 条样本');
      } catch (e) {
        toast('导出失败：' + (e.message || String(e)));
      }
    };

    const detail = $('#shadow-detail');
    const show = (index) => {
      if (shadowStream) { shadowStream.abort(); shadowStream = null; }
      selected = index;
      const item = samples[index];
      if (!item) return;
      const check = item.check;
      const record = recordFor(item);
      const draftMeta = record.draft || SHADOW.emptyRecord(check).draft;
      const platform = record.platform || SHADOW.emptyRecord(check).platform;
      const review = record.review || SHADOW.emptyRecord(check).review;
      let draftText = draftMeta.text || '';
      detail.innerHTML = '<h3 style="margin-top:0">' + esc(check.subject || check.product || '主题未知') + '</h3>'
        + '<div class="muted">询盘 ID：' + esc(check.inquiryId || '缺失') + ' · 客户：' + esc(check.customer || check.company || '-')
        + ' · 分层：' + esc(check.stratum) + ' · 历史状态：' + esc(check.replyStatus || '未知')
        + ' · 创建：' + esc(check.createdAt || '未知') + (check.ageDays == null ? '' : '（' + check.ageDays + ' 天前）')
        + (check.statusAgeDays != null && check.statusAgeDays !== check.ageDays ? ' · 状态时效：' + check.statusAgeDays + ' 天前' : '')
        + ' · 数据置信：' + esc(check.confidence) + '</div>'
        + '<div style="margin:8px 0"><b>人工复核原因</b><ul>' + check.reasons.map((reason) => '<li>' + esc(reason) + '</li>').join('') + '</ul></div>'
        + '<div class="panel" style="background:#fafbfc"><div class="bar"><button type="button" id="shadow-draft"'
        + (check.canDraft ? '' : ' disabled') + '>AI 生成英文草稿</button>'
        + '<button type="button" class="ghost" id="shadow-copy"' + (draftText ? '' : ' disabled') + '>复制草稿</button>'
        + '<span id="shadow-status" class="muted">' + (draftText ? '已生成，模型 ' + esc(draftMeta.model || '-') : '尚未生成') + '</span></div>'
        + '<pre id="shadow-output" class="advice" style="min-height:90px">' + esc(draftText || '草稿将在这里显示；只向已配置的 AI 服务发送主题和产品名称。') + '</pre>'
        + '<div class="muted" id="shadow-draft-meta">' + (draftMeta.generatedAt
          ? '生成时间 ' + esc(SHADOW.fmtTime(draftMeta.generatedAt)) + ' · 耗时 ' + (draftMeta.latencyMs || 0) + 'ms · 提示词 ' + esc(draftMeta.promptVersion || SHADOW.DRAFT_PROMPT_VERSION)
          : '') + '</div></div>'
        + '<div class="panel"><h3 style="margin-top:0">平台核对</h3><div class="bar">'
        + '<select id="shadow-platform" aria-label="平台核对状态">' + optionHtml(SHADOW.PLATFORM_STATUSES, platform.status, '核对状态（必填）') + '</select>'
        + '<input id="shadow-latest-at" aria-label="最新买家消息时间" placeholder="最新买家消息时间 YYYY-MM-DD HH:mm" value="' + esc(platform.latestBuyerMessageAt) + '" style="min-width:230px">'
        + '<input id="shadow-latest-id" aria-label="最新消息ID" placeholder="最新消息ID" value="' + esc(platform.latestMessageId) + '" style="min-width:140px">'
        + '<input id="shadow-checker" aria-label="核对人" placeholder="核对人" value="' + esc(platform.checkedBy || reviewer) + '" style="min-width:100px">'
        + '</div><div class="muted">回到平台核对最新买家消息时间、消息ID与是否已回复。核对人用于审计；未核对不能标记“可自动确认”。</div></div>'
        + '<div class="panel"><h3 style="margin-top:0">员工评估</h3><div class="bar">'
        + '<select id="shadow-disposition" aria-label="处置结论">' + optionHtml(SHADOW.DISPOSITIONS, review.disposition, '处置结论（必填）') + '</select>'
        + '<select id="shadow-quality" aria-label="草稿质量">' + optionHtml(SHADOW.QUALITIES, review.quality, '草稿质量（必填）') + '</select></div>'
        + '<div id="shadow-reasons">' + SHADOW.REASON_GROUPS.map((group) => '<div style="margin:6px 0"><b>' + esc(group.name) + '：</b>'
          + group.codes.map((code) => '<label style="margin-right:12px;white-space:nowrap"><input type="checkbox" data-shadow-reason value="'
            + esc(code) + '"' + ((review.reasons || []).includes(code) ? ' checked' : '') + '> ' + esc(code) + '</label>').join('') + '</div>').join('') + '</div>'
        + '<textarea id="shadow-note" rows="2" aria-label="评估备注" placeholder="修改原因、平台核对说明或需要人工确认的事项" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font:inherit">' + esc(review.note) + '</textarea>'
        + '<div class="bar" style="margin-top:10px"><button type="button" id="shadow-save"' + (check.inquiryId ? '' : ' disabled') + '>保存评估</button>'
        + '<span id="shadow-save-status" class="muted">' + (review.reviewedAt ? '上次评估 ' + esc(SHADOW.fmtTime(review.reviewedAt)) : '尚未保存') + '</span></div></div>';

      const draftButton = detail.querySelector('#shadow-draft');
      const copyButton = detail.querySelector('#shadow-copy');
      const output = detail.querySelector('#shadow-output');
      const status = detail.querySelector('#shadow-status');
      const meta = detail.querySelector('#shadow-draft-meta');
      const saveButton = detail.querySelector('#shadow-save');
      const saveStatus = detail.querySelector('#shadow-save-status');

      draftButton.onclick = async () => {
        draftButton.disabled = true;
        output.textContent = '';
        status.textContent = '正在生成草稿…';
        const started = Date.now();
        const prior = {
          text: record.draft.text, model: record.draft.model,
          generatedAt: record.draft.generatedAt, latencyMs: record.draft.latencyMs,
        };
        record.draft.attempts = (record.draft.attempts || 0) + 1;
        record.draft.error = '';
        record.draft.generatedAt = started;
        record.draft.latencyMs = 0;
        let stream = null;
        try {
          if (await DB.activeWorkspace() !== openingWorkspace) throw new Error('工作区已切换，请重新进入本页');
          const cfg = await loadAiCfg();
          if (cur !== 'shadow' || selected !== index) return;
          record.draft.model = cfg.model || '';
          stream = DAI.openStream(SHADOW.draftMessages(item.row), cfg, (delta) => {
            if (cur === 'shadow' && selected === index) output.textContent += delta;
          });
          shadowStream = stream;
          await stream.promise;
          if (cur !== 'shadow' || selected !== index) return;
          draftText = output.textContent.trim();
          if (!draftText) throw new Error('模型返回空草稿');
          record.draft.text = draftText;
          record.draft.latencyMs = Date.now() - started;
          record.draft.generatedAt = Date.now();
          copyButton.disabled = false;
          status.textContent = '草稿完成，请核对平台原文与事实后保存评估';
          meta.textContent = '生成时间 ' + SHADOW.fmtTime(record.draft.generatedAt) + ' · 耗时 '
            + record.draft.latencyMs + 'ms · 提示词 ' + (record.draft.promptVersion || SHADOW.DRAFT_PROMPT_VERSION);
          if (check.inquiryId) {
            records[check.inquiryId] = record;
            try { saveShadowRecords(sync.workspace, records); } catch (e2) { /* 本机存储不可用 */ }
          }
          refreshStats();
          const draftRow = $('#view').querySelector('[data-shadow-row="' + index + '"]');
          if (draftRow) draftRow.querySelector('[data-cell="draft"]').textContent = '已生成';
        } catch (e) {
          if (cur !== 'shadow' || selected !== index) return;
          record.draft.text = prior.text;
          record.draft.model = prior.model;
          record.draft.generatedAt = prior.generatedAt;
          record.draft.latencyMs = prior.latencyMs;
          record.draft.error = e.message || String(e);
          output.textContent = prior.text;
          copyButton.disabled = !prior.text;
          status.textContent = '生成失败：' + record.draft.error;
          if (check.inquiryId) { records[check.inquiryId] = record; try { saveShadowRecords(sync.workspace, records); } catch (e2) { /* 本机存储不可用 */ } }
        } finally {
          if (cur === 'shadow' && selected === index) draftButton.disabled = false;
          if (shadowStream === stream) shadowStream = null;
        }
      };
      copyButton.onclick = () => navigator.clipboard.writeText(draftText)
        .then(() => toast('草稿已复制，请先在平台核对')).catch(() => toast('复制失败'));

      saveButton.onclick = () => {
        if (!check.inquiryId) return;
        const reasons = Array.from(detail.querySelectorAll('[data-shadow-reason]:checked')).map((node) => node.value);
        const priorPlatform = record.platform || {};
        const platformStatus = detail.querySelector('#shadow-platform').value;
        const latestAt = detail.querySelector('#shadow-latest-at').value.trim();
        const latestId = detail.querySelector('#shadow-latest-id').value.trim();
        const checkedBy = detail.querySelector('#shadow-checker').value.trim();
        const samePlatform = platformStatus === (priorPlatform.status || '')
          && latestAt === (priorPlatform.latestBuyerMessageAt || '')
          && latestId === (priorPlatform.latestMessageId || '')
          && checkedBy === (priorPlatform.checkedBy || '');
        record.workspace = sync.workspace;
        record.platform = {
          status: platformStatus,
          latestBuyerMessageAt: latestAt,
          latestMessageId: latestId,
          checkedAt: samePlatform && priorPlatform.checkedAt ? priorPlatform.checkedAt : Date.now(),
          checkedBy,
        };
        record.review = {
          disposition: detail.querySelector('#shadow-disposition').value,
          quality: detail.querySelector('#shadow-quality').value,
          reasons,
          note: detail.querySelector('#shadow-note').value.trim(),
          reviewedAt: Date.now(),
        };
        const validation = SHADOW.validateReview(record);
        if (!validation.ok) {
          saveStatus.innerHTML = '<span style="color:#b91c1c">' + validation.errors.map(esc).join('；') + '</span>';
          return;
        }
        records[check.inquiryId] = record;
        try {
          saveShadowRecords(sync.workspace, records);
          localStorage.setItem(reviewerKey, record.platform.checkedBy);
          saveStatus.textContent = '已保存 ' + SHADOW.fmtTime(record.review.reviewedAt);
          refreshStats();
          const row = $('#view').querySelector('[data-shadow-row="' + index + '"]');
          if (row) {
            row.querySelector('[data-cell="platform"]').textContent = record.platform.status || '未核对';
            row.querySelector('[data-cell="disposition"]').textContent = record.review.disposition || '未评估';
            row.querySelector('[data-cell="draft"]').textContent = record.draft.text ? '已生成'
              : record.draft.error ? '失败' : '未生成';
          }
          toast('评估已保存');
        } catch (e) {
          saveStatus.textContent = '保存失败：本机存储不可用';
        }
      };
    };
    $('#view').querySelectorAll('[data-shadow-index]').forEach((button) => {
      button.onclick = () => show(Number(button.dataset.shadowIndex));
    });
  }

  // ---------------- 智能客服（询盘接待） ----------------
  const inboxRecordKey = (workspace) => INBOX_RECORD_PREFIX + encodeURIComponent(workspace);
  const inboxFactsKey = (workspace) => INBOX_FACTS_PREFIX + encodeURIComponent(workspace);
  const inboxKindText = (status) => ({ new: '首次询盘', buyer_replied: '买家新消息', waiting: '等待客户', replied: '已回复' }[status] || status || '未知');
  const inboxKindLabel = (item) => item && item.handledBySend ? '已发送待回读' : inboxKindText(item && item.status);

  function loadInboxRecords(workspace) {
    try { return INBOX.pruneRecords(JSON.parse(localStorage.getItem(inboxRecordKey(workspace)) || '{}') || {}, 500); }
    catch (e) { return {}; }
  }
  function saveInboxRecords(workspace, records) {
    localStorage.setItem(inboxRecordKey(workspace), JSON.stringify(INBOX.pruneRecords(records, 500)));
  }
  function latestInboxRecord(records, inquiryId, productionOnly) {
    return Object.values(records || {}).filter((record) => record.inquiryId === inquiryId
      && (!productionOnly || !record.test))
      .sort((a, b) => (b.sentAt || b.attemptedAt || 0) - (a.sentAt || a.attemptedAt || 0))[0] || null;
  }
  function latestInboxDraft(records, inquiryId, contextAt) {
    return Object.values(records || {}).filter((record) => record.inquiryId === inquiryId
      && record.status === 'draft' && record.contextAt === contextAt)
      .sort((a, b) => (b.attemptedAt || 0) - (a.attemptedAt || 0))[0] || null;
  }
  async function waitInboxResult(key, timeout) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const saved = (await chrome.storage.local.get(SMART_REPLY_RESULT_KEY))[SMART_REPLY_RESULT_KEY];
      if (saved && saved.key === key) {
        await chrome.storage.local.remove(SMART_REPLY_RESULT_KEY);
        return saved;
      }
      await wait(1500);
    }
    return null;
  }
  const inboxTestKey = (workspace) => INBOX_TEST_PREFIX + encodeURIComponent(workspace);
  function loadInboxTests(workspace) {
    try {
      const list = JSON.parse(localStorage.getItem(inboxTestKey(workspace)) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function saveInboxTests(workspace, list) {
    localStorage.setItem(inboxTestKey(workspace), JSON.stringify((list || []).slice(0, 200)));
  }
  async function waitInboxProbe(key, timeout) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const saved = (await chrome.storage.local.get(INBOX_PROBE_RESULT_KEY))[INBOX_PROBE_RESULT_KEY];
      if (saved && saved.key === key) {
        await chrome.storage.local.remove(INBOX_PROBE_RESULT_KEY);
        return saved;
      }
      await wait(1200);
    }
    return null;
  }
  async function waitInboxAutoTest(key, timeout, onProgress) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const saved = (await chrome.storage.local.get(INBOX_AUTOTEST_RESULT_KEY))[INBOX_AUTOTEST_RESULT_KEY];
      if (saved && saved.key === key) {
        if (onProgress) onProgress(saved);
        if (saved.done) {
          await chrome.storage.local.remove(INBOX_AUTOTEST_RESULT_KEY);
          return saved;
        }
      }
      await wait(2000);
    }
    return null;
  }

  async function loadInbox() {
    if (inboxTimer) { clearInterval(inboxTimer); inboxTimer = null; }
    if (inboxStream) { inboxStream.abort(); inboxStream = null; }
    $('#view').innerHTML = '<h2>智能客服 · 询盘接待</h2><div class="muted">读取本机询盘与聊天记录…</div>';
    const openingWorkspace = await DB.activeWorkspace();
    const [rows, sync, stageMap] = await Promise.all([
      DB.dataset(['inquiry', 'chat', 'customer', 'public_customer']),
      workspaceSync(),
      DB.stageMap(),
    ]);
    if (cur !== 'inbox') return;
    if (sync.workspace !== openingWorkspace || await DB.activeWorkspace() !== openingWorkspace) {
      $('#view').innerHTML = '<h2>智能客服 · 询盘接待</h2><div class="panel warn">工作区在读取期间发生变化，请重新进入本页。</div>';
      return;
    }
    if (!INBOX) {
      $('#view').innerHTML = '<h2>智能客服 · 询盘接待</h2><div class="panel warn">回复模块未加载，请重新加载扩展后再试。</div>';
      return;
    }
    const inquiryHealth = SYNC.health(sync.state, 'inquiry').status || '未知';
    const chatHealth = SYNC.health(sync.state, 'chat').status || '未知';
    const idx = ID ? ID.build(rows) : null;
    const closedIds = new Set(Object.entries(stageMap || {})
      .filter(([, stage]) => stage && ['已成交', '已流失', '无效询盘'].includes(stage.stage))
      .map(([id]) => id));
    const built = INBOX.buildQueue(rows.inquiry || [], rows.chat || [], {
      now: Date.now(),
      closedIds,
      sessionNamesOf: (inquiry) => {
        if (!idx) return [];
        const profile = idx.byUid.get(idx.uidOfInquiry(inquiry));
        return profile ? profile.chatSessions : [];
      },
      limit: 300,
    });
    let records = loadInboxRecords(sync.workspace);
    const reconciled = INBOX.reconcile(records, rows.chat || [], { now: Date.now() });
    if (reconciled.changed) {
      records = reconciled.records;
      try { saveInboxRecords(sync.workspace, records); } catch (e) { /* 本机存储不可用 */ }
    }
    const factsKey = inboxFactsKey(sync.workspace);
    const facts = localStorage.getItem(factsKey) || '';
    const difyCfg = await loadDifyCfg();
    const useDify = !!(difyCfg && difyCfg.enabled && difyCfg.baseUrl && difyCfg.apiKey);
    built.items.forEach((item) => {
      const record = latestInboxRecord(records, item.inquiryId, true);
      if (record && record.contextAt === item.contextAt && INBOX.SENT_STATUSES.includes(record.status)) {
        item.handledBySend = true;
        item.needsReply = false;
        item.status = 'waiting';
      }
    });
    const stats = INBOX.summarize(built.items, records, Date.now());
    let selected = -1;
    let filter = 'pending';
    let testMode = false;
    let inboxRefreshSendState = null;

    const kpiHtml = (current) => cards([
      ['待接待', '<span id="inbox-stat-pending">' + current.pending + '</span>', '现在需要回复'],
      ['首次询盘', '<span id="inbox-stat-new">' + current.newCount + '</span>', '尚无我方回复'],
      ['买家新消息', '<span id="inbox-stat-buyer">' + current.buyerReplied + '</span>', '回复后又追问'],
      ['高价值待接待', '<span id="inbox-stat-high">' + current.highValue + '</span>', 'L3 / L4 买家'],
      ['今日已发', '<span id="inbox-stat-sent">' + current.sentToday + '</span>', '人工确认后发送'],
      ['已确认送达', '<span id="inbox-stat-confirmed">' + current.confirmedToday + '</span>', '聊天记录已回读'],
      ['首响中位数', '<span id="inbox-stat-first">' + (current.medianFirstResponse == null ? '-' : current.medianFirstResponse + ' 分') + '</span>', '本机已入库聊天'],
    ]);

    $('#view').innerHTML = '<h2>智能客服 · 询盘接待</h2>'
      + '<div class="panel warn"><b>只接待已有询盘，发送必须人工确认</b>'
      + '<div class="muted">AI 只生成草稿，不会自动发送。发送前必须回到平台核对最新买家消息；价格、交期、认证、库存、付款等内容会被拦截，需员工改写后再发。自动接待尚未开启。</div>'
      + '<div class="muted">当前回复来源：<b>' + (useDify ? 'Dify 知识库' : '本机模型（未启用 Dify）') + '</b>。'
      + (useDify ? '查询包含询盘主题、产品、最近聊天和回复依据，不包含邮箱/电话。' : '可在「设置 → Dify 知识库」启用知识库回复。') + '</div></div>'
      + '<div id="inbox-kpi">' + kpiHtml(stats) + '</div>'
      + '<div class="panel"><b>数据状态：</b>询盘 ' + esc(inquiryHealth) + ' · 聊天 ' + esc(chatHealth)
      + '<div class="muted">队列来自本机已入库数据；浏览器关闭或平台未同步时不会更新。发送结果先记为“页面已发出”，等下一次聊天同步回读后才算“已确认送达”。</div>'
      + '<div class="bar" style="margin-top:10px"><button type="button" id="inbox-sync">立即更新平台数据</button>'
      + '<button type="button" id="inbox-reload" class="ghost">刷新本机队列</button>'
      + '<span id="inbox-sync-status" class="muted" aria-live="polite">共 ' + built.total + ' 条询盘，队列显示 '
      + built.items.length + ' 条，待接待 ' + stats.pending + ' 条</span></div></div>'
      + '<div class="panel"><div class="bar" id="inbox-filters">'
      + '<button type="button" class="ghost is-on" data-inbox-filter="pending">待接待</button>'
      + '<button type="button" class="ghost" data-inbox-filter="new">首次询盘</button>'
      + '<button type="button" class="ghost" data-inbox-filter="buyer">买家新消息</button>'
      + '<button type="button" class="ghost" data-inbox-filter="risk">含风险</button>'
      + '<button type="button" class="ghost" data-inbox-filter="denture">假牙需求</button>'
      + '<button type="button" class="ghost" data-inbox-filter="waiting">等待客户</button>'
      + '<button type="button" class="ghost" data-inbox-filter="all">全部</button>'
      + '<span class="muted">按优先级排序；正在编辑时不会自动刷新</span></div>'
      + '<div class="scroll"><table><thead><tr><th>优先级</th><th>客户</th><th>国家 / 等级</th><th>询盘</th>'
      + '<th>最新买家消息</th><th>风险</th><th>发送状态</th><th>操作</th></tr></thead><tbody>'
      + (built.items.length ? built.items.map((item, index) => {
        const record = latestInboxRecord(records, item.inquiryId, true) || latestInboxRecord(records, item.inquiryId);
        return '<tr data-inbox-row="' + index + '" data-inbox-kind="' + esc(item.status) + '"'
          + ' data-inbox-needs="' + (item.needsReply ? '1' : '0') + '"'
          + ' data-inbox-demand="' + esc(item.demand ? item.demand.type : 'other') + '"'
          + ' data-inbox-risk="' + (item.risks.length ? '1' : '0') + '">'
          + '<td><span class="chip ' + (item.priority === 'P0' ? 'high' : item.priority === 'P1' ? 'mid' : 'tag') + '">' + esc(item.priority) + '</span></td>'
          + '<td>' + esc(item.customer || item.company || '-') + '<div class="muted">' + esc(item.company || '') + '</div></td>'
          + '<td>' + esc(item.country || '-') + '<div class="muted">' + esc(item.level || '-') + '</div></td>'
          + '<td>' + esc(item.subject || item.product || '-') + '<div class="muted" data-cell="kind">' + esc(inboxKindLabel(item)) + '</div>'
          + (item.demand && item.demand.type !== 'other' ? '<div class="muted" style="color:#b45309">' + esc(item.demandLabel) + '</div>' : '') + '</td>'
          + '<td>' + esc(item.lastBuyerAt || '-') + '<div class="muted">' + esc(String(item.lastBuyerText || '').slice(0, 42) || '无客户消息') + '</div></td>'
          + '<td>' + (item.risks.length ? item.risks.map((risk) => '<span class="tag">' + esc(risk) + '</span>').join(' ') : '<span class="muted">无</span>') + '</td>'
          + '<td data-cell="send">' + esc(record ? INBOX.statusText(record.status) + (record.test ? '（测试）' : '') : '未发送') + '</td>'
          + '<td><button type="button" class="ghost" data-inbox-open="' + index + '">接待</button></td></tr>';
      }).join('') : '<tr><td colspan="8" class="muted">暂无询盘资料，请先在资料库完成导入。</td></tr>')
      + '</tbody></table></div></div>'
      + '<div class="panel" id="inbox-test-panel"><b>测试台</b>'
      + '<div class="muted">测试模式会跳过重复、冷却和日上限；测试发送记录会标记为测试，不计入正式统计。自动测试会真实发送到客户，请只选测试客户。</div>'
      + '<div class="bar" style="margin-top:8px"><label style="display:flex;gap:6px;align-items:center;cursor:pointer">'
      + '<input type="checkbox" id="inbox-test-mode"' + (testMode ? ' checked' : '') + '> 测试模式（允许重复发送）</label>'
      + '<button type="button" id="inbox-auto-test" class="ghost">自动测试已生成草稿</button>'
      + '<button type="button" id="inbox-test-export" class="ghost">导出测试记录</button>'
      + '<span id="inbox-test-status" class="muted">测试发送不影响正式计数</span></div>'
      + '<div id="inbox-test-results"></div></div>'
      + '<div id="inbox-detail" class="panel" aria-live="polite">选择一条询盘，查看聊天上下文并生成回复草稿。</div>';

    const refreshStats = () => {
      const next = INBOX.summarize(built.items, records, Date.now());
      const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
      set('inbox-stat-pending', next.pending);
      set('inbox-stat-new', next.newCount);
      set('inbox-stat-buyer', next.buyerReplied);
      set('inbox-stat-high', next.highValue);
      set('inbox-stat-sent', next.sentToday);
      set('inbox-stat-confirmed', next.confirmedToday);
      set('inbox-stat-first', next.medianFirstResponse == null ? '-' : next.medianFirstResponse + ' 分');
      built.items.forEach((item, index) => {
        const row = $('#view').querySelector('[data-inbox-row="' + index + '"]');
        if (!row) return;
        const record = latestInboxRecord(records, item.inquiryId, true) || latestInboxRecord(records, item.inquiryId);
        const cell = row.querySelector('[data-cell="send"]');
        if (cell) cell.textContent = record ? INBOX.statusText(record.status) + (record.test ? '（测试）' : '') : '未发送';
        const kindCell = row.querySelector('[data-cell="kind"]');
        if (kindCell) kindCell.textContent = inboxKindLabel(item);
        row.dataset.inboxNeeds = item.needsReply ? '1' : '0';
      });
    };

    const applyFilter = (kind) => {
      filter = kind;
      $('#view').querySelectorAll('[data-inbox-filter]').forEach((button) => {
        button.classList.toggle('is-on', button.dataset.inboxFilter === kind);
      });
      $('#view').querySelectorAll('[data-inbox-row]').forEach((row) => {
        const needs = row.dataset.inboxNeeds === '1';
        const rowKind = row.dataset.inboxKind;
        const show = kind === 'all' ? true
          : kind === 'pending' ? needs
            : kind === 'new' ? rowKind === 'new'
              : kind === 'buyer' ? rowKind === 'buyer_replied'
                : kind === 'risk' ? row.dataset.inboxRisk === '1' && needs
                  : kind === 'denture' ? (row.dataset.inboxDemand || '').indexOf('denture') === 0
                    : kind === 'waiting' ? rowKind === 'waiting' : true;
        row.hidden = !show;
      });
    };
    $('#view').querySelectorAll('[data-inbox-filter]').forEach((button) => {
      button.onclick = () => applyFilter(button.dataset.inboxFilter);
    });
    applyFilter(filter);

    const testResultsEl = $('#inbox-test-results');
    const renderTestResults = () => {
      const list = loadInboxTests(sync.workspace);
      testResultsEl.innerHTML = list.length
        ? '<div class="scroll" style="margin-top:8px"><table><thead><tr><th>时间</th><th>方式</th><th>客户</th><th>结果</th><th>说明</th></tr></thead><tbody>'
          + list.slice(0, 50).map((record) => '<tr><td>' + esc(record.atText || '') + '</td><td>'
            + esc(record.mode === 'probe' ? '只定位' : record.mode === 'manual' ? '手动测试' : '自动测试')
            + '</td><td>' + esc(record.customer || '')
            + '</td><td>' + (record.ok ? '成功' : '失败') + '</td><td>' + esc(record.error || '') + '</td></tr>').join('')
          + '</tbody></table></div>'
        : '<div class="muted" style="margin-top:6px">暂无测试记录。</div>';
    };
    const addInboxTest = (record) => {
      const list = loadInboxTests(sync.workspace);
      list.unshift(Object.assign({ at: Date.now(), atText: INBOX.fmtTime(Date.now()) }, record));
      try { saveInboxTests(sync.workspace, list); } catch (e) { /* ignore */ }
      renderTestResults();
    };
    renderTestResults();

    $('#inbox-test-mode').onchange = (event) => {
      testMode = !!event.currentTarget.checked;
      const status = $('#inbox-test-status');
      if (status) status.textContent = testMode
        ? '测试模式已开启：允许重复发送，记录标记为测试，不计入正式统计'
        : '测试发送不影响正式计数';
      if (inboxRefreshSendState) inboxRefreshSendState();
    };
    $('#inbox-test-export').onclick = () => {
      const list = loadInboxTests(sync.workspace);
      if (!list.length) { toast('暂无测试记录'); return; }
      const header = ['时间', '方式', '客户', '询盘ID', '结果', '说明'];
      const rows = list.map((record) => [record.atText || '',
        record.mode === 'probe' ? '只定位' : record.mode === 'manual' ? '手动测试' : '自动测试',
        record.customer || '', record.inquiryId || '', record.ok ? '成功' : '失败', record.error || '']);
      const csv = [header].concat(rows)
        .map((row) => row.map((value) => '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"').join(','))
        .join('\r\n');
      downloadText('智能客服测试记录_' + shadowStamp(new Date()) + '.csv', csv);
    };
    $('#inbox-auto-test').onclick = async (event) => {
      if (!testMode) { toast('请先勾选测试模式'); return; }
      const pool = built.items.map((item) => {
        const record = latestInboxDraft(records, item.inquiryId, item.contextAt);
        const text = record ? record.text : '';
        const safe = text ? INBOX.reviewDraft(text, item).ok : false;
        return { item, text: String(text || '').trim(), safe };
      }).filter((entry) => entry.item.session && entry.text && entry.safe);
      if (!pool.length) { toast('没有通过风险检查的已生成草稿'); return; }
      const raw = window.prompt('自动测试：要发送的客户数（最多 ' + pool.length + '）', String(Math.min(pool.length, 3)));
      if (raw === null) return;
      const count = Math.max(1, Math.min(pool.length, parseInt(raw, 10) || 1));
      const confirmed = window.confirm('将以测试模式向 ' + count + ' 个客户真实发送，间隔 3 秒。\n'
        + '测试记录不计入正式统计，但客户会收到消息。请确认这些是测试客户。继续？');
      if (!confirmed) return;
      const key = sync.workspace + '|' + Date.now();
      const items = pool.slice(0, count).map((entry) => ({
        customer: entry.item.session, text: entry.text,
        inquiryId: entry.item.inquiryId, contextAt: entry.item.contextAt,
      }));
      const statusEl = $('#inbox-test-status');
      const button = event.currentTarget;
      button.disabled = true;
      if (statusEl) statusEl.textContent = '自动测试已开始（0/' + items.length + '）…';
      try {
        await chrome.storage.local.remove(INBOX_AUTOTEST_RESULT_KEY);
        await chrome.storage.local.set({
          [INBOX_AUTOTEST_KEY]: { key, workspace: sync.workspace, items, gapMs: 3000, createdAt: Date.now() },
        });
        await chrome.tabs.create({ url: 'https://onetalk.alibaba.com/message/weblitePWA.htm?aliInboxAutoTest=1', active: true });
        const result = await waitInboxAutoTest(key, 10 * 60 * 1000, (progress) => {
          if (statusEl) statusEl.textContent = '自动测试进行中（' + (progress.index || 0) + '/' + progress.total + '）…';
        });
        if (!result) {
          if (statusEl) statusEl.textContent = '自动测试超时，请到聊天窗口核实是否已发送';
          return;
        }
        const results = result.results || [];
        results.forEach((entry, index) => {
          const source = items[index];
          if (!source) return;
          if (entry.ok) {
            const recordKey = INBOX.idempotencyKey({ inquiryId: source.inquiryId, contextAt: source.contextAt },
              source.text, sync.workspace);
            records[recordKey] = {
              key: recordKey, workspace: sync.workspace, inquiryId: source.inquiryId,
              customer: source.customer, session: source.customer, contextAt: source.contextAt,
              text: source.text, status: 'sent_page', test: true,
              sentAt: entry.at || Date.now(), attemptedAt: Date.now(), error: '',
            };
          }
          addInboxTest({ mode: 'auto', customer: source.customer, inquiryId: source.inquiryId,
            ok: !!entry.ok, error: entry.error || '' });
        });
        try { saveInboxRecords(sync.workspace, records); } catch (e) { /* ignore */ }
        refreshStats();
        const success = results.filter((entry) => entry.ok).length;
        if (statusEl) statusEl.textContent = '自动测试完成：成功 ' + success + ' / 失败 ' + (results.length - success);
        toast('自动测试完成：成功 ' + success + ' / 失败 ' + (results.length - success));
      } catch (e) {
        if (statusEl) statusEl.textContent = '自动测试失败：' + (e.message || e);
      } finally {
        button.disabled = false;
      }
    };

    $('#inbox-reload').onclick = () => loadInbox();
    $('#inbox-sync').onclick = (event) => {
      const status = $('#inbox-sync-status');
      const task = runPlatformSync({ button: event.currentTarget, status, full: false, kinds: ['inquiry', 'chat'] });
      Promise.resolve(task).then(() => {
        if (cur !== 'inbox') return;
        setTimeout(() => { if (cur === 'inbox' && selected < 0) loadInbox(); }, 2500);
      });
    };

    const detail = $('#inbox-detail');
    const show = (index) => {
      if (inboxStream) { inboxStream.abort(); inboxStream = null; }
      selected = index;
      const item = built.items[index];
      if (!item) return;
      const prior = latestInboxDraft(records, item.inquiryId, item.contextAt);
      let draftText = prior ? prior.text : '';
      const reviewHtml = (text) => {
        const review = INBOX.reviewDraft(text, item);
        return review.flags.length
          ? '<div class="panel warn" style="margin:8px 0 0"><b>发送前必须处理</b><ul>' + review.flags.map((flag) => '<li>' + esc(flag) + '</li>').join('') + '</ul></div>'
          : '<div class="muted" style="margin-top:6px">未发现价格、交期、认证、库存或付款承诺。</div>';
      };
      detail.innerHTML = '<h3 style="margin-top:0">' + esc(item.customer || item.company || '未命名客户')
        + (item.company && item.customer ? ' · ' + esc(item.company) : '') + '</h3>'
        + '<div class="muted">询盘 ID：' + esc(item.inquiryId) + ' · 状态：' + esc(inboxKindLabel(item))
        + ' · 历史回复状态：' + esc(item.replyStatus || '未知') + ' · 创建：' + esc(item.createdAt || '未知')
        + (item.ageHours == null ? '' : '（' + Math.round(item.ageHours) + ' 小时前）')
        + (item.firstResponseMinutes == null ? '' : ' · 首响：' + item.firstResponseMinutes + ' 分钟')
        + ' · 会话：' + esc(item.session || '未匹配') + '</div>'
        + (item.gaps.length ? '<div class="panel warn" style="margin:8px 0"><b>数据缺口</b><ul>'
          + item.gaps.map((gap) => '<li>' + esc(gap) + '</li>').join('') + '</ul></div>' : '')
        + (item.risks.length ? '<div style="margin:8px 0"><b>风险提示：</b>'
          + item.risks.map((risk) => '<span class="tag">' + esc(risk) + '</span>').join(' ') + '</div>' : '')
        + (item.demand && item.demand.type !== 'other'
          ? '<div style="margin:8px 0"><b>需求分类：</b><span class="tag">' + esc(item.demandLabel) + '</span></div>' : '')
        + '<div class="panel" style="background:#fafbfc"><b>最新买家消息</b>'
        + '<div class="muted">' + esc(item.lastBuyerAt || '无') + '</div>'
        + '<pre class="advice" style="max-height:160px;overflow:auto">' + esc(item.lastBuyerText || '暂无客户消息') + '</pre></div>'
        + '<div style="margin:10px 0"><b>最近对话</b>'
        + '<pre class="advice" style="max-height:260px;overflow:auto">'
        + esc(item.transcript.length ? item.transcript.map((message) =>
          message.at + (message.mine ? ' 业务员：' : ' 客户：') + message.text).join('\n') : '无聊天记录')
        + '</pre></div>'
        + '<div class="panel"><b>回复依据（本工作区，可选）</b>'
        + '<div class="muted">只填已核实的产品、公司或服务事实。模型只能引用这里的内容；留空时不得提及价格、参数、认证或交期。</div>'
        + '<textarea id="inbox-facts" rows="3" style="width:100%;margin-top:6px;padding:8px;border:1px solid #d1d5db;border-radius:8px;font:inherit">' + esc(facts) + '</textarea></div>'
        + '<div class="bar"><button type="button" id="inbox-generate">AI 生成回复</button>'
        + '<button type="button" class="ghost" id="inbox-stop" disabled>停止</button>'
        + '<button type="button" class="ghost" id="inbox-copy"' + (draftText ? '' : ' disabled') + '>复制草稿</button>'
        + '<span id="inbox-gen-status" class="muted">' + (item.session ? '草稿只发给已配置的模型，不传联系方式' : '未匹配到聊天会话：可生成草稿复制到询盘页，但不能从这里直接发送') + '</span></div>'
        + '<textarea id="inbox-draft" rows="6" placeholder="AI 草稿会显示在这里，可直接修改" style="width:100%;padding:10px;border:1px solid #cbd8e8;border-radius:8px;font:inherit;line-height:1.6">' + esc(draftText) + '</textarea>'
        + '<div id="inbox-review">' + (draftText ? reviewHtml(draftText) : '') + '</div>'
        + '<label style="display:flex;gap:8px;align-items:flex-start;margin:10px 0;font-size:13px">'
        + '<input type="checkbox" id="inbox-ack" style="margin-top:3px">'
        + '<span>我已回到平台核对最新买家消息和回复状态，确认这条回复仍然适用。</span></label>'
        + '<div class="bar"><button type="button" class="ghost" id="inbox-probe"' + (item.session ? '' : ' disabled') + '>只定位不发送</button>'
        + '<button type="button" class="ghost" id="inbox-open-chat"' + (item.session ? '' : ' disabled') + '>打开聊天窗口（不发送）</button>'
        + '<button type="button" id="inbox-send" disabled>确认发送</button>'
        + '<span id="inbox-send-status" class="muted"></span></div>'
        + '<div id="inbox-history"></div>';

      const factsEl = detail.querySelector('#inbox-facts');
      const draftEl = detail.querySelector('#inbox-draft');
      const reviewEl = detail.querySelector('#inbox-review');
      const ackEl = detail.querySelector('#inbox-ack');
      const generateButton = detail.querySelector('#inbox-generate');
      const stopButton = detail.querySelector('#inbox-stop');
      const copyButton = detail.querySelector('#inbox-copy');
      const sendButton = detail.querySelector('#inbox-send');
      const sendStatus = detail.querySelector('#inbox-send-status');
      const genStatus = detail.querySelector('#inbox-gen-status');
      const historyEl = detail.querySelector('#inbox-history');

      const updateReview = () => {
        const text = draftEl.value.trim();
        reviewEl.innerHTML = text ? reviewHtml(text) : '';
        const check = INBOX.canSend(item, text, records, {
          acknowledged: ackEl.checked,
          chatHealth,
          now: Date.now(),
          testMode,
        });
        sendButton.disabled = !check.ok;
        if (text && !check.ok) reviewEl.innerHTML += '<div class="muted" style="margin-top:4px">发送条件：'
          + check.errors.map(esc).join('；') + '</div>';
        copyButton.disabled = !text;
      };
      inboxRefreshSendState = updateReview;
      const saveDraft = (text, cfg, provider) => {
        const key = INBOX.idempotencyKey(item, text, sync.workspace);
        Object.keys(records).forEach((recordKey) => {
          if (records[recordKey].inquiryId === item.inquiryId && records[recordKey].status === 'draft' && recordKey !== key)
            delete records[recordKey];
        });
        records[key] = {
          key, workspace: sync.workspace, inquiryId: item.inquiryId,
          customer: item.customer, company: item.company, session: item.session,
          contextAt: item.contextAt, text, status: 'draft',
          provider: provider || 'model',
          model: (cfg && cfg.model) || '', promptVersion: INBOX.DRAFT_PROMPT_VERSION,
          attemptedAt: Date.now(),
        };
        try { saveInboxRecords(sync.workspace, records); } catch (e) { /* 本机存储不可用 */ }
        refreshStats();
      };
      const renderHistory = () => {
        const list = Object.values(records).filter((record) => record.inquiryId === item.inquiryId)
          .sort((a, b) => (b.sentAt || b.attemptedAt || 0) - (a.sentAt || a.attemptedAt || 0)).slice(0, 8);
        historyEl.innerHTML = list.length ? '<h3>发送记录</h3><div class="scroll"><table><thead><tr>'
          + '<th>时间</th><th>类型</th><th>状态</th><th>内容</th><th>说明</th></tr></thead><tbody>'
          + list.map((record) => '<tr><td>' + esc(INBOX.fmtTime(record.sentAt || record.attemptedAt))
            + '</td><td>' + (record.test ? '测试' : '正式')
            + '</td><td>' + esc(INBOX.statusText(record.status)) + '</td><td>'
            + esc(String(record.text || '').slice(0, 60)) + '</td><td>' + esc(record.error || '') + '</td></tr>').join('')
          + '</tbody></table></div>' : '';
      };
      renderHistory();

      factsEl.onchange = () => {
        try { localStorage.setItem(factsKey, factsEl.value.trim()); } catch (e) { /* ignore */ }
      };
      draftEl.oninput = updateReview;
      ackEl.onchange = updateReview;
      updateReview();

      generateButton.onclick = async () => {
        generateButton.disabled = true;
        stopButton.disabled = false;
        genStatus.textContent = useDify ? '正在通过 Dify 知识库生成回复…' : '正在生成回复…';
        draftEl.value = '';
        let stream = null;
        let cfg = null;
        let provider = useDify ? 'dify' : 'model';
        try {
          if (await DB.activeWorkspace() !== openingWorkspace) throw new Error('工作区已切换，请重新进入本页');
          if (useDify) {
            cfg = { model: 'dify' };
            if (cur !== 'inbox' || selected !== index) return;
            stream = DAI.openDifyStream(
              INBOX.difyQuery(item, { companyFacts: factsEl.value.trim() }),
              difyCfg,
              (delta) => {
                if (cur === 'inbox' && selected === index) {
                  draftEl.value += delta;
                  updateReview();
                }
              },
              { user: 'ali-' + sync.workspace }
            );
          } else {
            cfg = await loadAiCfg();
            if (cur !== 'inbox' || selected !== index) return;
            stream = DAI.openStream(INBOX.draftMessages(item, { companyFacts: factsEl.value.trim() }), cfg, (delta) => {
              if (cur === 'inbox' && selected === index) {
                draftEl.value += delta;
                updateReview();
              }
            });
          }
          inboxStream = stream;
          await stream.promise;
          if (cur !== 'inbox' || selected !== index) return;
          const text = draftEl.value.trim();
          if (!text) throw new Error('模型返回空草稿');
          saveDraft(text, cfg, provider);
          genStatus.textContent = '草稿完成（' + (provider === 'dify' ? 'Dify 知识库' : '本机模型')
            + '），请核对事实与平台最新消息后再发送';
          updateReview();
        } catch (e) {
          if (cur === 'inbox' && selected === index) genStatus.textContent = '生成失败：' + (e.message || String(e));
        } finally {
          if (cur === 'inbox' && selected === index) {
            generateButton.disabled = false;
            stopButton.disabled = true;
          }
          if (inboxStream === stream) inboxStream = null;
        }
      };
      stopButton.onclick = () => { if (inboxStream) { inboxStream.abort(); inboxStream = null; } };
      copyButton.onclick = () => navigator.clipboard.writeText(draftEl.value.trim())
        .then(() => toast('草稿已复制，请先在平台核对')).catch(() => toast('复制失败'));
      detail.querySelector('#inbox-probe').onclick = async () => {
        if (!item.session) return;
        const button = detail.querySelector('#inbox-probe');
        const key = sync.workspace + '|probe|' + item.inquiryId + '|' + Date.now();
        button.disabled = true;
        sendStatus.textContent = '正在打开聊天窗口并定位会话…';
        try {
          await chrome.storage.local.remove(INBOX_PROBE_RESULT_KEY);
          await chrome.storage.local.set({
            [INBOX_PROBE_KEY]: {
              key, workspace: sync.workspace, customer: item.session,
              inquiryId: item.inquiryId, createdAt: Date.now(),
            },
          });
          await chrome.tabs.create({ url: 'https://onetalk.alibaba.com/message/weblitePWA.htm?aliInboxProbe=1', active: true });
          const result = await waitInboxProbe(key, 60000);
          if (!result) {
            sendStatus.textContent = '定位超时：未收到聊天页结果';
            addInboxTest({ mode: 'probe', customer: item.session, inquiryId: item.inquiryId, ok: false, error: '定位超时' });
            return;
          }
          sendStatus.textContent = result.ok
            ? '已定位会话：' + item.session
            : '未定位：' + (result.error || '未知');
          addInboxTest({ mode: 'probe', customer: item.session, inquiryId: item.inquiryId,
            ok: !!result.ok, error: result.ok ? '' : (result.error || '') });
        } catch (e) {
          sendStatus.textContent = '定位失败：' + (e.message || e);
          addInboxTest({ mode: 'probe', customer: item.session, inquiryId: item.inquiryId,
            ok: false, error: e.message || String(e) });
        } finally {
          button.disabled = false;
        }
      };
      detail.querySelector('#inbox-open-chat').onclick = () => {
        if (!item.session) return;
        chrome.tabs.create({ url: 'https://onetalk.alibaba.com/message/weblitePWA.htm?aliChat=' + encodeURIComponent(item.session) });
      };

      sendButton.onclick = async () => {
        const text = draftEl.value.trim();
        const check = INBOX.canSend(item, text, records, {
          acknowledged: ackEl.checked,
          chatHealth,
          now: Date.now(),
          testMode,
        });
        if (!check.ok) {
          sendStatus.textContent = check.errors.join('；');
          return;
        }
        const confirmed = window.confirm((testMode ? '【测试模式】' : '')
          + '将向「' + (item.session || item.customer) + '」发送以下回复：\n\n'
          + text + '\n\n平台最新买家消息：' + (item.lastBuyerAt || '未知')
          + '\n\n发送后无法撤回，请确认已在平台核对。');
        if (!confirmed) return;
        const key = INBOX.idempotencyKey(item, text, sync.workspace);
        const currentRecord = latestInboxDraft(records, item.inquiryId, item.contextAt);
        records[key] = {
          key, workspace: sync.workspace, inquiryId: item.inquiryId,
          customer: item.customer, company: item.company, session: item.session,
          contextAt: item.contextAt, text, status: 'send_pending', test: testMode,
          model: (currentRecord && currentRecord.model) || '', promptVersion: INBOX.DRAFT_PROMPT_VERSION,
          sentAt: Date.now(), attemptedAt: Date.now(), error: '',
        };
        try { saveInboxRecords(sync.workspace, records); } catch (e) { /* ignore */ }
        sendButton.disabled = true;
        sendStatus.textContent = testMode ? '测试发送中，等待页面结果…' : '已打开聊天窗口，等待页面发送结果…';
        refreshStats();
        let sendOk = false;
        try {
          await chrome.storage.local.remove(SMART_REPLY_RESULT_KEY);
          await chrome.storage.local.set({
            [SMART_REPLY_KEY]: {
              kind: 'inquiry-reply', key, workspace: sync.workspace,
              customer: item.session, text, inquiryId: item.inquiryId, createdAt: Date.now(),
            },
          });
          await chrome.tabs.create({
            url: 'https://onetalk.alibaba.com/message/weblitePWA.htm?aliChat='
              + encodeURIComponent(item.session) + '&aliSmartReply=1',
            active: true,
          });
          const result = await waitInboxResult(key, 90000);
          if (result && result.ok) {
            records[key].status = 'sent_page';
            records[key].sentAt = result.at || Date.now();
            records[key].error = '';
            sendOk = true;
            sendStatus.textContent = testMode
              ? '测试发送已发出（不计入正式统计）；仍需到聊天窗口确认'
              : '页面已发出；等下一次聊天同步回读后才会显示“已确认送达”';
          } else if (result) {
            records[key].status = 'failed';
            records[key].error = result.error || '页面发送失败';
            sendStatus.textContent = '发送失败：' + records[key].error;
          } else {
            records[key].status = 'uncertain';
            records[key].error = '90 秒内未收到页面发送结果，请到聊天窗口核实是否已发出';
            sendStatus.textContent = records[key].error;
          }
        } catch (e) {
          records[key].status = 'failed';
          records[key].error = e.message || String(e);
          sendStatus.textContent = '发送失败：' + records[key].error;
        } finally {
          try { saveInboxRecords(sync.workspace, records); } catch (e) { /* ignore */ }
          const finalStatus = records[key].status;
          if (testMode) {
            addInboxTest({ mode: 'manual', customer: item.session, inquiryId: item.inquiryId,
              ok: sendOk, error: sendOk ? '' : (records[key].error || '') });
          } else if (finalStatus === 'sent_page' || finalStatus === 'uncertain' || finalStatus === 'confirmed') {
            item.handledBySend = true;
            item.needsReply = false;
            item.status = 'waiting';
          }
          refreshStats();
          applyFilter(filter);
          renderHistory();
          sendButton.disabled = false;
          updateReview();
        }
      };
    };
    $('#view').querySelectorAll('[data-inbox-open]').forEach((button) => {
      button.onclick = () => show(Number(button.dataset.inboxOpen));
    });

    if (inboxTimer) clearInterval(inboxTimer);
    if (cur !== 'inbox') return;
    inboxTimer = setInterval(() => {
      if (cur === 'inbox' && selected < 0 && !inboxStream && !testMode && !document.hidden) loadInbox();
    }, 120000);
  }

  // ---------------- 询盘线索 ----------------
  async function loadInquiry() {
    $('#view').innerHTML = '<h2>询盘线索</h2><div class="muted">加载中…</div>';
    const d = A.inquiry(await data());
    $('#view').innerHTML = '<h2>询盘线索</h2>'
      + concl(esc(d.headline), '加客率与成交率分开；成交只认已确认订单关联或员工填写依据的阶段')
      + cards(d.kpi)
      + '<h3>渠道线索（加客率不代表成交率）</h3><div class="panel">' + tbl(['来源', '询盘数', '已加客户', '加客率%', '高价值'], d.channel) + '</div>'
      + '<div class="grid2"><div class="panel"><div id="c-country" class="chart"></div></div>'
      + '<div class="panel"><div id="c-grade" class="chart"></div></div></div>'
      + '<h3>询盘明细（未加客 / 高价值已排前）</h3><div class="panel">'
      + tbl(['客户', '国家', '等级', '来源', '询盘时间', '已加客户', '状态依据', '未联系天数', '响应(分)', '主题'],
        d.rows.map((r) => [esc(r.name), r.country, r.grade, esc(r.source), r.created,
          esc(r.addedStatus), esc(r.addedEvidence), r.wait, r.resp, esc(r.subject)]), 60)
      + '</div>';
    chart('c-country', barKv('国家分布 Top10', d.country, true));
    chart('c-grade', barKv('买家等级分布（A/B 为高价值）', d.grade, false));
  }

  // ---------------- 客户资产 ----------------
  async function loadIdentity() {
    const d = await data();
    const idx = ID ? ID.build(d) : null;
    if (!idx) {
      $('#view').innerHTML = '<h2>身份统一</h2>' + concl('身份模块未加载，请重新加载扩展后再试。');
      return;
    }
    const s = idx.stats;
    const dup = idx.duplicateGroups.slice(0, 80);
    const allChatOnly = idx.chatOnly;
    const chatOnly = allChatOnly.slice(0, 80);
    $('#view').innerHTML = '<h2>身份统一</h2>'
      + concl('把询盘、我的客户、公海客户、聊天会话归并到同一个客户档案：优先按客户ID/邮箱/登录名/公司名匹配，姓名只作别名，避免把同名客户误合并。',
        '建议先看「合并后的重复客户」是否符合实际，再使用首页待办与回访建议')
      + cards([
        ['统一客户档案', s.profiles, '跨 4 类数据'],
        ['合并重复组', s.duplicateGroups, '同一客户多份资料'],
        ['已关联询盘', s.linkedInquiries + ' / ' + s.inquiries, '能对上客户档案'],
        ['已关联聊天会话', s.linkedChatSessions + ' / ' + s.chatSessions, '客户档案 ' + (s.linkedChatSessionsCrm || 0) + '，其余对询盘'],
        ['未匹配聊天', allChatOnly.length, '聊天有、客户库无'],
        ['客户别名', s.aliases, '用于搜索与匹配'],
      ])
      + '<h3>合并后的重复客户</h3>'
      + tbl(['客户', '公司', '客户ID', '询盘', '聊天', '来源'],
        dup.map((p) => [esc(p.display), esc(p.company || '-'), esc(p.customerIds.join(' / ') || '-'),
          p.inquiryIds.length, p.chatCount, Array.from(p.sources).join(' + ')]), 80)
      + '<h3>未匹配到客户的聊天会话</h3>'
      + tbl(['会话', '消息数', '最近消息'], chatOnly.map((p) => [esc(p.display), p.chatCount, esc(p.lastChat || '-')]), 80)
      + '<div class="muted" style="margin-top:10px;">匹配规则：客户ID / 完整邮箱 / 登录名 / 公司名相同即合并；脱敏邮箱（p***7@gmail.com）和 NA/nocompany 等占位值不参与身份判断；姓名、会话名只作别名，支持词序/变音符号差异，歧义时不自动合并。后续可在这里加人工确认与拆分。</div>';
  }
  async function loadCustomers() {
    $('#view').innerHTML = '<h2>客户资产</h2><div class="muted">加载中…</div>';
    const rows = await data();
    const d = A.customers(rows);
    const idx = ID.build(rows);
    const briefRows = (list) => list.map((c) => [esc(c.name), c.country, c.tier, c.member, esc(c.source), c.note]);
    $('#view').innerHTML = '<h2>客户资产</h2>'
      + concl(esc(d.headline), '口径：高价值 = 买家等级 L3/L4，或金牌买家、星标客户')
      + '<div class="panel" id="cp-panel"><h3 style="margin:0 0 8px;">客户主页</h3>'
      + '<div class="muted">搜索客户名或公司名，查看已入库的国家、行业线索、订单与询盘来源。每项都标记来源；缺口需要人工核实。</div>'
      + '<div class="bar" style="margin-top:12px;"><input id="cp-query" aria-label="搜索客户" placeholder="输入客户名或公司名" style="min-width:260px;flex:1;">'
      + '<button id="cp-find" type="button">查找客户</button><button id="cp-library" type="button" class="ghost">导入平台文件</button></div>'
      + '<div id="cp-result" class="muted" aria-live="polite"></div></div>'
      + cards(d.kpi)
      + '<div class="grid2"><div class="panel"><div id="c-mtier" class="chart"></div></div>'
      + '<div class="panel"><div id="c-ptier" class="chart"></div></div></div>'
      + '<h3>高价值客户（重点维护）</h3><div class="panel">' + tbl(['公司', '国家', '等级', '会员等级', '来源', '最近备注'], briefRows(d.hot), 40) + '</div>'
      + '<h3>流失预警（本周回访）</h3><div class="panel">' + tbl(['公司', '国家', '等级', '会员等级', '来源', '最近备注'], briefRows(d.risk), 40) + '</div>'
      + '<h3>公海可捡（高价值待领取）</h3><div class="panel">' + tbl(['公司', '国家', '等级', '会员等级', '来源', '最近备注'], briefRows(d.pubHot), 40) + '</div>'
      + '<div class="grid2"><div class="panel"><h3 style="margin-top:0;">我的客户 · 国家 Top</h3>' + tbl(['国家/地区', '数量'], d.mine.country) + '</div>'
      + '<div class="panel"><h3 style="margin-top:0;">我的客户 · 会员等级</h3>' + tbl(['会员等级', '数量'], d.mine.member) + '</div></div>';
    const showProfile = (p) => {
      const customerRows = rows.customer.filter((r) => idx.uidOfCustomer(r) === p.uid)
        .concat(rows.public_customer.filter((r) => idx.uidOfCustomer(r) === p.uid).map((r) => Object.assign({ 来源库: '公海' }, r)));
      const inquiryRows = rows.inquiry.filter((r) => idx.uidOfInquiry(r) === p.uid);
      const inquiryIds = new Set(inquiryRows.map((r) => String(r['询盘ID'] || '')).filter(Boolean));
      const orderRows = rows.order.filter((r) => idx.uidOfCustomer(r) === p.uid || inquiryIds.has(String(r['询盘ID'] || '')));
      const profile = CP.build(customerRows, inquiryRows, orderRows);
      const display = (f) => f && f.值 !== null ? esc(Array.isArray(f.值) ? f.值.join('、') : f.值) : '<span class="muted">未知</span>';
      const source = (f) => f && f.来源 ? esc(f.来源) : '待核实';
      const line = (name, f) => [esc(name), display(f), source(f), esc(f && f.说明 || '')];
      const detail = [
        line('公司', profile.公司), line('国家', profile.国家), line('行业线索', profile.行业线索),
        line('经营类型', profile.经营类型), line('订单数', profile.历史订单.订单数),
        line('已确认订单数', profile.历史订单.已确认订单数), line('已确认成交金额', profile.历史订单.已确认成交金额),
        line('购买总金额', profile.历史订单.购买总金额), line('买家订单总额($)', profile.历史订单.买家订单总额美元),
        line('询盘来源', profile.询盘来源), line('来源端', profile.来源端), line('客户来源', profile.客户来源),
        line('公司网站', profile.公司网站),
      ];
      const latestInquiry = inquiryRows.slice().sort((a, b) =>
        String(b['最新回复时间'] || b['创建时间'] || '').localeCompare(String(a['最新回复时间'] || a['创建时间'] || '')))[0];
      const latestOrder = orderRows.slice().sort((a, b) =>
        String(b['下单时间'] || '').localeCompare(String(a['下单时间'] || '')))[0];
      const statusLine = (name, row, field) => {
        const f = row && row.__fields && row.__fields[field] || {};
        return [esc(name), esc(row && !CORE.blank(row[field]) ? row[field] : '未知'),
          esc(f.来源 || '待核实'), esc(f.业务时间 || '—'), esc(f.采集时间 || '—')];
      };
      const mineRow = customerRows.find((r) => r.来源库 !== '公海');
      const publicRow = customerRows.find((r) => r.来源库 === '公海');
      const ownerRow = mineRow || publicRow;
      const ownerField = ownerRow && ownerRow.__fields && ownerRow.__fields['客户ID'] || {};
      const ownerStatus = mineRow && publicRow ? '待核实（我的客户和公海均存在）'
        : mineRow ? '我的客户' : publicRow ? '公海客户' : '未知';
      const statusRows = [['客户归属', esc(ownerStatus), esc(ownerField.来源 || '待核实'),
        esc(ownerField.业务时间 || '—'), esc(ownerField.采集时间 || '—')]];
      if (latestInquiry) statusRows.push(statusLine('最新询盘 · 是否已加为客户', latestInquiry, '是否已加为客户'),
        statusLine('最新询盘 · 回复状态', latestInquiry, '回复状态'));
      if (ownerRow) statusRows.push(statusLine('客户 · 跟进状态', ownerRow, '跟进状态'));
      if (latestOrder) statusRows.push(statusLine('最近订单 · 订单状态', latestOrder, '订单状态'));
      $('#cp-result').innerHTML = '<h3>' + esc(p.display) + '</h3>'
        + '<div class="muted">客户库 ' + customerRows.length + ' 条 · 询盘 ' + inquiryRows.length + ' 条 · 订单 ' + orderRows.length + ' 条</div>'
        + '<div style="margin:10px 0;padding:10px 12px;background:#eff5ff;border-radius:8px;">建议层级：<b>' + esc(profile.价值分层.层级) + '</b>'
        + (profile.价值分层.依据.length ? ' · 依据：' + esc(profile.价值分层.依据.join('、')) : ' · 暂无足够成交或高潜信号') + '</div>'
        + tbl(['字段', '当前数据', '来源', '说明'], detail)
        + '<h3>当前可变状态</h3>' + tbl(['字段', '状态', '来源', '业务时间', '采集时间'], statusRows)
        + '<div class="muted" style="margin-top:9px;">待补：' + esc(profile.缺失字段.join('、') || '关键字段已覆盖')
        + '。订单金额为累计字段时不按询盘相加；分层结果需员工核对。</div>'
        + (orderRows.length ? '<h3>最近订单</h3>' + tbl(['订单ID', '状态', '金额', '币种', '时间'],
          profile.历史订单.最近订单.map((o) => [esc(o.订单ID), esc(o.状态), esc(o.金额), esc(o.币种), esc(o.时间)])) : '')
        + (inquiryRows.length ? '<h3>机会阶段（员工核实后保存）</h3><div class="muted">“已成交”请填写订单号或核实依据；加为客户不等于成交。</div>'
          + inquiryRows.slice(0, 10).map((r) => {
            const iid = String(r['询盘ID'] || '');
            if (!iid) return '';
            const current = rows.stages[iid] || {};
            return '<div class="bar" style="margin:8px 0;"><span style="min-width:170px;">' + esc(r['创建时间'] || '') + ' · ' + esc(r['询盘主题'] || iid).slice(0, 38) + '</span>'
              + '<select data-stage-id="' + esc(iid) + '">' + DB.STAGE_VALUES.map((s) => '<option' + (current.stage === s ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select>'
              + '<input data-stage-note="' + esc(iid) + '" aria-label="阶段核实依据" placeholder="订单号、报价或流失依据" value="' + esc(current.evidence || '') + '" style="min-width:220px;flex:1;">'
              + '<button type="button" data-stage-save="' + esc(iid) + '">保存</button></div>';
          }).join('') : '');
      $('#cp-result').querySelectorAll('[data-stage-save]').forEach((b) => {
        b.onclick = async () => {
          const iid = b.dataset.stageSave;
          const stage = $('#cp-result').querySelector('[data-stage-id="' + CSS.escape(iid) + '"]').value;
          const note = $('#cp-result').querySelector('[data-stage-note="' + CSS.escape(iid) + '"]').value;
          try { await DB.setStage(iid, stage, note); rows.stages = await DB.stageMap(); invalidate(); showProfile(p); toast('阶段已保存'); }
          catch (err) { toast(err.message); }
        };
      });
    };
    const findProfile = () => {
      const q = ID.normalize($('#cp-query').value);
      if (!q) { $('#cp-result').textContent = '请输入客户名或公司名。'; return; }
      const matches = idx.profiles.filter((p) => [p.display, p.company].concat(p.aliasList || [])
        .some((v) => ID.normalize(v).includes(q))).slice(0, 20);
      if (!matches.length) { $('#cp-result').textContent = '本机资料库未找到客户。可在「资料库」导入已获得的客户或询盘文件。'; return; }
      if (matches.length === 1) { showProfile(matches[0]); return; }
      $('#cp-result').innerHTML = '<div class="muted">找到 ' + matches.length + ' 位候选，请选择：</div>'
        + matches.map((p, i) => '<button type="button" class="ghost" data-cp="' + i + '" style="margin:6px 6px 0 0;">' + esc(p.display) + (p.company ? ' · ' + esc(p.company) : '') + '</button>').join('');
      $('#cp-result').querySelectorAll('[data-cp]').forEach((b) => { b.onclick = () => showProfile(matches[Number(b.dataset.cp)]); });
    };
    $('#cp-find').onclick = findProfile;
    $('#cp-query').onkeydown = (e) => { if (e.key === 'Enter') findProfile(); };
    $('#cp-library').onclick = () => go('library');
    chart('c-mtier', {
      title: { text: '我的客户 ' + d.mine.total + ' · 买家分层', left: 0, textStyle: { fontSize: 13, color: '#374151' } },
      grid: { left: 8, right: 16, top: 34, bottom: 6, containLabel: true }, tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: d.mine.tiers.map((t) => t[0].split(' ')[0]) }, yAxis: { type: 'value' },
      series: [{ type: 'bar', data: d.mine.tiers.map((t) => t[1]), itemStyle: { color: '#7c3aed', borderRadius: 4 } }],
    });
    chart('c-ptier', {
      title: { text: '公海 ' + d.pub.total + ' · 买家分层', left: 0, textStyle: { fontSize: 13, color: '#374151' } },
      grid: { left: 8, right: 16, top: 34, bottom: 6, containLabel: true }, tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: d.pub.tiers.map((t) => t[0].split(' ')[0]) }, yAxis: { type: 'value' },
      series: [{ type: 'bar', data: d.pub.tiers.map((t) => t[1]), itemStyle: { color: '#0e7490', borderRadius: 4 } }],
    });
  }

  // ---------------- 展会通知 ----------------
  function expoFill(template, row) {
    const map = {
      name: row.name || 'there',
      company: row.company || '',
      country: row.country || '',
      exhibition: EXPO_STATE.exhibition || '',
      date: EXPO_STATE.date || '',
      venue: EXPO_STATE.venue || '',
      booth: EXPO_STATE.booth || '',
      sender: EXPO_STATE.sender || '',
    };
    return String(template || '').replace(/\{(name|company|country|exhibition|date|venue|booth|sender)\}/g,
      (_, key) => (map[key] === undefined ? '' : map[key]));
  }

  function expoCsvCell(v) {
    return '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
  }

  function renderExpoResults() {
    const summary = $('#expo-summary');
    const host = $('#expo-result');
    if (!summary || !host) return;
    const d = EXPO_RESULT;
    if (!d) { summary.innerHTML = ''; host.innerHTML = ''; return; }
    summary.innerHTML = cards([
      ['匹配客户', d.matched, d.country],
      ['有邮箱', d.withEmail, '可直接复制'],
      ['有电话', d.withPhone, '需人工核对'],
      ['高价值', d.hotCount, 'L3/L4 · 金牌 · 星标'],
    ]) + (d.missingCountry
      ? '<div class="muted" style="margin:8px 0 0;">另有 ' + d.missingCountry + ' 位客户未填写国家，未纳入国家筛选。</div>'
      : '');
    if (!d.rows.length) {
      host.innerHTML = '<h3>匹配客户</h3><div class="panel"><div class="muted">没有匹配客户。请更换国家、取消筛选，或先在「资料库」同步客户与询盘。</div></div>';
      return;
    }
    const shown = d.rows.slice(0, 200);
    host.innerHTML = '<h3>匹配客户（' + d.matched + '）</h3>'
      + (d.rows.length > shown.length ? '<div class="muted">页面显示前 ' + shown.length + ' 条；导出 CSV 包含全部 ' + d.rows.length + ' 条。</div>' : '')
      + '<div class="panel">' + tbl(
        ['客户/联系人', '公司', '国家', '等级', '来源', '邮箱', '电话', '最近询盘', '主题', '负责人', ''],
        shown.map((r) => [
          esc(r.name) + (r.hot ? ' <span class="tag">高价值</span>' : ''),
          esc(r.company || '-'), esc(r.country), esc(r.tier), esc(r.sources),
          esc(r.email || '-'), esc(r.phone || '-'), esc(r.inquiryAt || '-'),
          esc((r.subject || '').slice(0, 40)), esc(r.owner || '-'),
          '<button type="button" class="link" data-expo-copy="' + esc(r.uid) + '">复制话术</button>',
        ]), 200) + '</div>';
    host.querySelectorAll('[data-expo-copy]').forEach((button) => {
      button.onclick = () => {
        const row = d.rows.find((x) => x.uid === button.dataset.expoCopy);
        if (!row) return;
        navigator.clipboard.writeText(expoFill(EXPO_STATE.template, row))
          .then(() => toast('已复制 ' + row.name + ' 的展会话术'))
          .catch(() => toast('复制失败，请手动选中'));
      };
    });
  }

  function applyExpoFilters(rows) {
    if (rows !== EXPO_DATA || !EXPO_INDEX) {
      EXPO_DATA = rows;
      EXPO_INDEX = ID ? ID.build(rows) : null;
    }
    EXPO_RESULT = A.exhibition(rows, EXPO_STATE.country, {
      mineOnly: EXPO_STATE.mineOnly,
      hotOnly: EXPO_STATE.hotOnly,
      contactOnly: EXPO_STATE.contactOnly,
      idx: EXPO_INDEX,
      limit: 0,
    });
    renderExpoResults();
  }

  async function loadExpo() {
    $('#view').innerHTML = '<h2>展会通知</h2><div class="muted">加载中…</div>';
    // 展会通知只看客户与询盘，不加载聊天/订单/访客，避免 2 万多条聊天进入身份归并
    const rows = await DB.dataset(['inquiry', 'customer', 'public_customer']);
    if (cur !== 'expo') return;
    EXPO_DATA = rows;
    EXPO_INDEX = ID ? ID.build(rows) : null;
    const all = A.exhibition(rows, '', { idx: EXPO_INDEX, limit: 0 });
    if (!all.totalProfiles) {
      $('#view').innerHTML = '<h2>展会通知</h2>' + emptyHint();
      return;
    }
    if (EXPO_STATE.country && !all.countries.some((c) => c.key === EXPO_STATE.country)) EXPO_STATE.country = '';
    const options = ['<option value="">全部国家（' + all.totalProfiles + ' 位客户）</option>']
      .concat(all.countries.map((c) => '<option value="' + esc(c.key) + '"'
        + (c.key === EXPO_STATE.country ? ' selected' : '') + '>' + esc(c.label) + '（' + c.count + '）</option>'));
    $('#view').innerHTML = '<h2>展会通知</h2>'
      + concl('按国家筛选客户，生成展会通知名单与话术；本页只生成名单，不自动发送。',
        '发送前请核对客户关系与 DNC；L3 自动发送默认关闭。')
      + '<div class="panel"><h3 style="margin-top:0;">筛选与内容</h3>'
      + '<div class="bar">'
      + '<label class="expo-check">国家/地区 <select id="expo-country">' + options.join('') + '</select></label>'
      + '<label class="expo-check"><input type="checkbox" id="expo-mine"' + (EXPO_STATE.mineOnly ? ' checked' : '') + '> 仅我的客户</label>'
      + '<label class="expo-check"><input type="checkbox" id="expo-hot"' + (EXPO_STATE.hotOnly ? ' checked' : '') + '> 仅高价值</label>'
      + '<label class="expo-check"><input type="checkbox" id="expo-contact"' + (EXPO_STATE.contactOnly ? ' checked' : '') + '> 仅含邮箱/电话</label>'
      + '<button type="button" id="expo-apply">生成名单</button></div>'
      + '<div class="grid2">'
      + '<label class="expo-field">展会名称<input id="expo-name" value="' + esc(EXPO_STATE.exhibition) + '" placeholder="例如：Expodental Portugal 2026"></label>'
      + '<label class="expo-field">时间<input id="expo-date" value="' + esc(EXPO_STATE.date) + '" placeholder="例如：2026-11-20 10:00"></label>'
      + '<label class="expo-field">地点<input id="expo-venue" value="' + esc(EXPO_STATE.venue) + '" placeholder="例如：Lisboa Congress Centre"></label>'
      + '<label class="expo-field">展位<input id="expo-booth" value="' + esc(EXPO_STATE.booth) + '" placeholder="例如：B12"></label>'
      + '<label class="expo-field">署名<input id="expo-sender" value="' + esc(EXPO_STATE.sender) + '" placeholder="例如：Ray / TradePilot"></label>'
      + '</div>'
      + '<label class="expo-field" style="margin-top:10px;">话术模板<textarea id="expo-template" class="expo-template">' + esc(EXPO_STATE.template) + '</textarea></label>'
      + '<div class="muted">占位符：{name} {company} {country} {exhibition} {date} {venue} {booth} {sender}。发送前请人工确认内容，不承诺价格、交期、认证。</div>'
      + '<div class="bar" style="margin-top:10px;"><button type="button" id="expo-export">导出 CSV</button>'
      + '<button type="button" class="ghost" id="expo-copy-list">复制名单</button>'
      + '<button type="button" class="ghost" id="expo-copy-all">复制全部话术</button></div>'
      + '<div class="muted">CSV/复制只包含筛选结果；发送仍需在阿里聊天窗口逐条人工确认。</div></div>'
      + '<div id="expo-summary"></div><div id="expo-result"></div>';
    const readForm = () => {
      EXPO_STATE.country = $('#expo-country').value;
      EXPO_STATE.mineOnly = $('#expo-mine').checked;
      EXPO_STATE.hotOnly = $('#expo-hot').checked;
      EXPO_STATE.contactOnly = $('#expo-contact').checked;
      EXPO_STATE.exhibition = $('#expo-name').value.trim();
      EXPO_STATE.date = $('#expo-date').value.trim();
      EXPO_STATE.venue = $('#expo-venue').value.trim();
      EXPO_STATE.booth = $('#expo-booth').value.trim();
      EXPO_STATE.sender = $('#expo-sender').value.trim();
      EXPO_STATE.template = $('#expo-template').value;
    };
    const filter = () => { readForm(); applyExpoFilters(rows); };
    $('#expo-apply').onclick = filter;
    $('#expo-country').onchange = filter;
    ['expo-mine', 'expo-hot', 'expo-contact'].forEach((id) => { $('#' + id).onchange = filter; });
    ['expo-name', 'expo-date', 'expo-venue', 'expo-booth', 'expo-sender', 'expo-template'].forEach((id) => {
      $('#' + id).oninput = () => { readForm(); renderExpoResults(); };
    });
    $('#expo-export').onclick = () => {
      const d = EXPO_RESULT;
      if (!d || !d.rows.length) { toast('没有可导出的客户'); return; }
      const header = ['客户/联系人', '公司', '国家', '等级', '来源', '邮箱', '电话', '登录名', '最近询盘', '询盘主题', '产品', '负责人', '询盘ID', '客户ID', '展会话术'];
      const lines = [header].concat(d.rows.map((r) => [
        r.name, r.company, r.country, r.tier, r.sources, r.email, r.phone, r.login,
        r.inquiryAt, r.subject, r.product, r.owner, r.inquiryId, r.customerId,
        expoFill(EXPO_STATE.template, r),
      ]));
      const csv = lines.map((line) => line.map(expoCsvCell).join(',')).join('\r\n');
      const safe = String(d.country || '全部').replace(/[\\/:*?"<>|]/g, '_');
      downloadText('展会通知_' + safe + '_' + new Date().toISOString().slice(0, 10) + '.csv', csv);
    };
    $('#expo-copy-list').onclick = () => {
      const d = EXPO_RESULT;
      if (!d || !d.rows.length) { toast('没有可复制的客户'); return; }
      const lines = [['客户/联系人', '公司', '国家', '邮箱', '电话', '等级', '来源', '最近询盘', '主题', '负责人'].join('\t')]
        .concat(d.rows.map((r) => [r.name, r.company, r.country, r.email, r.phone, r.tier, r.sources, r.inquiryAt, r.subject, r.owner].join('\t')));
      navigator.clipboard.writeText(lines.join('\n'))
        .then(() => toast('已复制 ' + d.rows.length + ' 位客户名单'))
        .catch(() => toast('复制失败，请使用导出 CSV'));
    };
    $('#expo-copy-all').onclick = () => {
      const d = EXPO_RESULT;
      if (!d || !d.rows.length) { toast('没有可复制的话术'); return; }
      if (!confirm('将复制 ' + d.rows.length + ' 条话术；本页不会自动发送，仍需逐条人工确认。继续？')) return;
      const text = d.rows.map((r) => expoFill(EXPO_STATE.template, r)).join('\n\n---\n\n');
      navigator.clipboard.writeText(text)
        .then(() => toast('已复制 ' + d.rows.length + ' 条话术'))
        .catch(() => toast('复制失败，请缩小筛选范围'));
    };
    readForm();
    applyExpoFilters(rows);
  }

  function aiDialogHtml(id, title, note) {
    return '<section class="panel ai-dialog" id="' + id + '">'
      + '<div class="ai-dialog-head"><div><h3>' + esc(title) + '</h3><div class="muted">' + esc(note) + '</div></div>'
      + '<div class="ai-dialog-actions"><button type="button" class="ghost" data-ai-settings>设置模型</button>'
      + '<button type="button" data-ai-start>开始 AI 解读</button></div></div>'
      + '<div class="ai-dialog-log" data-ai-log aria-live="polite"></div>'
      + '<div class="ai-dialog-compose"><textarea data-ai-input rows="2" placeholder="继续追问，例如：哪项最值得先处理？"></textarea>'
      + '<button type="button" data-ai-send>发送</button><button type="button" class="ghost" data-ai-stop disabled>停止</button></div>'
      + '<div class="ai-dialog-status muted" data-ai-status>点击“开始 AI 解读”，或直接输入问题。</div></section>';
  }

  function mountAiDialog(id, kind, context, system, opening) {
    const host = $('#' + id);
    if (!host || !DAI) return;
    let state = AI_SESSIONS.get(kind);
    if (!state) {
      state = { messages: [], busy: false, stream: null, status: '点击“开始 AI 解读”，或直接输入问题。' };
      AI_SESSIONS.set(kind, state);
    }
    state.context = context;
    const log = host.querySelector('[data-ai-log]');
    const input = host.querySelector('[data-ai-input]');
    const start = host.querySelector('[data-ai-start]');
    const settings = host.querySelector('[data-ai-settings]');
    const sendButton = host.querySelector('[data-ai-send]');
    const stop = host.querySelector('[data-ai-stop]');
    const status = host.querySelector('[data-ai-status]');
    const render = () => {
      if (!host.isConnected) return;
      log.replaceChildren();
      state.messages.forEach((m) => {
        const row = document.createElement('div');
        row.className = 'ai-dialog-message ' + (m.role === 'user' ? 'is-user' : 'is-assistant');
        const label = document.createElement('strong');
        label.textContent = m.role === 'user' ? '我' : 'AI';
        const body = document.createElement('div');
        body.textContent = m.content || (state.busy && m === state.messages[state.messages.length - 1] ? '正在生成…' : '');
        row.append(label, body);
        log.appendChild(row);
      });
      log.scrollTop = log.scrollHeight;
      start.disabled = state.busy;
      start.textContent = state.messages.length ? '重新解读' : '开始 AI 解读';
      sendButton.disabled = state.busy;
      stop.disabled = !state.busy;
      status.textContent = state.status;
    };
    state.render = render;
    render();
    let queued = false;
    const refresh = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; state.render(); });
    };
    const ask = async (question, reset) => {
      const prompt = String(question || '').trim();
      if (!prompt || state.busy) return;
      state.busy = true;
      state.status = '正在连接模型…';
      render();
      let cfg;
      try {
        cfg = await loadAiCfg();
        if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) throw new Error('请先在“设置”中配置 AI 模型和 API Key');
      } catch (e) { state.busy = false; state.status = e.message; render(); return; }
      if (reset) state.messages = [];
      else input.value = '';
      const messages = [{ role: 'system', content: system + '\n\n【本机汇总数据】\n' + state.context },
        ...state.messages.slice(-12).map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: prompt }];
      const answer = { role: 'assistant', content: '' };
      state.messages.push({ role: 'user', content: prompt }, answer);
      state.status = '模型正在流式生成…';
      render();
      try {
        state.stream = DAI.openStream(messages, cfg, (delta) => { answer.content += delta; refresh(); });
        await state.stream.promise;
        state.status = '已完成，可以继续追问。';
      } catch (e) {
        if (!answer.content) {
          state.messages.splice(-2, 2);
          if (!reset && host.isConnected) input.value = prompt;
        }
        state.status = (answer.content ? '已保留收到的内容；' : '') + (e.message || String(e));
      } finally {
        state.stream = null;
        state.busy = false;
        state.render();
      }
    };
    start.onclick = () => ask(opening, true);
    settings.onclick = () => go('settings');
    sendButton.onclick = () => ask(input.value, false);
    input.onkeydown = (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendButton.click(); }
    };
    stop.onclick = () => { if (state.stream) state.stream.abort(); };
  }

  // ---------------- 需求词库 ----------------
  async function loadDemand() {
    $('#view').innerHTML = '<h2>需求词库</h2><div class="muted">加载中…</div>';
    if (cur !== 'demand') return;
    const rows = await data();
    if (cur !== 'demand') return;
    const d = A.demand(rows);
    const kws = d.searchTerms.map(([w, n]) => '<span class="kw">' + esc(w) + ' <b>' + n + '</b></span>').join('')
      || '<span class="muted">' + (d.visitorState === 'missing' ? '访客资料尚未入库，请同步访客数据。'
        : d.visitorState === 'empty' ? '访客资料已同步，目前没有访客记录。'
          : '已有访客记录，但搜索词字段为空。') + '</span>';
    $('#view').innerHTML = '<h2>需求词库</h2>'
      + aiDialogHtml('d-ai-dialog', 'AI 需求解读', '基于访客真实搜索词与询盘、聊天词频流式分析；可继续追问。')
      + concl(esc(d.headline), '访客词来自“进店来源词 / 搜索关键词”；询盘和聊天词是沟通语料，不能当作平台搜索量。'
        + (d.visitorLastImportAt ? ' 访客上次入库：' + esc(d.visitorLastImportAt) : ''))
      + cards(d.kpi)
      + '<div class="bar"><button type="button" id="d-visitor-sync">同步访客数据</button><span id="d-visitor-status" class="muted" aria-live="polite">无需手动下载</span></div>'
      + '<h3>买家在搜什么（访客搜索词，数字=出现次数）</h3><div class="panel"><div>' + kws + '</div></div>'
      + (d.searchTerms.length ? '<div class="panel"><div id="c-terms" class="chart" style="height:'
        + Math.max(260, Math.min(620, d.searchTerms.length * 24)) + 'px"></div></div>' : '')
      + '<div class="grid2"><div class="panel"><h3 style="margin-top:0;">询盘里提到的词</h3>' + tbl(['词', '次数'], d.inquiryWords) + '</div>'
      + '<div class="panel"><h3 style="margin-top:0;">聊天里客户提到的词</h3>' + tbl(['词', '次数'], d.chatWords) + '</div></div>';
    mountAiDialog('d-ai-dialog', 'demand', DAI.demandContext(d),
      '你是阿里国际站运营顾问。只根据提供的本机词频汇总分析，区分访客真实搜索词与询盘、聊天语料。没有访客词时不得声称掌握平台真实搜索量。先给可执行结论，后续问题继续对话；指出证据和缺口。产品标题、关键词应供员工核对，不编造搜索量或转化效果。',
      '请先解读需求变化，给出 3 个优先产品需求簇、可测试的长尾关键词和标题方向，并说明哪些结论缺少访客真实搜索词依据。');
    if (d.searchTerms.length) chart('c-terms', {
      title: { text: '访客搜索词 Top', left: 0, textStyle: { fontSize: 13, color: '#374151' } },
      grid: { left: 8, right: 40, top: 34, bottom: 6, containLabel: true }, tooltip: { trigger: 'axis' },
      xAxis: { type: 'value' },
      yAxis: { type: 'category', data: d.searchTerms.map((t) => t[0]).reverse(), axisLabel: { fontSize: 11 } },
      series: [{ type: 'bar', data: d.searchTerms.map((t) => t[1]).reverse(), itemStyle: { color: '#0d9488', borderRadius: 3 }, barMaxWidth: 14 }],
    });
    $('#d-visitor-sync').onclick = (e) => runPlatformSync({ button: e.currentTarget,
      status: $('#d-visitor-status'), full: false, kinds: ['visitor'] });
  }


  // ---------------- 资料库 ----------------
  async function loadLibrary() {
    const ws = await workspaces();
    $('#view').innerHTML = '<h2>资料库</h2>'
      + '<div class="panel import-guide"><b>① 选择员工与店铺工作区</b><div class="bar">'
      + '<select id="l-workspace" aria-label="员工与店铺工作区">' + ws.items.map((x) => '<option value="' + esc(x.id) + '"' + (x.id === ws.active ? ' selected' : '') + '>' + esc(x.label) + '</option>').join('') + '</select>'
      + '<input id="l-workspace-name" aria-label="新工作区名称" placeholder="新建：店铺 / 员工" maxlength="60">'
      + '<button class="ghost" id="l-workspace-add" type="button">新建工作区</button></div>'
      + '<div class="muted">导入和扩展导出的数据会进入当前工作区。切换阿里登录账号或店铺时，请先切换这里；各员工宜使用自己的浏览器配置。</div></div>'
      + '<div class="panel import-guide"><b>自动读取平台资料</b><div class="muted">首次安装分段导入客户、询盘、聊天、订单与近 30 天访客；完成后浏览器开启期间每 15 分钟检查增量，切换页面不影响任务。</div>'
      + '<div class="bar"><button id="l-platform" type="button">自动更新平台数据</button><button id="l-bind-account" class="ghost" type="button">绑定当前卖家账号</button><span id="l-platform-status" class="muted" aria-live="polite">准备中…</span></div>'
      + '<div id="l-account-status" class="muted">正在核对工作区绑定…</div></div>'
      + '<div id="l-source-health" class="panel import-guide" aria-live="polite">正在检查各数据源…</div>'
      + '<div id="l-readiness" class="panel import-guide" aria-live="polite">检查资料中…</div>'
      + '<div class="panel import-guide"><b>② 自动初始化与持续更新</b><div class="muted" style="margin-top:5px;">'
      + '首次安装会自动读取当前登录账号的数据并写入资料库；以后每 15 分钟自动检查更新，也可在今日待办手动刷新。本地按内容去重、按业务 ID 逐字段合并。'
      + '没有导出字段时，下载补录模板，在有权限查看的页面人工核实后填写。这里不会为补齐资料批量访问客户主页。</div></div>'
      + '<div class="bar"><button id="l-import">选择表格并预览</button>'
      + '<button class="ghost" id="l-template">下载补录模板</button>'
      + '<button class="ghost" id="l-order-template">下载订单模板</button>'
      + '<button class="ghost" id="l-sync">同步到本地客户背调</button>'
      + '<button class="ghost" id="l-export">导出数据备份(JSON)</button>'
      + '<button class="ghost" id="l-importJson">导入数据备份</button>'
      + '<button class="ghost" id="l-clear">清空全部</button>'
      + '</div>'
      + '<input id="l-file" type="file" accept=".xlsx,.xls,.csv" multiple style="display:none;">'
      + '<input id="l-file-json" type="file" accept=".json" style="display:none;">'
      + '<div id="l-preview" aria-live="polite"></div>'
      + '<div id="l-body"><div class="muted">加载中…</div></div>';
    $('#l-workspace').onchange = (e) => switchWorkspace(e.target.value);
    $('#l-platform').onclick = (e) => runPlatformSync({ button: e.currentTarget, status: $('#l-platform-status'), full: true });
    if (syncRunning) { syncStatus = $('#l-platform-status'); syncStatus.textContent = syncMessage; $('#l-platform').disabled = true; }
    workspaceSync().then(({ state }) => {
      const node = $('#l-platform-status');
      if (node && !syncRunning && !(lastProgress && lastProgress.status === 'running'))
        node.textContent = state.syncAt ? '当前工作区上次更新：' + state.syncAt : '当前工作区尚未完成首次初始化';
    });
    $('#l-bind-account').onclick = async (event) => {
      const button = event.currentTarget; button.disabled = true;
      let probe;
      try {
        const progress = (await chrome.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY];
        if (progress && progress.status === 'running') throw new Error('自动更新正在运行，请完成后再绑定账号');
        const workspace = await DB.activeWorkspace();
        probe = await openAccountProbe();
        const identity = await probe.read();
        const state = await SYNC.load(chrome.storage.local, workspace);
        if (state.fingerprint && state.fingerprint !== identity.fingerprint)
          throw new Error('该工作区已绑定另一个卖家账号；请新建或切换工作区');
        if (state.fingerprint) { toast('当前工作区已绑定该账号'); return; }
        const files = await DB.list();
        if (files.length && !window.confirm('当前工作区已有 ' + files.length + ' 个旧文件版本。请确认这些资料属于当前登录的卖家账号；绑定后会重新全量核对。继续？')) return;
        await SYNC.save(chrome.storage.local, workspace,
          { fingerprint: identity.fingerprint, boundAt: Date.now(), accountCount: identity.accountCount, accountError: '' });
        toast('已绑定当前卖家账号；正在重新全量更新');
        await renderLibrary();
        runPlatformSync({ button: $('#l-platform'), status: $('#l-platform-status'), full: true });
      } catch (e) { toast('绑定失败：' + e.message); }
      finally { if (probe) await probe.close(); button.disabled = false; }
    };
    $('#l-workspace-add').onclick = async () => {
      const progress = (await chrome.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY];
      if (progress && progress.status === 'running') { toast('数据更新中，完成后再新建工作区'); return; }
      const label = $('#l-workspace-name').value.trim();
      if (!label) { toast('请填写店铺 / 员工名称'); return; }
      const current = await workspaces();
      if (current.items.some((x) => x.label === label)) { toast('工作区名称已存在'); return; }
      const id = crypto.randomUUID();
      await chrome.storage.local.set({ [WORKSPACE_LIST_KEY]: [...current.items.filter((x) => x.id !== 'default'), { id, label }], [WORKSPACE_ACTIVE_KEY]: id });
      activeWorkspaceId = id; renderProgress(lastProgress);
      invalidate(); await loadStats(); go('library');
    };
    $('#l-import').onclick = () => $('#l-file').click();
    $('#l-template').onclick = () => downloadCsv('客户主页补录模板.csv', ['客户ID', '公司名称', '联系人', '国家/地区', '行业', '订单数', '客户来源', '询盘来源', '公司网站', '资料来源']);
    $('#l-order-template').onclick = () => downloadCsv('订单结果补录模板.csv', ['订单ID', '客户ID', '公司名称', '询盘ID', '订单状态', '成交金额', '币种', '下单时间', '资料来源']);
    $('#l-sync').onclick = async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = '同步中…';
      try {
        const r = await chrome.runtime.sendMessage({ type: 'syncToMcp' });
        if (!r || !r.ok) throw new Error(r && r.error || '同步失败');
        toast('已同步到本地客户背调：' + (r.results || []).map((x) => x.kind + ' ' + x.count).join(' · '));
      } catch (err) { toast('同步失败：' + err.message); }
      finally { b.disabled = false; b.textContent = '同步到本地客户背调'; }
    };
    $('#l-file').onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      const importWorkspace = await DB.activeWorkspace();
      e.target.value = '';
      const ready = [], bad = [];
      for (const f of files) {
        try {
          const buf = new Uint8Array(await f.arrayBuffer());
          const wb = XLSX.read(buf, { type: 'array' });
          let parsed = null;
          for (const sheet of wb.SheetNames) {
            const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '', raw: false });
            const pos = self.AliImportMap.headerRow(aoa);
            if (pos < 0) continue;
            const original = aoa[pos];
            const kind = self.AliImportMap.kind(original, f.name);
            if (!kind) continue;
            const header = self.AliImportMap.canonical(original).map((h) => {
              if (kind === 'inquiry' && h === '国家/地区') return '国家';
              if (kind === 'inquiry' && h === '询盘来源') return '来源';
              if (kind !== 'inquiry' && h === '来源') return '客户来源';
              return h;
            });
            let rows = aoa.slice(pos + 1).filter((r) => r && r.some((c) => c !== ''));
            const sourceRows = rows.length;
            if (kind === 'customer' || kind === 'public_customer') {
              const identifiers = ['客户ID', '公司名称', '联系人'].map((name) => header.indexOf(name)).filter((i) => i >= 0);
              rows = rows.filter((r) => identifiers.some((i) => String(r[i] || '').trim()));
            }
            if (kind === 'order') {
              const idCol = header.indexOf('订单ID');
              rows = rows.filter((r) => String(r[idCol] || '').trim());
            }
            if ((kind === 'customer' || kind === 'public_customer') && header.includes('资料来源')) {
              const sourceCol = header.indexOf('资料来源');
              rows.forEach((r) => { if (!String(r[sourceCol] || '').trim()) r[sourceCol] = '员工补录（待核实）'; });
            }
            parsed = { kind, header, rows, rejected: sourceRows - rows.length, sheet };
            break;
          }
          if (!parsed || !parsed.rows.length) { bad.push({ name: f.name, reason: '未识别类型或无有效行' }); continue; }
          ready.push({ name: f.name, ...parsed, mtime: new Date(f.lastModified).toISOString().slice(0, 19).replace('T', ' '), source: 'import' });
        } catch (err) { bad.push({ name: f.name, reason: err.message || '读取失败' }); }
      }
      const current = await data();
      const byKind = {};
      Object.keys(KINDS).forEach((kind) => {
        byKind[kind] = new Map((current[kind] || []).map((row) => [CORE.key(kind, row), { ...row }]).filter(([key]) => key));
      });
      ready.forEach((f) => {
        const tally = f.tally = { added: 0, updated: 0, duplicate: 0, unkeyed: 0 };
        f.rows.forEach((cells) => {
          const row = DB.toObj(f.header, cells);
          const key = CORE.key(f.kind, row);
          if (!key) { tally.unkeyed++; return; }
          const old = byKind[f.kind].get(key);
          if (!old) { tally.added++; byKind[f.kind].set(key, row); return; }
          const changed = Object.keys(row).some((field) => !CORE.blank(row[field]) && String(row[field]) !== String(old[field] || ''));
          if (changed) {
            tally.updated++;
            Object.keys(row).forEach((field) => { if (!CORE.blank(row[field])) old[field] = row[field]; });
          } else tally.duplicate++;
        });
      });
      const preview = $('#l-preview');
      preview.innerHTML = '<div class="panel import-preview"><h3 style="margin-top:0;">导入预览</h3>'
        + '<div class="muted">请核对识别字段与行数。新增/更新为预估，最终按文件时间和业务 ID 合并；没有业务 ID 的行需人工核对重复。</div>'
        + tbl(['文件 / 工作表', '类型', '新增ID', '可能更新', '重复', '无ID待核', '剔除', '已识别字段'], ready.map((f) => [esc(f.name) + ' / ' + esc(f.sheet), esc(KINDS[f.kind]),
          f.tally.added, f.tally.updated, f.tally.duplicate, f.tally.unkeyed, f.rejected,
          esc(f.header.filter((h) => self.AliImportMap.fields.includes(h)).join('、') || f.header.filter(Boolean).slice(0, 8).join('、'))]))
        + (bad.length ? '<div class="warn import-errors">未识别：' + bad.map((x) => esc(x.name) + '（' + esc(x.reason) + '）').join('；') + '</div>' : '')
        + '<div class="bar"><button id="l-confirm" type="button"' + (ready.length ? '' : ' disabled') + '>确认导入 ' + ready.length + ' 个文件</button>'
        + '<button id="l-cancel" class="ghost" type="button">取消</button></div></div>';
      $('#l-cancel').onclick = () => { preview.innerHTML = ''; };
      $('#l-confirm').onclick = async (ev) => {
        const button = ev.currentTarget; button.disabled = true;
        try {
          const result = await DB.ingestMany(ready, importWorkspace);
          const ok = result.results.filter((r) => !r.skipped).length;
          const skip = result.results.length - ok;
          invalidate(); await loadStats(); await renderLibrary();
          preview.innerHTML = '<div class="panel import-preview"><b>导入完成：</b>写入 ' + ok + ' 个文件版本，重复内容跳过 ' + skip + ' 个。'
            + (bad.length ? '<div class="import-errors">仍有 ' + bad.length + ' 个文件未识别，请检查列名后重试。</div>' : '') + '</div>';
          toast('导入完成');
        } catch (err) {
          button.disabled = false;
          preview.querySelector('.import-preview').insertAdjacentHTML('beforeend', '<div class="import-errors">导入失败，未写入本次文件：' + esc(err.message) + '</div>');
        }
      };
    };
    $('#l-export').onclick = async () => {
      const pack = await DB.exportJson();
      pack.version = 4;
      pack.accountFingerprint = (await workspaceSync()).state.fingerprint || '';
      const blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '外贸助手_数据备份_' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    };
    $('#l-importJson').onclick = () => $('#l-file-json').click();
    $('#l-file-json').onchange = async (e) => {
      const f = (e.target.files || [])[0]; if (!f) return;
      try {
        const pack = JSON.parse(await f.text());
        const state = (await workspaceSync()).state;
        if (state.fingerprint && !pack.accountFingerprint
          && !window.confirm('该旧备份没有卖家账号标识。请核实备份确属当前工作区绑定的店铺，确认后才会导入。继续？')) return;
        const allowUnverified = !!(state.fingerprint && !pack.accountFingerprint);
        const r = await DB.importJson(pack, { allowUnverified });
        invalidate(); loadStats(); renderLibrary(); toast('已导入 ' + r.imported + ' 个文件');
      } catch (err) { toast('导入失败：' + err.message); }
    };
    $('#l-clear').onclick = async () => {
      const progress = (await chrome.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY];
      if (progress && progress.status === 'running') { toast('数据更新中，完成后再清空'); return; }
      if (!confirm('确定清空本机全部已入库数据？（原始 xlsx 文件不受影响）')) return;
      const workspace = await DB.activeWorkspace();
      await DB.clearAll();
      await chrome.storage.local.remove(SYNC.key(workspace));
      invalidate(); loadStats(); renderLibrary(); toast('已清空当前工作区与同步状态');
    };
    renderLibrary();
  }
  async function renderLibrary() {
    const box = $('#l-body'); if (!box) return;
    const metas = await DB.list();
    const dataset = await data();
    const state = CORE.readiness(dataset);
    const { workspace, state: sync } = await workspaceSync();
    if (workspace !== await DB.activeWorkspace() || !$('#l-body')) return;
    const account = $('#l-account-status');
    if (account) account.textContent = sync.accountError ? '账号核对暂停：' + sync.accountError : sync.fingerprint
      ? '当前工作区已绑定卖家账号（本机指纹 ' + sync.fingerprint.slice(0, 8) + '…）；切换登录账号时请先切换工作区。'
      : metas.length ? '当前工作区有旧资料，尚未绑定卖家账号。请核对资料所属店铺后点击“绑定当前卖家账号”；此前自动更新已暂停。'
        : '空工作区将在首次平台更新时自动绑定当前卖家账号。';
    const sourceBox = $('#l-source-health');
    if (sourceBox) {
      const rows = PLATFORM_JOBS.map((job) => {
        const h = SYNC.health(sync, job.kind);
        const savedRows = (dataset[job.kind] || []).length;
        const last = h.lastSuccessMs ? new Date(h.lastSuccessMs).toLocaleString('zh-CN') : '—';
        const detail = [h.error, h.truncated && '达到采集安全上限', h.coverageGap && '较早历史未覆盖']
          .filter(Boolean).join('；') || '—';
        return [esc(job.label), esc(h.status), savedRows, Number(h.rowsThisRun || 0),
          h.expectedTotal == null ? '—' : Number(h.expectedTotal), esc(last),
          esc(h.latestBusinessAt ? new Date(h.latestBusinessAt).toLocaleString('zh-CN') : '—'),
          sync.cursors[job.kind] ? '第 ' + Number(sync.cursors[job.kind]) + ' 页' : '—', esc(detail)];
      });
      const latestProgress = (await chrome.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY];
      const retryMs = latestProgress && latestProgress.workspace === workspace && latestProgress.status === 'error'
        ? 60 * 60 * 1000 : 15 * 60 * 1000;
      const nextCheck = !sync.fingerprint ? (metas.length ? '等待核对并绑定卖家账号' : '等待首次登录与同步')
        : sync.bootstrapComplete && sync.syncAtMs
          ? new Date(Math.max(sync.syncAtMs + 15 * 60 * 1000, Number(sync.autoAttemptAt || 0) + retryMs)).toLocaleString('zh-CN')
          : '等待首次同步完成';
      sourceBox.innerHTML = '<b>各数据源更新与覆盖</b><div class="muted">预计下次增量检查：' + esc(nextCheck)
        + '（浏览器运行及登录有效时；调度可能延迟）。入库量按业务 ID 去重；平台总量是本轮查询口径，不能直接与跨时段入库量相减。“部分覆盖”和“历史缺口”不代表完整同步。</div>'
        + tbl(['数据源', '状态', '已入库', '本轮读取', '本轮平台总量', '采集完成', '已入库最新业务时间', '续读位置', '说明'], rows);
    }
    const lastByKind = {};
    metas.forEach((m) => {
      const day = String(m.mtime || '').slice(0, 10);
      if (!lastByKind[m.kind] || day > lastByKind[m.kind]) lastByKind[m.kind] = day;
    });
    const age = (s) => {
      const t = new Date(String(s || '').replace(' ', 'T')).getTime();
      return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : null;
    };
    const updates = ['inquiry', 'chat', 'customer', 'order'].map((k) => {
      const days = age(lastByKind[k]);
      return { kind: k, days, stale: days !== null && days > (k === 'customer' || k === 'order' ? 30 : 7) };
    });
    const readiness = $('#l-readiness');
    if (readiness) readiness.innerHTML = '<b>资料就绪：' + esc(state.level) + '</b>'
      + '<div class="muted">去重后：' + Object.entries(state.counts).map(([k, n]) => esc(k) + ' ' + n).join(' · ') + '</div>'
      + '<div class="muted">' + (state.missing.length ? '待补齐：' + state.missing.map(esc).join('、') : '关键资料已具备；仍请核实客户主页中标记为未知的字段。') + '</div>'
      + '<div class="freshness">' + updates.map((x) => '<span class="' + (x.stale ? 'stale' : '') + '">' + esc(KINDS[x.kind]) + '：'
        + (x.days === null ? '未导入' : '文件距今 ' + x.days + ' 天' + (x.stale ? ' · 请更新' : '')) + '</span>').join('') + '</div>'
      + '<div class="muted">新鲜度按文件最后修改时间提示；它不能替代平台记录的实际更新时间。</div>';
    if (!metas.length) { box.innerHTML = '<div class="panel"><b>还没有导入文件</b><div class="muted">先准备有权限导出的客户与询盘历史文件，选择表格预览后确认。订单和聊天资料可随后补齐。</div></div>'; return; }
    const cnt = {};
    metas.forEach((m) => { cnt[m.kind] = (cnt[m.kind] || 0) + 1; });
    box.innerHTML = '<div class="panel"><div class="muted" style="margin-bottom:8px;">已入库文件版本 · '
      + Object.keys(KINDS).map((k) => KINDS[k] + ' ' + (cnt[k] || 0)).join(' · ') + '</div>'
      + tbl(['文件名', '类型', '行数', '来源', '文件时间', '入库时间', '操作'],
        metas.map((m) => [esc(m.displayName || m.name), '<span class="tag">' + (KINDS[m.kind] || m.kind) + '</span>', m.rows,
          m.source === 'import' ? '手动导入' : m.source === 'local-mcp' ? '本机历史库' : '扩展导出', m.mtime, m.importedAt,
          '<button type="button" class="link" data-del="' + esc(m.name) + '">删除</button>'])) + '</div>';
    box.querySelectorAll('[data-del]').forEach((a) => {
      a.onclick = async () => {
        if (!confirm('确定从当前工作区删除这个文件版本？原始 Excel 文件不会被删除。')) return;
        await DB.removeFile(a.dataset.del); invalidate(); loadStats(); renderLibrary(); toast('已删除');
      };
    });
  }

  // ---------------- 投流诊断 ----------------
  async function loadAds() {
    const view = $('#view');
    view.innerHTML = '<div class="muted">加载中…</div>';
    if (!self.AliAdsInsight) { view.innerHTML = '<div class="muted">投流诊断模块未加载</div>'; return; }
    await self.AliAdsInsight.render(view, () => cur === 'ads');
  }

  // ---------------- 经营总览 ----------------
  async function loadStoreOverview() {
    $('#view').innerHTML = '<h2>经营总览</h2><div class="muted">加载中…</div>';
    const rows = await data();
    if (cur !== 'overview') return;
    const d = A.storeOverview(rows);
    if (!(rows.inquiry || []).length && !(rows.order || []).length) {
      $('#view').innerHTML = '<h2>经营总览</h2>' + emptyHint();
      return;
    }
    const funnel = d.funnel.map((s) => '<div class="funnel-row"><div class="funnel-label">' + esc(s.label) + '</div>'
      + '<div class="funnel-bar"><i style="width:' + (s.rate === null ? 0 : Math.max(2, Math.min(100, s.rate))) + '%"></i></div>'
      + '<div class="funnel-meta"><b>' + s.count + '</b><span>' + (s.rate === null ? '—' : s.rate + '%') + '</span></div></div>'
      + '<div class="funnel-hint">' + esc(s.hint) + '</div>').join('');
    const quality = d.quality.length ? d.quality.map((q) =>
      '<div class="q-row"><span class="chip ' + (q.level === 'high' ? 'high' : q.level === 'mid' ? 'mid' : 'tag') + '">'
      + (q.level === 'high' ? '高' : q.level === 'mid' ? '中' : '低') + '</span>'
      + '<b>' + esc(q.label) + '</b><span class="q-num">' + q.count + ' / ' + q.total + '</span>'
      + '<span class="muted">' + esc(q.hint) + '</span></div>').join('')
      : '<div class="muted">暂无明显资料缺口。</div>';
    $('#view').innerHTML = '<h2>经营总览</h2>'
      + aiDialogHtml('o-ai-dialog', 'AI 经营诊断', '基于本机六类资料汇总流式分析，可继续追问。')
      + concl(esc(d.headline), '生成时间 ' + esc(d.generatedAt)
        + ' · 只统计本机已导入资料；成交额按币种分开累计，订单数为已付款/已完成口径')
      + cards(d.kpis)
      + '<div class="grid2">'
      + '<div class="panel"><h3 style="margin-top:0;">询盘转化漏斗</h3>' + funnel + '</div>'
      + '<div class="panel"><h3 style="margin-top:0;">近 6 个月询盘与已确认订单</h3><div id="c-ov-trend" class="chart"></div></div>'
      + '</div>'
      + '<div class="grid2">'
      + '<div class="panel"><h3 style="margin-top:0;">询盘国家 Top</h3>' + (d.countries.length
        ? '<div id="c-ov-country" class="chart"></div>' : '<div class="muted">暂无国家数据</div>') + '</div>'
      + '<div class="panel"><h3 style="margin-top:0;">询盘来源 Top</h3>' + (d.sources.length
        ? '<div id="c-ov-source" class="chart"></div>' : '<div class="muted">暂无来源数据</div>') + '</div>'
      + '</div>'
      + '<h3>资料缺口</h3><div class="panel">' + quality + '</div>';
    mountAiDialog('o-ai-dialog', 'store', DAI.storeOverviewContext(d),
      '你是阿里巴巴国际站店铺经营顾问。只根据提供的本机汇总数据分析，区分事实、推断和数据缺口。成交额按币种分开，不跨币种相加；订单数不是询盘去重数；历史数据不代表平台实时状态。先给结论，再给按优先级排序的可执行动作和验证指标；不要编造平台大盘对比或行业均值。可继续回答员工追问。',
      '请解读这份经营总览：指出最影响成交的 2 个瓶颈、各自的数据依据、接下来 7 天可执行的动作，以及还需要补齐哪些资料。');
    chart('c-ov-trend', {
      grid: { left: 8, right: 14, top: 34, bottom: 6, containLabel: true },
      tooltip: { trigger: 'axis' },
      legend: { data: ['询盘', '已确认订单'], top: 0, textStyle: { fontSize: 11 } },
      xAxis: { type: 'category', data: d.trend.map((t) => t.label) },
      yAxis: [{ type: 'value', name: '询盘', nameTextStyle: { fontSize: 10 } },
        { type: 'value', name: '订单', nameTextStyle: { fontSize: 10 } }],
      series: [
        { name: '询盘', type: 'bar', data: d.trend.map((t) => t.inquiries), barMaxWidth: 26,
          itemStyle: { color: '#2f6fd0', borderRadius: 4 } },
        { name: '已确认订单', type: 'line', yAxisIndex: 1, data: d.trend.map((t) => t.orders),
          itemStyle: { color: '#0d9488' }, lineStyle: { width: 2 }, symbolSize: 6 },
      ],
    });
    const hBar = (id, list, color) => chart(id, {
      grid: { left: 8, right: 34, top: 8, bottom: 6, containLabel: true },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'value' },
      yAxis: { type: 'category', data: list.map((x) => x.name).reverse(), axisLabel: { fontSize: 11 } },
      series: [{ type: 'bar', data: list.map((x) => x.count).reverse(), barMaxWidth: 16,
        itemStyle: { color, borderRadius: 3 } }],
    });
    if (d.countries.length) hBar('c-ov-country', d.countries, '#2563eb');
    if (d.sources.length) hBar('c-ov-source', d.sources, '#7c3aed');
  }

  // ---------------- 复盘报表 ----------------
  async function loadReport() {
    $('#view').innerHTML = '<h2>复盘报表</h2><div class="muted">加载中…</div>';
    const rows = await data();
    if (cur !== 'report') return;
    const d = A.report(rows);
    if (!d.sections.length) { $('#view').innerHTML = '<h2>复盘报表</h2>' + emptyHint(); return; }
    $('#view').innerHTML = '<h2>复盘报表</h2>'
      + aiDialogHtml('r-ai-dialog', 'AI 复盘解读', '先看核心指标与行动建议，再查看明细报表；可流式追问。')
      + concl('完整分区（需要细看时来这里）', '生成时间 ' + d.generatedAt)
      + d.sections.map((s) => '<h3>' + esc(s.name) + '</h3><div class="panel">' + tbl(s.header.map(esc), s.rows.map((r) => r.map(esc)), 200) + '</div>').join('');
    mountAiDialog('r-ai-dialog', 'report', DAI.reportContext(d),
      '你是外贸业务复盘顾问。只根据提供的本机汇总指标判断，明确数据时间与口径。买家累计金额不是本店成交；已成交仅按已核实订单或有依据的阶段。历史“未联系天数”只供复盘，不能直接当作今日待办。输出事实、推断和资料缺口，并说明指标来自哪个报表分区。可继续回答员工追问；不要编造转化率改善或因果结论。',
      '请解读这份复盘报表：给出最值得员工先处理的 3 项问题、各自数据依据、可执行动作和需要补齐的数据。');
  }

  // ---------------- 设置 ----------------
  async function secureGet(key) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'secureGet', key: key });
      return (r && r.ok && r.value) || {};
    } catch (e) { return {}; }
  }
  async function secureSet(key, value) {
    const r = await chrome.runtime.sendMessage({ type: 'secureSet', key: key, value: value });
    if (!r || !r.ok) throw new Error((r && r.message) || '加密保存失败');
  }
  async function loadAiCfg() {
    return secureGet(AI_KEY);
  }
  async function loadDifyCfg() {
    return secureGet(DIFY_KEY);
  }
  async function aiChat(messages, cfg) {
    if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.model) throw new Error('还没配置模型：到「设置」里选预设并填 API Key');
    const res = await chrome.runtime.sendMessage({
      type: 'aiChat',
      url: String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.3 }),
    });
    if (!res) throw new Error('扩展后台无响应');
    if (!res.ok) {
      const t = String(res.text || res.error || '');
      if (res.status === 401) throw new Error('401：模型不认这个密钥（确认 API Key 与 Base URL 属于同一家）｜ ' + t.slice(0, 200));
      throw new Error('HTTP ' + (res.status || '') + ' ' + t.slice(0, 200));
    }
    const j = JSON.parse(res.text);
    return j.choices[0].message.content;
  }
  const maskKey = (k) => (!k ? '未填' : (k.length > 10 ? k.slice(0, 6) + '…' + k.slice(-4) : '已填'));
  async function loadSettings() {
    const c = await loadAiCfg();
    const d = await loadDifyCfg();
    const ws = await workspaces();
    const active = ws.items.find((x) => x.id === ws.active);
    const localBootKey = 'aliLocalBootstrapAt:' + encodeURIComponent(ws.active);
    const boot = await chrome.storage.local.get(localBootKey);
    const { state: platformState } = await workspaceSync();
    const problem = !c.apiKey ? '还没配置模型（下面选预设并填 API Key）' : null;
    $('#view').innerHTML = '<h2>设置</h2>'
      + '<div class="panel import-guide"><h3 style="margin-top:0;">平台数据自动初始化</h3>'
      + '<div class="muted">首次安装会在登录阿里国际站后，按顺序读取我的客户、公海客户、询盘、近 90 天聊天、订单和近 30 天访客，直接写入本机资料库；大量记录会分段续读。完成后浏览器开启期间每 15 分钟检查增量，我的客户每小时刷新，访客与公海每天刷新，订单每天补查较长时间范围。过程控制请求节奏；无需员工逐项下载。</div>'
      + '<div class="bar"><button id="s-platform" type="button">重新自动更新</button></div>'
      + '<div id="s-platform-status" class="muted" aria-live="polite">'
      + (platformState.syncAt ? '当前工作区上次平台更新：' + esc(platformState.syncAt) + ' · ' + esc((platformState.summary || []).join(' · ')) : '当前工作区尚未完成平台自动初始化') + '</div>'
      + '<div class="muted" style="margin-top:8px;">聊天首次读取近 90 天；历史缺口可用下方本机历史库迁入。平台未登录或页面结构变化时会暂停并显示原因。此功能不会自动发送客户消息。</div></div>'
      + '<div class="panel import-guide"><h3 style="margin-top:0;">首次数据导入</h3>'
      + '<div class="muted">当前工作区：<b>' + esc(active ? active.label : ws.active) + '</b>。此按钮会把<b>本机 MCP 历史资料库</b>中的客户、询盘、聊天、订单等资料一次迁入当前工作区，自动按业务 ID 匹配并显示缺口；不需要手动下载文件。</div>'
      + '<div class="bar"><button id="s-bootstrap" type="button">一键导入本机历史资料</button><button id="s-workspace" class="ghost" type="button">切换工作区</button></div>'
      + '<div id="s-bootstrap-status" class="muted" aria-live="polite">'
      + (boot[localBootKey] ? '当前工作区上次本机迁入：' + esc(boot[localBootKey]) : '当前工作区尚未从本机历史库迁入') + '</div>'
      + '<div class="muted" style="margin-top:8px;">此入口只迁入本机已有资料；上方自动初始化读取当前登录页面可见的账号资料。平台长期稳定同步仍取决于开放平台应用与接口权限。'
      + '<a href="https://openapi.alibaba.com/doc/doc.htm" target="_blank" rel="noopener">查看阿里开放平台接入要求</a>。</div></div>'
      + '<h3>AI 模型</h3>'
      + (problem ? '<div class="panel warn">⚠️ ' + esc(problem) + '</div>' : '')
      + '<div class="panel"><div class="muted">与扩展面板的「AI 设置（模型）」<b>共用同一份配置</b>（AES-256-GCM 加密保存在本机，仅扩展后台可解密），可用于需求词库和复盘报表顶部的流式 AI 对话。发送时只提供对应页面的汇总数据。</div>'
      + '<div class="muted" style="margin-top:6px;">当前生效：<b>' + esc(c.baseUrl || '未填') + '</b> · 模型 <b>' + esc(c.model || '未填') + '</b> · Key <b>' + esc(maskKey(c.apiKey)) + '</b></div>'
      + '<div class="bar" style="margin-top:10px;">预设<select id="s-preset">' + AI_PRESETS.map((p, i) => '<option value="' + i + '">' + p.label + '</option>').join('') + '</select>'
      + '<span class="muted">选预设会自动填 Base URL 与模型</span></div>'
      + '<div class="bar">Base URL <input id="s-url" value="' + esc(c.baseUrl || '') + '" style="width:360px"><span class="muted">服务商接口地址，如 https://api.deepseek.com/v1</span></div>'
      + '<div class="bar">API Key <input id="s-key" type="password" value="' + esc(c.apiKey || '') + '" style="width:360px"><span class="muted">密钥本身，通常以 sk- 开头（<b>不是</b>网址）</span></div>'
      + '<div class="bar">模型 <input id="s-model" value="' + esc(c.model || '') + '" style="width:240px"><span class="muted">如 deepseek-chat / qwen-plus</span></div>'
      + '<div class="bar"><button id="s-save">保存</button><button class="ghost" id="s-test">测试连接</button></div>'
      + '<div id="s-msg" class="muted" style="margin-top:6px;word-break:break-all;"></div></div>'
      + '<h3>Dify 知识库</h3>'
      + '<div class="panel"><div class="muted">智能客服生成回复时优先走 Dify 智能体；知识库检索与提示词在 Dify 端配置。API Key 仅存本机 chrome.storage.local。查询包含询盘主题、产品、最近聊天和回复依据，不包含邮箱/电话。</div>'
      + '<label style="display:flex;gap:8px;align-items:center;margin-top:10px;cursor:pointer"><input type="checkbox" id="d-enabled"' + (d.enabled ? ' checked' : '') + '> 启用 Dify 知识库</label>'
      + '<div class="bar" style="margin-top:8px">Base URL <input id="d-url" value="' + esc(d.baseUrl || 'https://api.dify.ai/v1') + '" style="width:360px"><span class="muted">Dify API 地址，通常以 /v1 结尾</span></div>'
      + '<div class="bar">API Key <input id="d-key" type="password" value="' + esc(d.apiKey || '') + '" style="width:360px"><span class="muted">以 app- 开头，只存本机；不要写进代码或文档</span></div>'
      + '<div class="bar">输入变量 <textarea id="d-inputs" rows="2" style="width:360px;padding:6px;border:1px solid #d1d5db;border-radius:8px;font:12px monospace;resize:vertical">' + esc(JSON.stringify(d.inputs || {})) + '</textarea><span class="muted">Dify 应用 Start 节点的必填变量，JSON；没有就保持 {}</span></div>'
      + '<div class="bar"><button id="d-save">保存 Dify</button><button class="ghost" id="d-test">测试 Dify</button></div>'
      + '<div id="d-msg" class="muted" style="margin-top:6px;word-break:break-all;"></div>'
      + '<div class="muted" style="margin-top:8px;">自建 Dify 首次测试会请求该域名访问权限。若应用是 Completion/文本生成而不是 Chatflow/Chatbot，请告知开发者切换接口。</div></div>'
      + '<div class="panel"><h3 style="margin-top:0;">数据与迁移</h3><div class="muted">'
      + '资料库默认保存在<b>本机浏览器 IndexedDB</b>；点击「同步到本地客户背调」后会复制到本机 MCP 服务。使用 AI 功能时，数据会按该功能发送给已配置的模型。<br>'
      + '换电脑：在「资料库」导出数据备份(JSON)，再到新电脑导入；也可以导入已有的 xlsx、xls、csv 文件。</div></div>';
    $('#s-workspace').onclick = () => go('library');
    $('#s-platform').onclick = (e) => runPlatformSync({ button: e.currentTarget, status: $('#s-platform-status'), full: true });
    if (syncRunning) { syncStatus = $('#s-platform-status'); syncStatus.textContent = syncMessage; $('#s-platform').disabled = true; }
    $('#s-bootstrap').onclick = async (e) => {
      const button = e.currentTarget;
      const status = $('#s-bootstrap-status');
      button.disabled = true; status.textContent = '读取本机历史库并核对来源…';
      try {
        const r = await chrome.runtime.sendMessage({ type: 'localBootstrapSnapshot' });
        if (!r || !r.ok) throw new Error(r && r.error || '无法连接本机历史库；请启动新版 MCP 服务');
        const sourceWorkspace = String(r.lastDatasetSync && r.lastDatasetSync.workspace || 'default');
        if (sourceWorkspace !== ws.active) throw new Error('历史库属于工作区 ' + sourceWorkspace + '，当前是 ' + ws.active + '；请先切换到对应工作区，避免混入其他店铺资料');
        const files = (r.datasets || []).filter((d) => Array.isArray(d.rows) && d.rows.length).map((d) => {
          const header = Array.from(new Set(d.rows.flatMap((row) => Object.keys(row || {}).filter((k) => !k.startsWith('__')))));
          const rows = d.rows.map((row) => header.map((key) => row[key] === undefined || row[key] === null ? '' : row[key]));
          const at = d.updatedAt ? new Date(d.updatedAt).toISOString().slice(0, 19).replace('T', ' ') : '';
          return { name: '本机历史资料_' + d.kind, kind: d.kind, header, rows, mtime: at, source: 'local-mcp' };
        });
        if (!files.length) throw new Error('本机历史库还没有可迁入的客户、询盘或聊天资料');
        status.textContent = '正在合并 ' + files.length + ' 类资料…';
        const result = await DB.ingestMany(files, ws.active);
        let stages = 0;
        for (const row of (r.datasets || []).find((d) => d.kind === 'inquiry')?.rows || []) {
          if (!row['询盘ID'] || !DB.STAGE_VALUES.includes(row['机会阶段']) || !row['阶段依据']) continue;
          await DB.setStage(row['询盘ID'], row['机会阶段'], row['阶段依据'], row['阶段时间'], '本机MCP历史库', ws.active);
          stages++;
        }
        const at = new Date().toLocaleString('zh-CN');
        await chrome.storage.local.set({ [localBootKey]: at });
        invalidate(); await loadStats();
        const state = CORE.readiness(await data());
        const written = result.results.filter((x) => !x.skipped).length;
        status.textContent = '已迁入 ' + written + ' 类文件版本，重复跳过 ' + (result.results.length - written)
          + ' 类，阶段 ' + stages + ' 条。资料状态：' + state.level + (state.missing.length ? '；待补：' + state.missing.join('、') : '。');
        toast('本机历史资料已匹配');
        if (state.level !== '待导入') setTimeout(() => { if (cur === 'settings') go('home'); }, 1800);
      } catch (err) { status.textContent = '迁入未完成：' + err.message; }
      finally { button.disabled = false; }
    };
    $('#s-preset').onchange = (e) => {
      const p = AI_PRESETS[+e.target.value]; if (!p) return;
      $('#s-url').value = p.baseUrl; $('#s-model').value = p.model;
    };
    $('#s-save').onclick = async () => {
      const cfg = { baseUrl: $('#s-url').value.trim(), apiKey: $('#s-key').value.trim(), model: $('#s-model').value.trim() };
      try {
        await secureSet(AI_KEY, cfg);
        if (String(cfg.apiKey).toLowerCase().startsWith('http')) $('#s-msg').innerHTML = '<span style="color:#b91c1c;">已加密保存，但 API Key 里看起来是网址：密钥（sk- 开头）填 API Key，网址填 Base URL</span>';
        else { toast('已加密保存'); $('#s-msg').textContent = '已加密保存，可点「测试连接」验证。'; }
      } catch (e) {
        $('#s-msg').innerHTML = '<span style="color:#b91c1c;">保存失败：' + esc(e.message) + '</span>';
      }
    };
    $('#s-test').onclick = async () => {
      $('#s-msg').textContent = '测试中…';
      try {
        const cfg = { baseUrl: $('#s-url').value.trim(), apiKey: $('#s-key').value.trim(), model: $('#s-model').value.trim() };
        const t = await aiChat([{ role: 'user', content: '只回复：你好' }], cfg);
        $('#s-msg').innerHTML = '<span style="color:#047857;">连接正常：' + esc(String(t).slice(0, 60)) + '</span>';
      } catch (e) { $('#s-msg').innerHTML = '<span style="color:#b91c1c;">' + esc(e.message) + '</span>'; }
    };
    $('#d-save').onclick = async () => {
      let inputs = {};
      const rawInputs = $('#d-inputs').value.trim();
      if (rawInputs) {
        try { inputs = JSON.parse(rawInputs); }
        catch (e) { $('#d-msg').textContent = '输入变量不是合法 JSON'; return; }
      }
      if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
        $('#d-msg').textContent = '输入变量必须是 JSON 对象，例如 {"customer_name": "Acme"}';
        return;
      }
      const cfg = {
        enabled: $('#d-enabled').checked,
        baseUrl: $('#d-url').value.trim(),
        apiKey: $('#d-key').value.trim(),
        inputs,
      };
      try {
        await secureSet(DIFY_KEY, cfg);
        $('#d-msg').textContent = cfg.apiKey && !cfg.apiKey.startsWith('app-')
          ? '已加密保存，但 Dify API Key 通常以 app- 开头，请确认。'
          : '已加密保存，可点「测试 Dify」验证。';
      } catch (e) {
        $('#d-msg').textContent = '保存失败：' + e.message;
      }
    };
    $('#d-test').onclick = async () => {
      const baseUrl = $('#d-url').value.trim();
      const apiKey = $('#d-key').value.trim();
      const msg = $('#d-msg');
      msg.textContent = '测试中…';
      try {
        if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Base URL 需以 http:// 或 https:// 开头');
        let inputs = {};
        const rawInputs = $('#d-inputs').value.trim();
        if (rawInputs) inputs = JSON.parse(rawInputs);
        if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs))
          throw new Error('输入变量必须是 JSON 对象');
        const origin = new URL(baseUrl).origin + '/*';
        if (!/^https:\/\/api\.dify\.ai/i.test(baseUrl)) {
          const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
          if (!granted) throw new Error('未授权访问 ' + origin + '；请在浏览器提示中允许');
        }
        const res = await chrome.runtime.sendMessage({ type: 'difyTest', baseUrl, apiKey, inputs });
        if (!res) throw new Error('扩展后台无响应');
        if (!res.ok) throw new Error(res.error || 'Dify 测试失败');
        msg.innerHTML = '<span style="color:#047857;">Dify 连接正常：' + esc(String(res.answer || '').slice(0, 80)) + '</span>';
      } catch (e) {
        msg.innerHTML = '<span style="color:#b91c1c;">' + esc(e.message || String(e)) + '</span>';
      }
    };
  }

  $('#mask').onclick = () => { $('#modal').classList.remove('on'); $('#mask').classList.remove('on'); };
  window.addEventListener('resize', () => Object.keys(charts).forEach((id) => charts[id].resize()));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[PROGRESS_KEY]) renderProgress(changes[PROGRESS_KEY].newValue);
    if (RUNNER_MODE) return;
    if (changes.aliDataChangedAt) {
      invalidate(); loadStats();
      if (cur === 'home') loadHome();
    }
    if (cur === 'library' && (changes.aliDataChangedAt || changes[SYNC.key(activeWorkspaceId)])) {
      clearTimeout(libraryRefreshTimer);
      libraryRefreshTimer = setTimeout(() => renderLibrary(), 300);
    }
  });
  const checkPlatformFreshness = async () => {
    if (syncRunning || document.visibilityState !== 'visible') return;
    const { workspace, state } = await workspaceSync();
    const empty = !(await DB.list()).length;
    if (!state.fingerprint && !empty) return;
    const progress = (await chrome.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY];
    const retryDelay = progress && progress.workspace === workspace && progress.status === 'error'
      ? 60 * 60 * 1000 : 15 * 60 * 1000;
    if ((state.bootstrapComplete && state.syncAtMs && Date.now() - state.syncAtMs < 15 * 60 * 1000)
      || Date.now() - Number(state.autoAttemptAt || 0) < retryDelay) return;
    const onLibrary = cur === 'library';
    runPlatformSync({ button: onLibrary ? $('#l-platform') : $('#home-refresh'),
      status: onLibrary ? $('#l-platform-status') : $('#home-sync-status'), full: !state.bootstrapComplete });
  };
  const checkAfterAction = () => {
    if (syncRunning || document.visibilityState !== 'visible') return;
    let pending;
    try { pending = JSON.parse(sessionStorage.getItem(TODO_RETURN_KEY) || 'null'); } catch (e) { return; }
    if (!pending) return;
    if (Date.now() - pending.at > 30 * 60 * 1000) { sessionStorage.removeItem(TODO_RETURN_KEY); return; }
    if (Date.now() - Number(pending.checkedAt || 0) < 30 * 1000) return;
    pending.checkedAt = Date.now();
    sessionStorage.setItem(TODO_RETURN_KEY, JSON.stringify(pending));
    setTimeout(() => {
      if (syncRunning || document.visibilityState !== 'visible') return;
      sessionStorage.removeItem(TODO_RETURN_KEY);
      runPlatformSync({ button: $('#home-refresh'), status: $('#home-sync-status'),
        full: false, kinds: pending.kinds });
    }, 1800);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { checkAfterAction(); checkPlatformFreshness(); }
  });
  window.addEventListener('focus', checkAfterAction);
  setInterval(checkPlatformFreshness, 10 * 60 * 1000);

  $('#platform-sync-dismiss').onclick = async () => {
    if (!lastProgress || lastProgress.status === 'running') return;
    const next = { ...lastProgress, dismissed: true };
    await chrome.storage.local.set({ [PROGRESS_KEY]: next });
    renderProgress(next);
  };
  // 版本更新：连接云端检查，由本机更新服务覆盖文件，然后重载扩展
  const checkUpdateBtn = $('#check-update');
  if (checkUpdateBtn) {
    checkUpdateBtn.onclick = async () => {
      if (checkUpdateBtn.disabled) return;
      const label = checkUpdateBtn.textContent;
      checkUpdateBtn.disabled = true;
      checkUpdateBtn.textContent = '检查中…';
      try {
        const r = await chrome.runtime.sendMessage({ type: 'extensionUpdateCheck' });
        if (!r || !r.ok) throw new Error((r && r.error) || '检查更新失败');
        if (!r.update) { toast('当前已是最新版本 v' + r.current); return; }
        const ok = window.confirm('发现新版本 v' + r.latest + '（当前 v' + r.current + '）。\n\n更新会覆盖扩展文件并自动重载，本机数据不会丢失。\n请确认现在没有正在发送的消息。\n\n是否立即更新？');
        if (!ok) return;
        checkUpdateBtn.textContent = '更新中…';
        const u = await chrome.runtime.sendMessage({ type: 'extensionUpdateApply' });
        if (!u || !u.ok) throw new Error((u && u.error) || '更新失败');
        if (!u.updated) { toast('当前已是最新版本 v' + (u.after || r.current)); return; }
        toast('已更新到 v' + (u.after || r.latest) + '，扩展即将重载…');
        setTimeout(() => { chrome.runtime.sendMessage({ type: 'extensionUpdateReload' }).catch(() => {}); }, 900);
      } catch (err) {
        toast((err && err.message) || '更新失败');
      } finally {
        checkUpdateBtn.disabled = false;
        checkUpdateBtn.textContent = label;
      }
    };
  }
  navBar(); loadStats();
  (async () => {
    activeWorkspaceId = await DB.activeWorkspace();
    let progress = (await chrome.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY];
    if (!RUNNER_MODE && progress && progress.status === 'running' && Date.now() - Number(progress.at || 0) > 30 * 1000) {
      let alive = false;
      try { alive = !!(progress.runnerTabId && await chrome.tabs.get(progress.runnerTabId)); } catch (e) { /* ignore */ }
      if (!alive) {
        progress = { ...progress, status: 'error', message: '上次更新任务已中断，可重新点击自动更新', dismissed: false, at: Date.now() };
        await chrome.storage.local.set({ [PROGRESS_KEY]: progress });
      }
    }
    renderProgress(progress);
    if (RUNNER_MODE) {
      const kinds = (runnerParams.get('kinds') || '').split(',').filter((x) => PLATFORM_JOBS.some((job) => job.kind === x));
      await runPlatformSync({ full: runnerParams.get('full') === '1', kinds });
      const tab = await chrome.tabs.getCurrent().catch(() => null);
      if (tab && tab.id != null) await chrome.tabs.remove(tab.id).catch(() => {});
      return;
    }
    // 每日投流同步：后台标签打开后直接进入投流诊断并自动采集，完成后自动关闭
    if (new URLSearchParams(location.search).get('adsAuto') === '1') {
      await go('ads');
      return;
    }
    const metas = await DB.list();
    const empty = !metas.length;
    if (location.hash === '#library' || empty) await go('library');
    else await loadHome();
    const { workspace, state } = await workspaceSync();
    if (!state.fingerprint && !empty) return;
    const progressNow = (await chrome.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY];
    const elapsed = Date.now() - Number(state.syncAtMs || 0);
    const tried = Date.now() - Number(state.autoAttemptAt || 0);
    const retryDelay = progressNow && progressNow.workspace === workspace && progressNow.status === 'error'
      ? 60 * 60 * 1000 : 15 * 60 * 1000;
    if (tried < retryDelay) return;
    if (empty || !state.bootstrapComplete || elapsed > 15 * 60 * 1000) {
      const onLibrary = cur === 'library';
      const button = onLibrary ? $('#l-platform') : $('#home-refresh');
      const status = onLibrary ? $('#l-platform-status') : $('#home-sync-status');
      runPlatformSync({ button, status, full: empty || !state.bootstrapComplete });
    }
  })().catch((e) => { console.error('工作台初始化失败', e); go('library'); });
})();
