'use strict';

// 飞书推送：优先群机器人 webhook，其次自建应用（app_id / app_secret / chat_id）
const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
let cache = { token: '', exp: 0 };

function config() {
  return {
    webhook: String(process.env.FEISHU_WEBHOOK || '').trim(),
    appId: String(process.env.FEISHU_APP_ID || '').trim(),
    appSecret: String(process.env.FEISHU_APP_SECRET || '').trim(),
    chatId: String(process.env.FEISHU_CHAT_ID || '').trim(),
  };
}

function isConfigured(cfg) {
  const c = cfg || config();
  if (c.webhook) return true;
  return Boolean(c.appId && c.appSecret && c.chatId);
}

function modeOf(cfg) {
  const c = cfg || config();
  if (c.webhook) return 'webhook';
  if (c.appId && c.appSecret && c.chatId) return 'app';
  return 'none';
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

// 统一按东八区展示，服务器时区变化也不漂
function fmtTime(input) {
  if (!input) return '-';
  const t = typeof input === 'number' ? input : Date.parse(String(input).replace(/\//g, '-'));
  if (!Number.isFinite(t)) return '-';
  const d = new Date(t + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
    ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

function fmtAge(hours) {
  if (hours === null || hours === undefined) return '';
  if (hours < 1) return Math.max(1, Math.round(hours * 60)) + ' 分钟前';
  if (hours < 48) return Math.round(hours) + ' 小时前';
  return Math.round(hours / 24) + ' 天前';
}

async function tenantToken(cfg) {
  if (cache.token && Date.now() < cache.exp) return cache.token;
  const res = await fetch(FEISHU_BASE + '/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json().catch(() => ({}));
  if (!j || j.code !== 0 || !j.tenant_access_token) throw new Error('飞书 tenant_access_token 获取失败');
  cache = { token: j.tenant_access_token, exp: Date.now() + (Number(j.expire || 7200) - 300) * 1000 };
  return cache.token;
}

async function sendText(text) {
  const cfg = config();
  const mode = modeOf(cfg);
  if (mode === 'none') return { ok: false, mode: mode, reason: 'not_configured' };
  if (mode === 'webhook') {
    const res = await fetch(cfg.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: text } }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await res.json().catch(() => ({}));
    const ok = res.ok && (j.code === 0 || j.StatusCode === 0 || j.code === undefined);
    return { ok: ok, mode: mode, status: res.status, code: j.code };
  }
  const token = await tenantToken(cfg);
  const res = await fetch(FEISHU_BASE + '/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ receive_id: cfg.chatId, msg_type: 'text', content: JSON.stringify({ text: text }) }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok && j.code === 0, mode: mode, status: res.status, code: j.code };
}

// 与本地版 notifier 保持同一版式，便于员工无感切换
function renderInquiryBatch(events, now) {
  if (!events.length) return '';
  const head = '外贸助手 · 询盘提醒（' + fmtTime(now || Date.now()) + '，' + events.length + ' 条）';
  const body = events.map((e) => {
    const lines = [
      '[' + e.priority + '] ' + e.title,
      '客户：' + (e.customer || '-') + (e.company && e.company !== e.customer ? ' · ' + e.company : ''),
      '国家：' + (e.country || '-'),
      '询盘时间：' + fmtTime(e.businessAt) + (e.ageHours !== null ? '（' + fmtAge(e.ageHours) + '）' : ''),
      '状态：' + (e.status || '待回复'),
      '摘要：' + (e.subject || '-'),
    ];
    if (e.owner) lines.push('归属：' + e.owner);
    lines.push('ID：' + (e.displayId || e.id));
    lines.push('触发：' + e.reason);
    return lines.join('\n');
  }).join('\n\n---\n\n');
  return head + '\n\n' + body;
}

module.exports = { config, isConfigured, modeOf, sendText, renderInquiryBatch, fmtTime, fmtAge };
