// IndexedDB 数据层（扩展上下文共享：service worker 与 dashboard 页同源，content script 通过 background 写入）
// 两个 store：
//   meta —— 文件索引（不含行数据，用于资料库列表）
//   data —— 文件行数据（header + rows，用于分析）
// 入库按内容摘要去重；分析按业务主键逐字段归并，旧版本可补新版本的空字段。
(function () {
  'use strict';
  const DB_NAME = 'ali_export_db';
  const VER = 2;

  const KINDS = {
    inquiry: '询盘',
    chat: '聊天',
    customer: '我的客户',
    public_customer: '公海客户',
    visitor: '访客',
    order: '订单',
  };
  // 业务主键（同一条数据的身份）
  const KEY_FIELD = {
    inquiry: ['询盘ID'],
    customer: ['客户ID'],
    public_customer: ['客户ID'],
    visitor: ['访客ID', '统计日期'],
    chat: ['会话', '发送时间', '内容'],
    order: ['订单ID'],
  };
  const CORE = self.AliDataCore;
  const WORKSPACE_KEY = 'aliActiveWorkspace';
  async function activeWorkspace() {
    const o = await chrome.storage.local.get(WORKSPACE_KEY);
    return String(o && o[WORKSPACE_KEY] || 'default');
  }
  const belongs = (m, wid) => String(m.workspace || 'default') === wid;

  let _db = null;
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'name' });
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'name' });
        if (!db.objectStoreNames.contains('stages')) db.createObjectStore('stages', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('stage_events')) db.createObjectStore('stage_events', { keyPath: 'id' });
      };
      r.onsuccess = () => { _db = r.result; res(_db); };
      r.onerror = () => rej(r.error);
    });
  }
  const pr = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  async function getMeta(name) {
    const db = await open();
    return pr(db.transaction('meta', 'readonly').objectStore('meta').get(name));
  }

  // 一次确认的文件在同一事务写入；同内容跳过，同名新内容保留版本。
  async function ingestMany(files, expectedWorkspace) {
    if (!Array.isArray(files) || files.some((f) => !f || !f.name || !KINDS[f.kind] || !Array.isArray(f.header)
      || !Array.isArray(f.rows) || f.rows.some((row) => !Array.isArray(row))))
      throw new Error('导入文件格式无效');
    const wid = await activeWorkspace();
    if (expectedWorkspace && expectedWorkspace !== wid) throw new Error('工作区已切换，拒绝写入原账号采集结果');
    const db = await open();
    const all = await pr(db.transaction('meta', 'readonly').objectStore('meta').getAll());
    const names = new Set(all.map((m) => m.name));
    const seen = new Set(all.filter((m) => belongs(m, wid) && m.hash).map((m) => m.kind + ':' + m.hash));
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const planned = [];
    for (const f of files) {
      const hash = await CORE.digest(f.header || [], f.rows);
      const signature = f.kind + ':' + hash;
      if (seen.has(signature)) { planned.push({ result: { ok: true, skipped: true, reason: 'same_content' } }); continue; }
      seen.add(signature);
      let name = names.has(f.name) ? `${wid}::${f.name}::${hash.slice(0, 16)}` : f.name;
      if (names.has(name)) name += '::' + crypto.randomUUID();
      names.add(name);
      const meta = { name, displayName: f.name, workspace: wid, hash, kind: f.kind,
        rows: f.rows.length, cols: (f.header || []).length, mtime: f.mtime || now,
        importedAt: now, importedAtMs: Date.now() + planned.length, source: f.source || 'export' };
      planned.push({ meta, data: { name, header: f.header || [], rows: f.rows },
        result: { ok: true, kind: f.kind, rows: f.rows.length, name } });
    }
    if (planned.some((x) => x.meta)) await new Promise((res, rej) => {
      const t = db.transaction(['meta', 'data'], 'readwrite');
      planned.forEach((x) => { if (x.meta) { t.objectStore('meta').put(x.meta); t.objectStore('data').put(x.data); } });
      t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
    return { ok: true, results: planned.map((x) => x.result) };
  }
  async function ingest(f) {
    try { return (await ingestMany([f], f && f.workspace)).results[0]; }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  }

  async function list(kind) {
    const db = await open();
    const wid = await activeWorkspace();
    const all = await pr(db.transaction('meta', 'readonly').objectStore('meta').getAll());
    return all.filter((m) => belongs(m, wid) && (!kind || m.kind === kind))
      .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)) || (Number(b.importedAtMs) || 0) - (Number(a.importedAtMs) || 0)
        || String(b.importedAt).localeCompare(String(a.importedAt)));
  }

  const toObj = (header, row) => {
    const o = {};
    for (let i = 0; i < header.length; i++) {
      const h = header[i];
      if (h) o[h] = row[i] === undefined || row[i] === null ? '' : row[i];
    }
    return o;
  };

  // 云端优先：登录并启用后以云端为唯一数据源；失败回落到本地缓存（离线兜底）
  const cloudCache = new Map();
  async function cloudConfig() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
      const d = await chrome.storage.local.get('aliCloudConfig');
      const c = d && d.aliCloudConfig;
      if (!c || !c.enabled || !c.baseUrl || !c.token) return null;
      return c;
    } catch (e) { return null; }
  }
  async function cloudDataset(kinds) {
    const cfg = await cloudConfig();
    if (!cfg) return null;
    const key = kinds.join(',');
    const hit = cloudCache.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.data;
    try {
      const url = cfg.baseUrl.replace(/\/+$/, '') + '/api/dataset?kinds=' + encodeURIComponent(key);
      const res = await fetch(url, { headers: { authorization: 'Bearer ' + cfg.token }, cache: 'no-store' });
      if (!res.ok) return null;
      const json = await res.json();
      if (!json || !json.datasets) return null;
      cloudCache.set(key, { at: Date.now(), data: json.datasets });
      return json.datasets;
    } catch (e) {
      return null;
    }
  }

  // 本地读取（离线缓存 / 对账用）
  async function localDataset(kinds) {
    const db = await open();
    const wid = await activeWorkspace();
    const metas = (await pr(db.transaction('meta', 'readonly').objectStore('meta').getAll()))
      .filter((m) => belongs(m, wid) && kinds.indexOf(m.kind) >= 0)
      .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)) || (Number(b.importedAtMs) || 0) - (Number(a.importedAtMs) || 0)
        || String(b.importedAt).localeCompare(String(a.importedAt)));
    const files = [];
    for (const m of metas) {
      const d = await pr(db.transaction('data', 'readonly').objectStore('data').get(m.name));
      if (!d) continue;
      files.push({ meta: m, header: d.header, rows: d.rows });
    }
    return CORE.mergeFiles(files, kinds);
  }

  // 读取若干类型的数据（云端优先；未登录或不可用时才读本地缓存）
  async function dataset(kinds) {
    const cloud = await cloudDataset(kinds);
    if (cloud) return cloud;
    return localDataset(kinds);
  }

  // 本机缓存条数（心跳对账用，不受云端优先影响）
  async function localCounts(kinds) {
    const data = await localDataset(kinds);
    const out = {};
    (kinds || []).forEach((k) => { out[k] = (data[k] || []).length; });
    return out;
  }

  async function removeFile(name) {
    const wid = await activeWorkspace();
    const meta = await getMeta(name);
    if (!meta || !belongs(meta, wid)) return { ok: false, error: '文件不属于当前工作区' };
    const db = await open();
    await new Promise((res, rej) => {
      const t = db.transaction(['meta', 'data'], 'readwrite');
      t.objectStore('meta').delete(name);
      t.objectStore('data').delete(name);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
    return { ok: true };
  }

  async function clearAll() {
    const db = await open();
    const metas = await list();
    const wid = await activeWorkspace();
    const stages = await pr(db.transaction('stages', 'readonly').objectStore('stages').getAll());
    const events = await pr(db.transaction('stage_events', 'readonly').objectStore('stage_events').getAll());
    await new Promise((res, rej) => {
      const t = db.transaction(['meta', 'data', 'stages', 'stage_events'], 'readwrite');
      metas.forEach((m) => { t.objectStore('meta').delete(m.name); t.objectStore('data').delete(m.name); });
      stages.filter((s) => s.workspace === wid).forEach((s) => t.objectStore('stages').delete(s.id));
      events.filter((s) => s.workspace === wid).forEach((s) => t.objectStore('stage_events').delete(s.id));
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
    return { ok: true };
  }

  const STAGE_VALUES = ['新询盘', '已回复', '已报价', '样品/规格确认', '已成交', '已流失', '无效询盘', '待核实'];
  async function setStage(inquiryId, stage, evidence, sourceAt, sourceBy, expectedWorkspace) {
    const iid = String(inquiryId || '').trim();
    const note = String(evidence || '').trim();
    if (!iid || !STAGE_VALUES.includes(stage)) throw new Error('询盘 ID 或阶段无效');
    if (['已成交', '已流失', '无效询盘'].includes(stage) && !note) throw new Error('成交、流失或无效需要填写核实依据');
    const wid = await activeWorkspace();
    if (expectedWorkspace && expectedWorkspace !== wid) throw new Error('工作区已切换，拒绝写入历史阶段');
    const db = await open();
    const id = wid + '::' + iid;
    const before = await pr(db.transaction('stages', 'readonly').objectStore('stages').get(id));
    if (before && before.stage === stage && before.evidence === note) return { ok: true, skipped: true };
    const parsedAt = sourceAt ? new Date(sourceAt).getTime() : NaN;
    const at = Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : new Date().toISOString();
    const record = { id, workspace: wid, inquiryId: iid, stage, evidence: note, at, by: sourceBy || '员工确认' };
    await new Promise((res, rej) => {
      const t = db.transaction(['stages', 'stage_events'], 'readwrite');
      t.objectStore('stages').put(record);
      t.objectStore('stage_events').put({ ...record, id: wid + '::' + crypto.randomUUID(), from: before ? before.stage : '' });
      t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
    return { ok: true, record };
  }
  async function stageMap() {
    const db = await open();
    const wid = await activeWorkspace();
    const rows = await pr(db.transaction('stages', 'readonly').objectStore('stages').getAll());
    return Object.fromEntries(rows.filter((r) => r.workspace === wid).map((r) => [r.inquiryId, r]));
  }
  async function stageHistory(inquiryId) {
    const db = await open();
    const wid = await activeWorkspace();
    const rows = await pr(db.transaction('stage_events', 'readonly').objectStore('stage_events').getAll());
    return rows.filter((r) => r.workspace === wid && (!inquiryId || r.inquiryId === inquiryId))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  // 数据搬家：整库导出 / 导入（换电脑时用）
  async function exportJson() {
    const db = await open();
    const metas = await list();
    const all = await pr(db.transaction('data', 'readonly').objectStore('data').getAll());
    const names = new Set(metas.map((m) => m.name));
    const datas = all.filter((d) => names.has(d.name));
    return { app: 'ali-export-dashboard', version: 3, exportedAt: new Date().toISOString(), metas, datas,
      stages: Object.values(await stageMap()), stageEvents: await stageHistory() };
  }
  async function importJson(pack, options) {
    if (!pack || !Array.isArray(pack.datas)) throw new Error('文件格式不对');
    const wid = await activeWorkspace();
    const state = self.AliSyncState && await self.AliSyncState.load(chrome.storage.local, wid);
    if (state && state.fingerprint && pack.accountFingerprint && state.fingerprint !== pack.accountFingerprint)
      throw new Error('备份所属卖家账号与当前工作区不一致，请切换工作区');
    if (state && state.fingerprint && !pack.accountFingerprint && !(options && options.allowUnverified))
      throw new Error('旧备份没有账号标识，导入前需核实所属店铺');
    if ((pack.stages !== undefined && !Array.isArray(pack.stages))
      || (pack.stageEvents !== undefined && !Array.isArray(pack.stageEvents))) throw new Error('阶段备份格式不对');
    const validStage = (r) => r && r.inquiryId && STAGE_VALUES.includes(r.stage)
      && (!['已成交', '已流失', '无效询盘'].includes(r.stage) || String(r.evidence || '').trim());
    if ((Array.isArray(pack.stages) && pack.stages.some((r) => !validStage(r)))
      || (Array.isArray(pack.stageEvents) && pack.stageEvents.some((r) => !validStage(r))))
      throw new Error('备份中有缺少依据的成交、流失或无效阶段');
    const files = pack.datas.map((d) => {
      const meta = (pack.metas || []).find((m) => m.name === d.name) || {};
      return { name: meta.displayName || d.name, kind: meta.kind, header: d.header, rows: d.rows, mtime: meta.mtime, source: 'import' };
    });
    const result = await ingestMany(files, wid);
    const n = result.results.filter((r) => !r.skipped).length;
    if (Array.isArray(pack.stages) || Array.isArray(pack.stageEvents)) {
      const db = await open();
      await new Promise((res, rej) => {
        const t = db.transaction(['stages', 'stage_events'], 'readwrite');
        (pack.stages || []).forEach((r) => { t.objectStore('stages').put({ ...r, id: wid + '::' + r.inquiryId, workspace: wid }); });
        (pack.stageEvents || []).forEach((r) => { t.objectStore('stage_events').put({ ...r, id: wid + '::' + crypto.randomUUID(), workspace: wid }); });
        t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    }
    return { ok: true, imported: n };
  }

  self.AliDB = { KINDS, KEY_FIELD, STAGE_VALUES, activeWorkspace, ingest, ingestMany, list, dataset, localDataset, localCounts, setStage, stageMap, stageHistory, removeFile, clearAll, exportJson, importJson, toObj };
})();
