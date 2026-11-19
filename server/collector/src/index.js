'use strict';

// 云端采集器（只读）：读取托管登录态 → 直连页面原生询盘接口 → 走 /imports 入库
// 不发送任何消息；登录失效/无数据都会通过心跳与日志暴露
const fs = require('node:fs');
const inquiryMap = require('./inquiry-map');

const API = String(process.env.API_BASE || 'http://api:8787').replace(/\/+$/, '');
const TOKEN = String(process.env.INGEST_TOKEN || '').trim();
// SELLER 仅作为列表接口不可用时的兜底；正常按托管登录态的店铺逐个采集
const SELLER = String(process.env.SELLER_ID || 'seller-main').trim();
const COLLECT_SELLERS = String(process.env.COLLECT_SELLERS || '')
  .split(',').map((item) => item.trim()).filter(Boolean);
const INTERVAL_MIN = Math.max(10, Number(process.env.INTERVAL_MINUTES || 60));
const RUN_ONCE = process.env.RUN_ONCE === '1';
const CLIENT_ID = 'cloud-collector';
const STATUS_FILE = '/data/status.json';
const statuses = {};
// 阿里会按 UA 识别 HeadlessChrome；直连接口也带真实 Chrome UA，降低风控误判
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const INQUIRY_API = String(process.env.INQUIRY_API || 'https://message.alibaba.com/message/ajax/feedback/subjectList.htm');
const REFERER = String(process.env.REFERER || 'https://message.alibaba.com/message/default.htm');
const PAGE_SIZE = 20;      // 与平台 UI 一致
const MAX_ROWS = 2000;     // 单轮保护上限
const MAX_PAGES = 100;
const DELAY_MIN_MS = 400;  // 翻页基础间隔
const DELAY_JITTER_MS = 500;

function log(msg, extra) {
  console.log(JSON.stringify(Object.assign({ ts: new Date().toISOString(), msg: msg }, extra || {})));
}

function writeStatus() {
  try {
    fs.mkdirSync('/data', { recursive: true });
    const values = Object.keys(statuses).map((key) => statuses[key]);
    const state = values.some((row) => row.state === 'error') ? 'error'
      : values.some((row) => row.state === 'login_expired') ? 'login_expired'
        : values.length ? 'ok' : 'idle';
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ at: new Date().toISOString(), state: state, accounts: statuses }));
  } catch (e) { /* 忽略 */ }
}

function setStatus(seller, patch) {
  statuses[seller] = Object.assign({ at: new Date().toISOString() }, patch || {});
  writeStatus();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path, options) {
  const o = options || {};
  const res = await fetch(API + path, {
    method: o.method || 'GET',
    headers: Object.assign({ authorization: 'Bearer ' + TOKEN }, o.body ? { 'content-type': 'application/json' } : {}),
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = { raw: text }; }
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + String((json && json.message) || text).slice(0, 160));
  return json;
}

function cookieValue(cookies, name) {
  const hit = (cookies || []).find((c) => c.name === name);
  return hit ? String(hit.value || '') : '';
}

// ctoken 不是独立 cookie：藏在 xman_us_t 等 cookie 的值里，需对整串扫描
function cookieHeader(cookies) {
  return (cookies || []).map((c) => c.name + '=' + c.value).join('; ');
}

function ctokenOf(cookies) {
  const m = cookieHeader(cookies).match(/ctoken=([^&;]*)/);
  return m && m[1] ? decodeURIComponent(m[1]) : '';
}

function inquiryParams(page) {
  return {
    system: 'feedback', listType: 'all', pageSize: PAGE_SIZE,
    pagination: { nextPage: page, pageSize: PAGE_SIZE },
    filter: { isShowAtm: false },
    order: { order: 'desc', orderBy: 'latest_contact_time' },
    search: {},
  };
}

