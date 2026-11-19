'use strict';

// 询盘提醒（云端托管）：扫描未回复询盘 → 分级 → 去重 → 推飞书
// 用法：docker exec ali-cloud-api-1 node src/reminder-cli.js
// 依赖环境变量：DATABASE_URL、SELLER_ID、FEISHU_WEBHOOK（或 FEISHU_APP_*）
const { PgStore } = require('./store-pg');
const { sendText, renderInquiryBatch, isConfigured, modeOf } = require('./notify');
const log = require('./log');

const WINDOW_HOURS = Number(process.env.REMINDER_WINDOW_HOURS || 72);
const DEDUPE_HOURS = Number(process.env.REMINDER_DEDUPE_HOURS || 12);
const LIMIT = Number(process.env.REMINDER_LIMIT || 30);
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const sellerId = String(process.env.SELLER_ID || '').trim();
const tenantId = String(process.env.TENANT_ID || 'default').trim();
const DRY_RUN = process.argv.indexOf('--dry-run') > 0;

function parseAt(row) {
  const raw = row.business_at || (row.payload && row.payload['创建时间']);
  if (!raw) return null;
  const t = Date.parse(String(raw).replace(/\//g, '-'));
  return Number.isFinite(t) ? t : null;
}

function toEvent(row, now) {
  const p = row.payload || {};
  const at = parseAt(row);
  const age = at === null ? null : Math.max(0, (now - at) / 3600000);
  const priority = age !== null && age <= 24 ? 'P0' : 'P1';
  const name = p['客户名称'] || p['公司名称'] || '未知客户';
  return {
    id: row.platform_id,
    displayId: String(row.platform_id || '').replace(/^inquiry:/, ''),
    priority: priority,
    title: (priority === 'P0' ? '新询盘待回复：' : '询盘超时未回复：') + name,
    customer: name,
    company: p['公司名称'] || '',
    country: p['国家'] || '',
    businessAt: at,
    ageHours: age,
    status: '待回复',
    subject: p['询盘主题'] || '',
    owner: p['负责人'] || '',
    reason: priority === 'P0' ? '未回复 + 24 小时内有活动' : '未回复超过 72 小时',
  };
}

(async () => {
  if (!databaseUrl) {
    log.error('reminder_abort', { reason: 'missing_database_url' });
    process.exit(1);
  }
  if (!isConfigured()) {
    log.warn('reminder_skip', { reason: 'feishu_not_configured', mode: modeOf() });
    return;
  }
  const store = new PgStore(databaseUrl);
  try {
    const rows = await store.pendingInquiries(sellerId, WINDOW_HOURS, LIMIT);
    if (!rows.length) {
      log.info('reminder_empty', { seller: sellerId, window_hours: WINDOW_HOURS });
      return;
    }
    const now = Date.now();
    const recent = await store.recentNotices(sellerId, DEDUPE_HOURS);
    const skip = new Set((recent || []).map((r) => r.platform_id + '|' + r.priority));
    const events = [];
    for (const row of rows) {
      const ev = toEvent(row, now);
      if (skip.has(ev.id + '|' + ev.priority)) continue;
      events.push(ev);
    }
    if (!events.length) {
      log.info('reminder_deduped', { pending: rows.length, window_hours: DEDUPE_HOURS });
      return;
    }
    events.sort((a, b) => (a.priority === b.priority ? (a.ageHours || 0) - (b.ageHours || 0) : a.priority.localeCompare(b.priority)));
    const text = renderInquiryBatch(events, now);
    if (DRY_RUN) {
      console.log(text);
      log.info('reminder_dry_run', { count: events.length });
      return;
    }
    const sent = await sendText(text);
    if (!sent.ok) {
      log.error('reminder_failed', { count: events.length, status: sent.status, code: sent.code, mode: sent.mode });
      process.exit(1);
    }
    await store.markNotices(events.map((e) => ({
      tenantId: tenantId, sellerId: sellerId, kind: 'inquiry', platformId: e.id, priority: e.priority,
    })));
    log.info('reminder_sent', { count: events.length, mode: sent.mode, priorities: events.map((e) => e.priority) });
  } finally {
    await store.close().catch(() => {});
  }
})().catch((e) => {
  log.error('reminder_failed', { error: String((e && e.message) || e) });
  process.exit(1);
});
