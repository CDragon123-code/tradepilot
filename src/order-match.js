// 订单 → 询盘归因：优先买家ID（AliID/旺旺/客户ID）→ 公司名 → 客户名 → 词序/包含
// 平台订单接口不返回询盘ID，这里只做本机已有数据的弱归因，并标注归因方式与置信度。
(function () {
  'use strict';
  const identity = (typeof self !== 'undefined' && self.AliIdentity)
    ? self.AliIdentity
    : (typeof require === 'function' ? require('./identity.js') : null);

  const norm = (v) => (identity && identity.normalize
    ? identity.normalize(v)
    : String(v === undefined || v === null ? '' : v).toLowerCase().normalize('NFKC')
      .replace(/[\s\u3000_\-/（）()：:.,，。&·'"]/g, '').trim());

  function tokenKey(v) {
    const s = String(v === undefined || v === null ? '' : v).toLowerCase().normalize('NFKC')
      .replace(/[^0-9a-z\u4e00-\u9fa5]+/g, ' ').trim();
    return s ? s.split(/\s+/).filter(Boolean).sort().join(' ') : '';
  }

  function dateTs(v) {
    if (v === undefined || v === null || v === '') return 0;
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
    const t = Date.parse(String(v).replace(/\//g, '-'));
    return Number.isFinite(t) ? t : 0;
  }

  // 序列化索引（可经 chrome.runtime.sendMessage 传输）
  function buildIndex(data) {
    const d = data || {};
    const inquiry = d.inquiry || [];
    const customers = [].concat(d.customer || [], d.public_customer || []);
    const inquiries = inquiry.filter((r) => r && r['询盘ID']).map((r) => ({
      id: String(r['询盘ID']),
      name: String(r['客户名称'] === undefined || r['客户名称'] === null ? '' : r['客户名称']),
      company: String(r['公司名称'] === undefined || r['公司名称'] === null ? '' : r['公司名称']),
      t: String(r['创建时间'] === undefined || r['创建时间'] === null ? '' : r['创建时间']),
    }));
    const outCustomers = [];
    if (identity && identity.build) {
      const idx = identity.build({
        inquiry: inquiry,
        customer: d.customer || [],
        public_customer: d.public_customer || [],
        chat: [],
        order: [],
      });
      const byId = new Map(inquiries.map((x) => [x.id, x]));
      const seen = new Set();
      customers.forEach((c) => {
        const keys = ['AliID', '旺旺', '客户ID']
          .map((k) => String(c[k] === undefined || c[k] === null ? '' : c[k]).trim())
          .filter(Boolean);
        if (!keys.length) return;
        const uid = idx.uidOfCustomer(c);
        const p = idx.byUid.get(uid);
        const ids = (p && Array.isArray(p.inquiryIds) ? p.inquiryIds : [])
          .map(String).filter((id) => byId.has(id));
        if (!ids.length) return;
        const sig = keys.join('|');
        if (seen.has(sig)) return;
        seen.add(sig);
        outCustomers.push({ keys, ids });
      });
    }
    return { inquiries: inquiries, customers: outCustomers };
  }

  // 反序列化为匹配用的 Map/索引
  function hydrateIndex(payload) {
    const p = payload || {};
    const inquiries = (p.inquiries || []).map((x) => ({
      id: String(x.id || ''),
      nameKeys: [norm(x.name)].filter(Boolean),
      companyKeys: [norm(x.company)].filter(Boolean),
      tokenKeys: [tokenKey(x.name)].filter(Boolean),
      t: String(x.t || ''),
      ts: dateTs(x.t),
    })).filter((x) => x.id);
    const byId = new Map(inquiries.map((x) => [x.id, x]));
    const customerKeys = new Map();
    (p.customers || []).forEach((c) => {
      const ids = (c.ids || []).map((id) => byId.get(String(id))).filter(Boolean);
      if (!ids.length) return;
      (c.keys || []).forEach((k) => {
        const n = norm(k);
        if (n) customerKeys.set(n, ids);
      });
    });
    return { inquiries: inquiries, customerKeys: customerKeys };
  }

  function pickLatest(arr, orderTs) {
    if (!arr || !arr.length) return null;
    const before = orderTs ? arr.filter((x) => !x.ts || x.ts <= orderTs) : arr;
    const pool = before.length ? before : arr;
    return pool.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))[0] || null;
  }

  function match(order, index) {
    const o = order || {};
    const idx = index || { inquiries: [], customerKeys: new Map() };
    const orderTs = dateTs(o.orderTime);
    const bid = norm(o.buyerId);
    if (bid && idx.customerKeys.has(bid)) {
      const hit = pickLatest(idx.customerKeys.get(bid), orderTs);
      if (hit) return { id: hit.id, way: '客户ID', confidence: (!orderTs || !hit.ts || hit.ts <= orderTs) ? '高' : '中' };
    }
    const company = norm(o.company);
    if (company) {
      const hit = pickLatest(idx.inquiries.filter((x) => x.companyKeys.indexOf(company) >= 0), orderTs);
      if (hit) return { id: hit.id, way: '公司名', confidence: '中' };
    }
    const name = norm(o.name);
    if (name) {
      const hit = pickLatest(idx.inquiries.filter((x) => x.nameKeys.indexOf(name) >= 0), orderTs);
      if (hit) return { id: hit.id, way: '客户名', confidence: '中' };
    }
    const tk = tokenKey(o.name);
    if (tk) {
      const hit = pickLatest(idx.inquiries.filter((x) => x.tokenKeys.indexOf(tk) >= 0), orderTs);
      if (hit) return { id: hit.id, way: '词序', confidence: '低' };
    }
    if (name.length >= 3) {
      const hit = pickLatest(idx.inquiries.filter((x) => x.nameKeys.some((k) => k && (k.indexOf(name) >= 0 || name.indexOf(k) >= 0))), orderTs);
      if (hit) return { id: hit.id, way: '名称包含', confidence: '低' };
    }
    return { id: '', way: '未归因', confidence: '' };
  }

  const api = { norm, tokenKey, dateTs, buildIndex, hydrateIndex, match };
  if (typeof self !== 'undefined') self.AliOrderMatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
