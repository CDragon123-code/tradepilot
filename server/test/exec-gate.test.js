'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/exec-gate');

const TZ = 480; // 东八区

test('时间解析：合法与非法输入', () => {
  assert.equal(G.parseHM('23:00'), 1380);
  assert.equal(G.parseHM('7:00'), 420);
  assert.equal(G.parseHM('0700'), 420);
  assert.equal(G.parseHM('24:00'), null);
  assert.equal(G.parseHM('23:60'), null);
  assert.equal(G.parseHM(''), null);
});

test('静默时段：支持跨零点与不跨零点', () => {
  assert.equal(G.inQuietHours(G.parseHM('23:30'), '23:00', '07:00'), true);
  assert.equal(G.inQuietHours(G.parseHM('06:59'), '23:00', '07:00'), true);
  assert.equal(G.inQuietHours(G.parseHM('07:00'), '23:00', '07:00'), false);
  assert.equal(G.inQuietHours(G.parseHM('12:00'), '23:00', '07:00'), false);
  assert.equal(G.inQuietHours(G.parseHM('13:00'), '12:00', '14:00'), true);
  assert.equal(G.inQuietHours(G.parseHM('14:00'), '12:00', '14:00'), false);
  // 起止相同视为不启用静默
  assert.equal(G.inQuietHours(G.parseHM('12:00'), '08:00', '08:00'), false);
});

test('店铺本地当天起点按偏移计算', () => {
  const now = Date.parse('2026-11-13T09:00:00Z'); // 北京 17:00
  assert.equal(new Date(G.startOfLocalDay(now, TZ)).toISOString(), '2026-11-12T16:00:00.000Z');
  assert.equal(G.localMinutes(now, TZ), 17 * 60);
  // UTC 店铺：当天起点就是 UTC 零点
  assert.equal(new Date(G.startOfLocalDay(now, 0)).toISOString(), '2026-11-13T00:00:00.000Z');
});

test('闸门：正常时段允许发送', () => {
  const now = Date.parse('2026-11-13T04:00:00Z'); // 北京 12:00
  const r = G.evaluate({
    agent: { daily_limit: 20, cooldown_hours: 24, quiet_start: '23:00', quiet_end: '07:00', status: 'active', tz_offset_minutes: TZ },
    sentToday: 3, lastSentAt: null, nowMs: now,
  });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.daily_used, 3);
  assert.equal(r.daily_limit, 20);
  assert.equal(r.local_time, '12:00');
  assert.equal(r.next_allowed_at, null);
});

test('闸门：每日上限触顶，次日零点恢复', () => {
  const now = Date.parse('2026-11-13T09:00:00Z'); // 北京 17:00
  const r = G.evaluate({
    agent: { daily_limit: 5, cooldown_hours: 0, quiet_start: '23:00', quiet_end: '07:00', status: 'active', tz_offset_minutes: TZ },
    sentToday: 5, lastSentAt: null, nowMs: now,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reasons[0].code, 'daily_limit');
  // 北京 11-14 00:00 = UTC 11-13 16:00
  assert.equal(r.next_allowed_at, '2026-11-13T16:00:00.000Z');
});

test('闸门：静默时段阻断，结束时间可计算', () => {
  const now = Date.parse('2026-11-13T15:30:00Z'); // 北京 23:30
  const r = G.evaluate({
    agent: { daily_limit: 20, cooldown_hours: 0, quiet_start: '23:00', quiet_end: '07:00', status: 'active', tz_offset_minutes: TZ },
    sentToday: 0, lastSentAt: null, nowMs: now,
  });
  assert.equal(r.allowed, false);
  assert.deepEqual(r.reasons.map((x) => x.code), ['quiet_hours']);
  // 次日北京 07:00 = UTC 23:00（当天）
  assert.equal(r.next_allowed_at, '2026-11-13T23:00:00.000Z');
});

test('闸门：同客户冷却中', () => {
  const now = Date.parse('2026-11-13T04:00:00Z');
  const r = G.evaluate({
    agent: { daily_limit: 20, cooldown_hours: 24, quiet_start: '23:00', quiet_end: '07:00', status: 'active', tz_offset_minutes: TZ },
    sentToday: 1, lastSentAt: now - 3600000, nowMs: now,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reasons[0].code, 'cooldown');
  assert.equal(r.next_allowed_at, new Date(now - 3600000 + 24 * 3600000).toISOString());
});

test('闸门：业务员暂停优先阻断', () => {
  const now = Date.parse('2026-11-13T04:00:00Z');
  const r = G.evaluate({
    agent: { daily_limit: 20, cooldown_hours: 0, quiet_start: '23:00', quiet_end: '07:00', status: 'disabled', tz_offset_minutes: TZ },
    sentToday: 0, lastSentAt: null, nowMs: now,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reasons[0].code, 'agent_paused');
});

test('闸门：店铺停机与 DNC 优先阻断，并带出原因', () => {
  const now = Date.parse('2026-11-13T04:00:00Z');
  const r = G.evaluate({
    agent: { daily_limit: 20, cooldown_hours: 24, quiet_start: '23:00', quiet_end: '07:00', status: 'active', tz_offset_minutes: TZ },
    sentToday: 3, lastSentAt: null, nowMs: now,
    storePaused: true, storePauseReason: '投诉演练',
    dnc: { active: true, reason: '买家拒绝联系' },
  });
  assert.equal(r.allowed, false);
  assert.deepEqual(r.reasons.map((x) => x.code), ['store_paused', 'dnc']);
  assert.match(r.reasons[0].label, /投诉演练/);
  assert.match(r.reasons[1].label, /买家拒绝联系/);
  assert.equal(r.next_allowed_at, null);
});

test('DNC 有效期：until 过期或非法不再阻断', () => {
  const now = Date.parse('2026-11-13T04:00:00Z');
  assert.equal(G.dncActive({ until: null }, now), true);
  assert.equal(G.dncActive({ until: '2026-11-14T00:00:00.000Z' }, now), true);
  assert.equal(G.dncActive({ until: '2026-11-12T00:00:00.000Z' }, now), false);
  assert.equal(G.dncActive({ until: 'not-a-date' }, now), false);
  assert.equal(G.dncActive(null, now), false);
});

test('客户键归一：兼容 inquiry: 前缀', () => {
  assert.equal(G.sameCustomerKey('inquiry:123', '123'), true);
  assert.equal(G.sameCustomerKey('INQUIRY:123', 'inquiry:123'), true);
  assert.equal(G.sameCustomerKey('123', '124'), false);
  assert.equal(G.sameCustomerKey('', ''), false);
});

test('白名单：空列表不放行，支持询盘 ID 与客户名', () => {
  assert.equal(G.inAllowlist([], 'inquiry:123', 'Ann'), false);
  assert.equal(G.inAllowlist(['123'], 'inquiry:123', 'Ann'), true);
  assert.equal(G.inAllowlist(['inquiry:123'], 'inquiry:123', 'Ann'), true);
  assert.equal(G.inAllowlist(['ann'], 'inquiry:999', 'Ann'), true);
  assert.equal(G.inAllowlist(['bob'], 'inquiry:999', 'Ann'), false);
});
