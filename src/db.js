// IndexedDB 数据层（扩展上下文共享：service worker 与 dashboard 页同源，content script 通过 background 写入）
// 两个 store：
//   meta —— 文件索引（不含行数据，用于资料库列表）
//   data —— 文件行数据（header + rows，用于分析）
// 去重：入库按文件名跳过；分析按业务主键跨文件去重，且「同一主键以最新导出的那份为准」。
(function () {
  'use strict';
  const DB_NAME = 'ali_export_db';
  const VER = 1;

  const KINDS = {
    inquiry: '询盘',
    chat: '聊天',
    customer: '我的客户',
    public_customer: '公海客户',
    visitor: '访客',
  };
  // 业务主键（同一条数据的身份）
  const KEY_FIELD = {
    inquiry: ['询盘ID'],
    customer: ['客户ID'],
    public_customer: ['客户ID'],
    visitor: ['访客ID'],
    chat: ['会话', '发送时间', '内容'],
  };

  let _db = null;
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'name' });
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'name' });
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

  // 入一份文件（同名跳过）
  async function ingest(f) {
    if (!f || !f.name || !KINDS[f.kind] || !Array.isArray(f.rows)) return { ok: false, error: 'bad payload' };
    if (await getMeta(f.name)) return { ok: true, skipped: true };
    const db = await open();
    const meta = {
      name: f.name,
      kind: f.kind,
      rows: f.rows.length,
      cols: (f.header || []).length,
      mtime: f.mtime || new Date().toISOString().slice(0, 19).replace('T', ' '),
      importedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      source: f.source || 'export',
    };
    await new Promise((res, rej) => {
      const t = db.transaction(['meta', 'data'], 'readwrite');
      t.objectStore('meta').put(meta);
      t.objectStore('data').put({ name: f.name, header: f.header || [], rows: f.rows });
      t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
    return { ok: true, kind: f.kind, rows: f.rows.length };
  }

  async function list(kind) {
    const db = await open();
    const all = await pr(db.transaction('meta', 'readonly').objectStore('meta').getAll());
    return all.filter((m) => !kind || m.kind === kind).sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  }

  const toObj = (header, row) => {
    const o = {};
    for (let i = 0; i < header.length; i++) {
      const h = header[i];
      if (h) o[h] = row[i] === undefined || row[i] === null ? '' : row[i];
    }
    return o;
  };

  // 读取若干类型的数据（跨文件合并 + 业务主键去重，最新文件优先）
  async function dataset(kinds) {
    const db = await open();
    const metas = (await pr(db.transaction('meta', 'readonly').objectStore('meta').getAll()))
      .filter((m) => kinds.indexOf(m.kind) >= 0)
      .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime))); // 新 → 旧
    const out = {};
    kinds.forEach((k) => { out[k] = []; });
    for (const m of metas) {
      const d = await pr(db.transaction('data', 'readonly').objectStore('data').get(m.name));
      if (!d) continue;
      const keys = KEY_FIELD[m.kind] || [];
      const seen = out['__seen_' + m.kind] || (out['__seen_' + m.kind] = new Set());
      for (const row of d.rows) {
        const o = toObj(d.header, row);
        o.__file__ = m.name;
        o.__mtime__ = m.mtime;
        if (keys.length) {
          const k = keys.map((x) => String(o[x] === undefined ? '' : o[x])).join('\u0001');
          if (k.replace(/\u0001/g, '') && seen.has(k)) continue; // 已有更新的那份
          seen.add(k);
        }
        out[m.kind].push(o);
      }
    }
    kinds.forEach((k) => { delete out['__seen_' + k]; });
    return out;
  }

  async function removeFile(name) {
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
    await new Promise((res, rej) => {
      const t = db.transaction(['meta', 'data'], 'readwrite');
      t.objectStore('meta').clear();
      t.objectStore('data').clear();
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
    return { ok: true };
  }

  // 数据搬家：整库导出 / 导入（换电脑时用）
  async function exportJson() {
    const db = await open();
    const metas = await pr(db.transaction('meta', 'readonly').objectStore('meta').getAll());
    const datas = await pr(db.transaction('data', 'readonly').objectStore('data').getAll());
    return { app: 'ali-export-dashboard', version: 1, exportedAt: new Date().toISOString(), metas, datas };
  }
  async function importJson(pack) {
    if (!pack || !Array.isArray(pack.datas)) throw new Error('文件格式不对');
    let n = 0;
    for (const d of pack.datas) {
      const meta = (pack.metas || []).find((m) => m.name === d.name) || {};
      const r = await ingest({ name: d.name, kind: meta.kind, header: d.header, rows: d.rows, mtime: meta.mtime, source: 'import' });
      if (r.ok && !r.skipped) n++;
    }
    return { ok: true, imported: n };
  }

  self.AliDB = { KINDS, KEY_FIELD, ingest, list, dataset, removeFile, clearAll, exportJson, importJson, toObj };
})();