async function fetchInquiryPage(cookies, page) {
  const ctoken = ctokenOf(cookies);
  const tb = cookieValue(cookies, '_tb_token_');
  const csrf = cookieValue(cookies, 'XSRF-TOKEN');
  const qs = new URLSearchParams({ ctoken: ctoken, _tb_token_: tb });
  const body = new URLSearchParams({
    _csrf_token_: csrf,
    postId: '',
    params: JSON.stringify(inquiryParams(page)),
  });
  const res = await fetch(INQUIRY_API + '?' + qs, {
    method: 'POST',
    headers: {
      cookie: cookieHeader(cookies),
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      accept: 'application/json, text/javascript, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      referer: REFERER,
      origin: 'https://message.alibaba.com',
      'x-xsrf-token': csrf,
      'user-agent': USER_AGENT,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    body: body.toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 登录页/HTML */ }
  if (!json) {
    return { login: true, error: '接口返回非 JSON（多为登录态失效）', status: res.status };
  }
  if (json.code !== 200) {
    const msg = String(json.message || json.msg || '');
    return { login: json.code === 401 || /login|登录|未登录|session/i.test(msg), error: msg || ('code=' + json.code), status: res.status };
  }
  const d = json.data || {};
  let list = d.list || d.dataList || d.result || d.records || [];
  // 平台的 data.list 为「数组的数组」（按分组），需展平一层
  if (Array.isArray(list) && list.length && Array.isArray(list[0])) list = [].concat(...list);
  return { list: Array.isArray(list) ? list : [], total: (d.pagination && d.pagination.totalCount) || 0 };
}

function toRows(items) {
  const seen = new Set();
  const rows = [];
  (items || []).forEach((o) => {
    const platformId = inquiryMap.platformIdOf(o);
    if (!platformId || seen.has(platformId)) return;
    seen.add(platformId);
    rows.push({
      platform_id: platformId,
      payload: inquiryMap.canonicalInquiry(o),
      business_at: inquiryMap.businessAtOf(o),
    });
  });
  return rows;
}

async function collectInquiries(cookies) {
  const rows = [];
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const r = await fetchInquiryPage(cookies, page);
    if (r.login) return { login: true, error: r.error, rows: rows };
    if (r.error) return { error: r.error, rows: rows };
    if (r.total) total = r.total;
    if (!r.list.length) break;
    rows.push(...toRows(r.list));
    if (rows.length >= MAX_ROWS) break;
    if (total && page * PAGE_SIZE >= total) break;
    await sleep(DELAY_MIN_MS + Math.floor(Math.random() * DELAY_JITTER_MS));
  }
  return { rows: rows.slice(0, MAX_ROWS), total: total };
}

async function upload(rows, seller) {
  const created = await api('/imports', { method: 'POST', body: { kind: 'inquiry', seller_id: seller, meta: { from: 'cloud-collector' } } });
  const id = created && created.import_id;
  if (!id) throw new Error('未返回 import_id');
  for (let i = 0; i < rows.length; i += 200) {
    await api('/imports/' + id + '/parts/' + (Math.floor(i / 200) + 1), { method: 'PUT', body: { rows: rows.slice(i, i + 200) } });
  }
  return api('/imports/' + id + '/commit', { method: 'POST' });
}

async function heartbeat(state, rows, seller) {
  try {
    await api('/api/heartbeat?seller_id=' + encodeURIComponent(seller), {
      method: 'POST',
      body: { client_id: CLIENT_ID, version: 'collector:' + state + ':' + rows, queue_rows: 0, counts: {} },
    });
  } catch (e) { /* 心跳失败不影响采集 */ }
}

// 列出已托管登录态的店铺；接口不可用时回退到单店铺 SELLER
async function listAccounts() {
  let sellers = [];
  try {
    const data = await api('/api/collector/accounts');
    sellers = (data.items || []).map((item) => String(item.seller_id || '').trim()).filter(Boolean);
  } catch (e) {
    log('accounts_unavailable', { error: String((e && e.message) || e) });
  }
  if (!sellers.length) sellers = [SELLER].filter(Boolean);
  if (COLLECT_SELLERS.length) sellers = sellers.filter((sid) => COLLECT_SELLERS.indexOf(sid) >= 0);
  return sellers;
}

async function runAccount(seller) {
  const state = await api('/api/collector/cookies?seller_id=' + encodeURIComponent(seller));
  const cookies = state.cookies || [];
  if (!cookies.length) throw new Error('登录态为空');
  log('state_loaded', { seller: seller, cookies: cookies.length, updated_at: state.updated_at });

  const result = await collectInquiries(cookies);
  if (result.login) {
    setStatus(seller, { state: 'login_expired', error: result.error });
    log('login_expired', { seller: seller, error: result.error });
    await heartbeat('login_expired', 0, seller);
    return;
  }
  if (result.error) throw new Error(result.error);
  if (!result.rows.length) {
    setStatus(seller, { state: 'no_data', total: result.total });
    log('no_data', { seller: seller, total: result.total });
    await heartbeat('no_data', 0, seller);
    return;
  }
  const uploaded = await upload(result.rows, seller);
  setStatus(seller, { state: 'ok', rows: result.rows.length, total: result.total, result: uploaded });
  log('upload_ok', { seller: seller, rows: result.rows.length, total: result.total, result: uploaded });
  await heartbeat('ok', result.rows.length, seller);
}

async function runOnce() {
  const accounts = await listAccounts();
  if (!accounts.length) {
    setStatus(SELLER || 'unknown', { state: 'no_accounts', error: '没有可采集的店铺登录态' });
    log('no_accounts');
    return;
  }
  for (const seller of accounts) {
    try {
      await runAccount(seller);
    } catch (e) {
      const msg = String((e && e.message) || e);
      setStatus(seller, { state: 'error', error: msg });
      log('account_failed', { seller: seller, error: msg });
      await heartbeat('error', 0, seller);
    }
    if (accounts.length > 1) await sleep(500);
  }
}

(async () => {
  if (!TOKEN) {
    setStatus(SELLER, { state: 'no_token' });
    log('missing_ingest_token');
    process.exit(1);
  }
  for (;;) {
    try {
      await runOnce();
    } catch (e) {
      const msg = String((e && e.message) || e);
      setStatus(SELLER, { state: 'error', error: msg });
      log('run_failed', { error: msg });
    }
    if (RUN_ONCE) break;
    await sleep(INTERVAL_MIN * 60 * 1000);
  }
})().catch((e) => {
  log('fatal', { error: String((e && e.message) || e) });
  process.exit(1);
});
