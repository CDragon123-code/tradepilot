'use strict';

// 发送闸门：把每日上限、冷却期、静默时段做成纯函数，便于单测与在不同存储上复用。
// 所有时间判断都按店铺时区（tz_offset_minutes）计算，不用服务器本地时区。

const MINUTES_PER_DAY = 24 * 60;

// "23:00" / "7:00" / "0700" → 分钟数；非法值返回 null
function parseHM(value) {
  const m = /^(\d{1,2}):?(\d{2})$/.exec(String(value === undefined || value === null ? '' : value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

// 店铺本地分钟数（0..1439）
function localMinutes(nowMs, tzOffsetMinutes) {
  const offset = Number.isFinite(Number(tzOffsetMinutes)) ? Number(tzOffsetMinutes) : 480;
  const ms = Number(nowMs) + offset * 60000;
  const minutes = Math.floor(ms / 60000) % MINUTES_PER_DAY;
  return minutes < 0 ? minutes + MINUTES_PER_DAY : minutes;
}

// 店铺本地当天 00:00 对应的 UTC 毫秒
function startOfLocalDay(nowMs, tzOffsetMinutes) {
  const offset = Number.isFinite(Number(tzOffsetMinutes)) ? Number(tzOffsetMinutes) : 480;
  const shifted = Number(nowMs) + offset * 60000;
  const dayStart = Math.floor(shifted / 86400000) * 86400000;
  return dayStart - offset * 60000;
}

// 静默时段是否命中（支持跨零点，如 23:00–07:00）
function inQuietHours(minutes, startHM, endHM) {
  const start = parseHM(startHM);
  const end = parseHM(endHM);
  if (start === null || end === null || start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

// 静默结束时刻（UTC 毫秒）：用于告诉调用方什么时候可以继续
function quietEndAt(nowMs, startHM, endHM, tzOffsetMinutes) {
  const end = parseHM(endHM);
  if (end === null) return null;
  const offset = Number.isFinite(Number(tzOffsetMinutes)) ? Number(tzOffsetMinutes) : 480;
  const minutes = localMinutes(nowMs, offset);
  let delta = (end - minutes + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (delta === 0) delta = MINUTES_PER_DAY;
  return nowMs + delta * 60000;
}

/**
 * 评估一条执行项当前能否发送。
 * @param {object} input
 * @param {object} input.agent       ai_agent 行（daily_limit/cooldown_hours/quiet_start/quiet_end/status/tz_offset_minutes）
 * @param {number} input.sentToday   该业务员店铺本地当天已成功发送条数
 * @param {number|null} input.lastSentAt 同一客户最近一次成功发送时间（毫秒）
 * @param {number} input.nowMs
 * @param {{active?:boolean, reason?:string}|null} [input.dnc] 客户是否在不联系名单
 * @param {boolean} [input.storePaused] 店铺级发送停机开关
 * @param {string} [input.storePauseReason] 停机原因
 */
function evaluate({ agent, sentToday, lastSentAt, nowMs, dnc, storePaused, storePauseReason }) {
  const a = agent || {};
  const now = Number(nowMs) || Date.now();
  const tz = Number.isFinite(Number(a.tz_offset_minutes)) ? Number(a.tz_offset_minutes) : 480;
  const dailyLimit = Math.max(0, Number(a.daily_limit) || 0);
  const cooldownHours = Math.max(0, Number(a.cooldown_hours) || 0);
  const used = Math.max(0, Number(sentToday) || 0);
  const reasons = [];
  let blockedUntil = null;

  // 店铺级停机优先：演练、投诉、账号异常时先全停，不再看业务员与客户条件
  if (storePaused) {
    const reason = String(storePauseReason || '').trim();
    reasons.push({ code: 'store_paused', label: '店铺发送已停机' + (reason ? '：' + reason : '') });
  }

  // 不联系名单：和分配/建任务时同一口径，领取前必须再复核
  if (dnc && dnc.active) {
    const reason = String(dnc.reason || '').trim();
    reasons.push({ code: 'dnc', label: '客户在不联系名单' + (reason ? '：' + reason : '') });
  }

  if (String(a.status || 'active') !== 'active') {
    reasons.push({ code: 'agent_paused', label: '业务员已暂停' });
  }

  if (dailyLimit > 0 && used >= dailyLimit) {
    reasons.push({ code: 'daily_limit', label: '今日已达上限 ' + used + '/' + dailyLimit });
    const nextDay = startOfLocalDay(now, tz) + 86400000;
    blockedUntil = blockedUntil === null ? nextDay : Math.max(blockedUntil, nextDay);
  }

  const minutes = localMinutes(now, tz);
  if (inQuietHours(minutes, a.quiet_start, a.quiet_end)) {
    reasons.push({ code: 'quiet_hours', label: '静默时段 ' + (a.quiet_start || '') + '–' + (a.quiet_end || '') });
    const until = quietEndAt(now, a.quiet_start, a.quiet_end, tz);
    if (until) blockedUntil = blockedUntil === null ? until : Math.max(blockedUntil, until);
  }

  if (cooldownHours > 0 && Number.isFinite(Number(lastSentAt)) && Number(lastSentAt) > 0) {
    const until = Number(lastSentAt) + cooldownHours * 3600000;
    if (until > now) {
      reasons.push({ code: 'cooldown', label: '同客户冷却中（' + cooldownHours + ' 小时）' });
      blockedUntil = blockedUntil === null ? until : Math.max(blockedUntil, until);
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons: reasons,
    daily_used: used,
    daily_limit: dailyLimit,
    tz_offset_minutes: tz,
    local_time: String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0'),
    next_allowed_at: blockedUntil ? new Date(blockedUntil).toISOString() : null,
  };
}

// DNC 记录是否仍在生效：until 为空表示永久；非法/过去时间视为已过期
function dncActive(row, nowMs) {
  if (!row) return false;
  if (!row.until) return true;
  const until = Date.parse(row.until);
  return Number.isFinite(until) && until > (Number(nowMs) || Date.now());
}

// 客户键归一：兼容 inquiry:123 与 123 两种历史写法
function sameCustomerKey(a, b) {
  const norm = (v) => String(v === undefined || v === null ? '' : v).trim().replace(/^inquiry:/i, '');
  const key = norm(a);
  return !!key && key === norm(b);
}

// 白名单：空列表表示不限制（仅人工执行台使用）；自动发送由调用方要求非空
function inAllowlist(allowlist, customerKey, customerName) {
  const list = Array.isArray(allowlist) ? allowlist : [];
  if (!list.length) return false;
  const key = String(customerKey || '');
  const name = String(customerName || '').trim().toLowerCase();
  return list.some((raw) => {
    const item = String(raw || '').trim();
    if (!item) return false;
    if (item === key) return true;
    // 允许直接写询盘 ID 或客户名（不区分大小写）
    if (key.replace(/^inquiry:/, '') === item.replace(/^inquiry:/, '')) return true;
    return name && name === item.toLowerCase();
  });
}

module.exports = {
  parseHM, localMinutes, startOfLocalDay, inQuietHours, quietEndAt, evaluate, inAllowlist,
  dncActive, sameCustomerKey,
};
