// 云端上传队列（outbox）：采集入库后先落本机，成功提交到云端才出队
// 约束：串行上传、失败退避、断网续传；不在页面侧发起任何请求
(function () {
  'use strict';

  const CONFIG_KEY = 'aliCloudConfig';
  const QUEUE_KEY = 'aliCloudOutbox';
  const STATUS_KEY = 'aliCloudSyncStatus';
  const PART_SIZE = 200;          // 单个分片行数（与服务端上限 5000 留足余量）
  const ITEM_MAX_ROWS = 5000;     // 单条队列项最大行数，超出拆成多条
  const MAX_QUEUED_ROWS = 20000;  // 队列总量上限，超出丢弃最旧的
  const MAX_ITEMS_PER_RUN = 2;    // 单次 drain 最多处理 2 条，避免 SW 被回收
  const DEFAULTS = { enabled: false, baseUrl: '', token: '', sellerId: '' };

  function normalizeConfig(raw) {
    const c = Object.assign({}, DEFAULTS, raw || {});
    return {
      enabled: !!c.enabled,
      baseUrl: String(c.baseUrl || '').trim().replace(/\/+$/, ''),
      token: String(c.token || '').trim(),
      sellerId: String(c.sellerId || '').trim(),
    };
  }

  async function loadConfig() {
    if (typeof chrome === 'undefined' || !chrome.storage) return normalizeConfig(null);
    const data = await chrome.storage.local.get(CONFIG_KEY);
    return normalizeConfig(data && data[CONFIG_KEY]);
  }

  async function saveConfig(raw) {
    const cfg = normalizeConfig(raw);
    await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
    return cfg;
  }

  // 稳定键：平台有业务主键的用主键；聊天没有稳定消息 ID，用低置信度哈希
  function hash64(text) {
    let h1 = 0x811c9dc5;
    let h2 = 0xc2b2ae35;
    const s = String(text === undefined || text === null ? '' : text);
    for (let i = 0; i < s.length; i += 1) {
      const code = s.charCodeAt(i);
      h1 ^= code;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= code + i;
      h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }

  function valueOf(row, keys) {
    for (const k of keys) {
      const v = row ? row[k] : '';
      if (v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim() !== '-') return String(v).trim();
    }
    return '';
  }

  function rowKey(kind, row) {
    if (kind === 'inquiry') {
      const id = valueOf(row, ['询盘ID']);
      if (id) return 'inquiry:' + id;
    } else if (kind === 'customer' || kind === 'public_customer') {
      const id = valueOf(row, ['客户ID']);
      if (id) return kind + ':' + id;
    } else if (kind === 'order') {
      const id = valueOf(row, ['订单ID']);
      if (id) return 'order:' + id;
    } else if (kind === 'visitor') {
      const id = valueOf(row, ['访客ID', '统计日期']);
      if (id) return 'visitor:' + id;
    } else if (kind === 'chat') {
      // 聊天导出无稳定消息 ID：会话+时间+发言人+内容 的哈希，仅作低置信度临时键
      const text = [valueOf(row, ['会话']), valueOf(row, ['发送时间']), valueOf(row, ['发言人']), valueOf(row, ['内容'])].join('\u0001');
      return 'chat:' + hash64(text);
    }
    return kind + ':' + hash64(JSON.stringify(row || {}));
  }

  function parseTime(v) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!s) return null;
    const fixed = s.replace(/\//g, '-');
    const t = Date.parse(fixed);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }

  function businessAtOf(kind, row) {
    if (kind === 'inquiry') return parseTime(valueOf(row, ['创建时间']));
    if (kind === 'customer' || kind === 'public_customer') return parseTime(valueOf(row, ['创建时间', '领取时间']));
    if (kind === 'chat') return parseTime(valueOf(row, ['发送时间']));
    if (kind === 'order') return parseTime(valueOf(row, ['下单时间', '创建时间']));
    if (kind === 'visitor') return parseTime(valueOf(row, ['统计日期', '日期']));
    return null;
  }

  function toPayloadRows(kind, rows) {
    return (rows || []).map((row) => ({
      platform_id: rowKey(kind, row),
      payload: row,
      business_at: businessAtOf(kind, row),
    }));
  }

  function chunkRows(rows, size) {
    const step = Math.max(1, Number(size) || PART_SIZE);
    const out = [];
    for (let i = 0; i < (rows || []).length; i += step) out.push(rows.slice(i, i + step));
    return out;
  }

  function backoffMs(attempts) {
    const n = Math.max(1, Number(attempts) || 1);
    return Math.min(60 * 60 * 1000, 60 * 1000 * Math.pow(2, n - 1));
  }

  // 队列上限：丢弃最旧的项，返回 { list, dropped, droppedRows }
  function applyQueueCap(list, maxRows) {
    const cap = Math.max(0, Number(maxRows) || MAX_QUEUED_ROWS);
    const items = (list || []).slice();
    let total = items.reduce((s, it) => s + (it.rows ? it.rows.length : 0), 0);
    let dropped = 0;
    let droppedRows = 0;
    while (items.length && total > cap) {
      const it = items.shift();
      dropped += 1;
      droppedRows += it.rows ? it.rows.length : 0;
      total -= it.rows ? it.rows.length : 0;
    }
    return { list: items, dropped: dropped, droppedRows: droppedRows };
  }

  async function readQueue() {
    const data = await chrome.storage.local.get(QUEUE_KEY);
    return Array.isArray(data && data[QUEUE_KEY]) ? data[QUEUE_KEY] : [];
  }

  async function writeQueue(list) {
    await chrome.storage.local.set({ [QUEUE_KEY]: list });
  }

  async function writeStatus(patch) {
    const prev = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] || {};
    await chrome.storage.local.set({ [STATUS_KEY]: Object.assign({}, prev, patch, { at: Date.now() }) });
  }

  async function enqueue(file, options) {
    const opts = options || {};
    if (!file || !Array.isArray(file.rows) || !file.rows.length) return { ok: false, reason: 'empty' };
    const cfg = await loadConfig();
    if (!opts.force && !cfg.enabled) return { ok: false, reason: 'disabled' };
    // 入队即转成服务端契约行，上传时不再二次转换
    const rows = toPayloadRows(file.kind, file.rows);
    const pieces = chunkRows(rows, ITEM_MAX_ROWS);
    const list = await readQueue();
    pieces.forEach((piece, i) => {
      list.push({
        id: crypto.randomUUID(),
        kind: file.kind,
        dataset: String(file.name || '') + (pieces.length > 1 ? '#' + (i + 1) : ''),
        rows: piece,
        createdAt: Date.now(),
        attempts: 0,
        nextAt: 0,
        lastError: '',
      });
    });
    const capped = applyQueueCap(list, MAX_QUEUED_ROWS);
    await writeQueue(capped.list);
    await writeStatus({
      queued: capped.list.length,
      queuedRows: capped.list.reduce((s, it) => s + it.rows.length, 0),
      dropped: (capped.dropped || 0) + 0,
    });
    return { ok: true, items: pieces.length, dropped: capped.dropped };
  }

  async function originAllowed(baseUrl) {
    try {
      const origin = new URL(baseUrl).origin + '/*';
      if (typeof chrome === 'undefined' || !chrome.permissions) return false;
      return await chrome.permissions.contains({ origins: [origin] });
    } catch (e) {
      return false;
    }
  }

  async function httpJson(cfg, method, path, body) {
    const res = await fetch(cfg.baseUrl + path, {
      method: method,
      headers: Object.assign({ 'content-type': 'application/json' }, cfg.token ? { authorization: 'Bearer ' + cfg.token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  async function uploadItem(cfg, item) {
    const created = await httpJson(cfg, 'POST', '/imports', {
      kind: item.kind,
      seller_id: cfg.sellerId || undefined,
      meta: { dataset: item.dataset, queued_at: item.createdAt },
    });
    const importId = created && created.import_id;
    if (!importId) throw new Error('服务端未返回 import_id');
    const parts = chunkRows(item.rows, PART_SIZE);
    for (let i = 0; i < parts.length; i += 1) {
      await httpJson(cfg, 'PUT', '/imports/' + importId + '/parts/' + (i + 1), { rows: parts[i] });
    }
    const result = await httpJson(cfg, 'POST', '/imports/' + importId + '/commit');
    return { importId: importId, parts: parts.length, result: result };
  }

  async function drain(options) {
    const opts = options || {};
    const cfg = await loadConfig();
    const base = { enabled: cfg.enabled, baseUrl: cfg.baseUrl, sellerId: cfg.sellerId };
    if (!cfg.enabled && !opts.force) return Object.assign(base, { skipped: 'disabled' });
    if (!cfg.baseUrl || !cfg.token) {
      await writeStatus({ ok: false, lastError: '未配置云端地址或 Token' });
      return Object.assign(base, { skipped: 'unconfigured' });
    }
    if (!(await originAllowed(cfg.baseUrl))) {
      await writeStatus({ ok: false, lastError: '未授权云端域名（可在设置页重新保存）' });
      return Object.assign(base, { skipped: 'permission' });
    }
    const list = await readQueue();
    const now = Date.now();
    let handled = 0;
    let uploadedRows = 0;
    let lastError = '';
    let lastImportId = '';
    for (const item of list) {
      if (handled >= MAX_ITEMS_PER_RUN) break;
      if (Number(item.nextAt || 0) > now) continue;
      try {
        const r = await uploadItem(cfg, item);
        item.done = true;
        handled += 1;
        uploadedRows += item.rows.length;
        lastImportId = r.importId;
        lastError = '';
      } catch (e) {
        item.attempts = Number(item.attempts || 0) + 1;
        item.nextAt = Date.now() + backoffMs(item.attempts);
        item.lastError = String((e && e.message) || e).slice(0, 300);
        lastError = item.lastError;
        handled += 1;
      }
    }
    const rest = list.filter((it) => !it.done);
    await writeQueue(rest);
    await writeStatus({
      ok: !lastError,
      queued: rest.length,
      queuedRows: rest.reduce((s, it) => s + it.rows.length, 0),
      uploaded: uploadedRows,
      lastImportId: lastImportId,
      lastError: lastError,
    });
    return Object.assign(base, { skipped: '', uploaded: uploadedRows, remaining: rest.length, lastError: lastError });
  }

  async function status() {
    const queue = await readQueue();
    const saved = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] || {};
    return Object.assign({ queued: queue.length, queuedRows: queue.reduce((s, it) => s + it.rows.length, 0) }, saved);
  }

  const api = { normalizeConfig, loadConfig, saveConfig, rowKey, businessAtOf, toPayloadRows, chunkRows, backoffMs, applyQueueCap, hash64, enqueue, drain, status };
  if (typeof self !== 'undefined') self.AliCloudOutbox = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
