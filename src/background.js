// MV3 后台：① 下载文件（改名） ② 代理跨域请求（带 cookie） ③ 数据入库 + 打开看板 ④ AI 流式转发
importScripts('db.js', 'sse.js'); // self.AliDB（数据层） / self.AliSSE（SSE 流式）

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // 打开数据看板（扩展内置页，无需任何本地服务）
  if (msg.type === 'openDashboard') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    sendResponse({ ok: true });
    return;
  }

  // 导出成功后把数据写入 IndexedDB（content script 在页面源下，写不到扩展的库，所以走后台）
  if (msg.type === 'ingest') {
    (async () => {
      try {
        const r = await self.AliDB.ingest(msg.file);
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
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
        });
        const text = await r.text();
        sendResponse({ ok: r.ok, status: r.status, text });
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
