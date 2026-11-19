'use strict';

// 每日巡检：数据源断更 / 从未同步 / 采集器登录态 / 磁盘水位 / 数据库连通，异常时推到飞书
// 用法（容器内）：docker exec ali-cloud-api-1 node src/alert-cli.js
// 需要的环境变量：DATABASE_URL、SELLER_ID、FEISHU_WEBHOOK（可选）
//
// 降噪约定：
//   1) 只在业务时段（默认 08:00–20:00）报数据断更；夜间停更是正常现象，不推送。
//   2) 多个数据源同时停更时合并成一条，不再逐条刷屏。
//   3) 磁盘与数据库属于硬故障，任何时段都推送。
const { PgStore } = require('./store-pg');
const { diskUsage } = require('./health');
const { sendText, isConfigured } = require('./notify');
const log = require('./log');

// 数据源超过该小时数未更新即告警；运营时效默认 3 小时，可用 STALE_HOURS 覆盖
const STALE_HOURS = Number(process.env.STALE_HOURS || 3);
// 业务时段：仅在此时段内报数据断更（夜间不采集属于正常）
const ACTIVE_START_HOUR = Number(process.env.ACTIVE_START_HOUR || 8);
const ACTIVE_END_HOUR = Number(process.env.ACTIVE_END_HOUR || 20);
// 采集器登录态超过该小时数视为需要刷新
const COLLECTOR_STALE_HOURS = Number(process.env.COLLECTOR_STALE_HOURS || 72);
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const sellerId = String(process.env.SELLER_ID || '').trim();
const tenantId = String(process.env.TENANT_ID || 'default').trim();

function inActiveHours(now, startHour, endHour) {
  const start = startHour === undefined ? ACTIVE_START_HOUR : Number(startHour);
  const end = endHour === undefined ? ACTIVE_END_HOUR : Number(endHour);
  const h = now.getHours();
  if (start === end) return true;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}

function shortTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

const fmtHours = (v) => (Math.round(Number(v) * 10) / 10);

function textOf(issues, now) {
  const lines = ['【外贸数据平台巡检】' + now.toLocaleString('zh-CN', { hour12: false })];
  issues.forEach((i) => lines.push('- ' + i));
  return lines.join('\n');
}

async function notify(issues, now) {
  if (process.argv.indexOf('--dry-run') >= 0) {
    log.info('alert_dry_run', { text: textOf(issues, now) });
    return;
  }
  if (!isConfigured()) {
    log.warn('alert_no_channel', { issues: issues });
    return;
  }
  const r = await sendText(textOf(issues, now));
  log.info('alert_sent', { ok: r.ok, mode: r.mode, status: r.status, count: issues.length });
}

// 数据源断更：全部停更时合并一条，并区分“从没同步过”
function staleIssues(sources) {
  const never = sources.filter((s) => !s.last_success_at);
  const stale = sources.filter((s) => s.last_success_at && Number(s.age_hours) > STALE_HOURS);
  const issues = [];
  if (never.length) {
    issues.push(never.map((s) => '「' + s.kind + '」').join('、') + ' 从未成功同步');
  }
  if (!stale.length) return issues;
  if (sources.length > 1 && stale.length === sources.length - never.length) {
    // 所有在用数据源一起停更：通常是一次采集停摆，合并成一条更有用
    const lastAt = stale.map((s) => s.last_success_at).sort().slice(-1)[0];
    const minAge = Math.min.apply(null, stale.map((s) => Number(s.age_hours)));
    issues.push('全部 ' + stale.length + ' 个数据源停更 ' + fmtHours(minAge) + ' 小时（最近更新 '
      + shortTime(lastAt) + '），采集链路可能中断');
    return issues;
  }
  stale.forEach((s) => {
    issues.push('数据源「' + s.kind + '」已 ' + fmtHours(s.age_hours) + ' 小时未更新（最后 '
      + shortTime(s.last_success_at) + '）');
  });
  return issues;
}

// 采集器提示：把“登录态未托管 / 登录态失效 / 容器未上报”区分开，直接给出下一步动作
function collectorHint({ state, heartbeat, nowMs }) {
  if (!state) {
    return '云端采集器未托管登录态：请在本机浏览器登录阿里后，到扩展设置页点「同步登录态到云端」，否则关机后无法自动采集';
  }
  const hb = heartbeat || null;
  if (hb) {
    const m = /^collector:([a-z_]+):/.exec(String(hb.version || ''));
    const st = m ? m[1] : '';
    const ageMin = (nowMs - new Date(hb.updated_at).getTime()) / 60000;
    if (st === 'login_expired') {
      return '云端采集器登录态已失效：请重新登录阿里后，在扩展设置页再点一次「同步登录态到云端」';
    }
    if (Number.isFinite(ageMin) && ageMin > 150) {
      return '云端采集器已 ' + fmtHours(ageMin / 60) + ' 小时未上报（容器可能未运行）';
    }
    return '';
  }
  const ageH = (nowMs - new Date(state.updated_at).getTime()) / 3600000;
  if (Number.isFinite(ageH) && ageH > COLLECTOR_STALE_HOURS) {
    return '云端采集器登录态已 ' + fmtHours(ageH) + ' 小时未刷新，建议在扩展设置页重新同步';
  }
  return '';
}

const main = async () => {
  if (!databaseUrl) {
    log.error('alert_abort', { reason: 'missing_database_url' });
    process.exit(1);
  }
  const now = new Date();
  const active = inActiveHours(now, ACTIVE_START_HOUR, ACTIVE_END_HOUR);
  const issues = [];
  const store = new PgStore(databaseUrl);
  try {
    const summary = await store.summary(sellerId);
    const sources = summary.sources || [];
    // 夜间停更属于正常：只在业务时段报数据断更
    if (active) {
      const dataIssues = staleIssues(sources);
      issues.push.apply(issues, dataIssues);
      // 只有在数据确实不新鲜时，才提示采集器，避免与断更原因重复刷屏
      if (dataIssues.length && store.getCollectorState) {
        const [state, heartbeats] = await Promise.all([
          store.getCollectorState(tenantId, sellerId).catch(() => null),
          store.listHeartbeats ? store.listHeartbeats(sellerId).catch(() => []) : Promise.resolve([]),
        ]);
        const hb = (heartbeats || []).filter((h) => h.client_id === 'cloud-collector')[0] || null;
        const hint = collectorHint({ state, heartbeat: hb, nowMs: Date.now() });
        if (hint) issues.push(hint);
      }
    }
    const disk = diskUsage('/');
    if (disk && !disk.ok) {
      issues.push('磁盘占用 ' + disk.used_pct + '%，剩余 ' + disk.free_gb + ' GB');
    }
  } catch (e) {
    issues.push('数据库不可用：' + String((e && e.message) || e));
  } finally {
    await store.close().catch(() => {});
  }

  if (!issues.length) {
    log.info('alert_ok', { seller: sellerId, active: active });
    return;
  }
  await notify(issues, now);
  process.exit(0);
};

if (require.main === module) {
  main().catch((e) => {
    log.error('alert_failed', { error: String((e && e.message) || e) });
    process.exit(1);
  });
}

module.exports = { inActiveHours, staleIssues, collectorHint, shortTime, STALE_HOURS };
