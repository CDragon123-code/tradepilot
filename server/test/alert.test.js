'use strict';

// 巡检降噪：夜间静默、全部停更合并、从未同步单列
const test = require('node:test');
const assert = require('node:assert/strict');
const { inActiveHours, staleIssues, collectorHint, shortTime } = require('../src/alert-cli');

test('业务时段判断：夜间不报数据断更', () => {
  const at = (h) => new Date(2026, 10, 14, h, 0, 0);
  assert.equal(inActiveHours(at(9), 8, 20), true);
  assert.equal(inActiveHours(at(19), 8, 20), true);
  assert.equal(inActiveHours(at(20), 8, 20), false);
  assert.equal(inActiveHours(at(3), 8, 20), false);
  assert.equal(inActiveHours(at(23), 22, 6), true);
  assert.equal(inActiveHours(at(5), 22, 6), true);
  assert.equal(inActiveHours(at(12), 22, 6), false);
  // 起止相同=全天
  assert.equal(inActiveHours(at(3), 0, 0), true);
});

const KINDS = ['chat', 'customer', 'inquiry', 'order', 'public_customer', 'visitor'];

function source(kind, ageHours, lastAt) {
  return {
    kind,
    age_hours: ageHours,
    last_success_at: lastAt === undefined ? new Date(Date.now() - ageHours * 3600000).toISOString() : lastAt,
  };
}

test('全部数据源停更时合并成一条，不再逐条刷屏', () => {
  const issues = staleIssues(KINDS.map((k) => source(k, 15.6)));
  assert.equal(issues.length, 1);
  assert.ok(issues[0].indexOf('全部 6 个数据源停更 15.6 小时') >= 0);
  assert.ok(issues[0].indexOf('采集链路可能中断') >= 0);
});

test('部分数据源停更时逐条列出', () => {
  const rows = [
    source('inquiry', 15.6),
    source('chat', 0.5),
    source('customer', 0.5),
    source('order', 0.5),
    source('public_customer', 0.5),
    source('visitor', 0.5),
  ];
  const issues = staleIssues(rows);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].indexOf('数据源「inquiry」') >= 0);
});

test('从未成功同步单独提示，且不影响合并判断', () => {
  const rows = [
    source('inquiry', 15.6),
    source('chat', 15.6),
    { kind: 'visitor', age_hours: null, last_success_at: null },
  ];
  const issues = staleIssues(rows);
  assert.equal(issues.length, 2);
  assert.ok(issues[0].indexOf('从未成功同步') >= 0);
  assert.ok(issues[1].indexOf('全部 2 个数据源停更') >= 0);
});

test('未超阈值时不告警', () => {
  assert.deepEqual(staleIssues(KINDS.map((k) => source(k, 1))), []);
  assert.deepEqual(staleIssues([]), []);
});

test('时间格式：月-日 时:分', () => {
  assert.equal(shortTime('2026-11-13T09:21:00.000Z'), shortTime('2026-11-13T09:21:00.000Z'));
  assert.ok(/^\d{2}-\d{2} \d{2}:\d{2}$/.test(shortTime('2026-11-13T09:21:00.000Z')));
  assert.equal(shortTime(''), '');
  assert.equal(shortTime('not-a-date'), '');
});

test('采集器提示：未托管 / 登录态失效 / 容器未上报 / 正常', () => {
  const now = Date.now();
  const fresh = new Date(now - 5 * 60000).toISOString();
  // 未托管
  assert.ok(collectorHint({ state: null, heartbeat: null, nowMs: now }).indexOf('未托管登录态') >= 0);
  // 已托管但登录态失效（心跳里带状态）
  const expired = collectorHint({
    state: { updated_at: fresh },
    heartbeat: { client_id: 'cloud-collector', version: 'collector:login_expired:0', updated_at: fresh },
    nowMs: now,
  });
  assert.ok(expired.indexOf('登录态已失效') >= 0);
  // 心跳正常且新鲜：不提示
  const ok = collectorHint({
    state: { updated_at: fresh },
    heartbeat: { client_id: 'cloud-collector', version: 'collector:ok:12', updated_at: fresh },
    nowMs: now,
  });
  assert.equal(ok, '');
  // 心跳陈旧：容器可能没跑
  const old = collectorHint({
    state: { updated_at: fresh },
    heartbeat: { client_id: 'cloud-collector', version: 'collector:ok:12', updated_at: new Date(now - 4 * 3600000).toISOString() },
    nowMs: now,
  });
  assert.ok(old.indexOf('未上报') >= 0);
  // 无心跳但登录态很旧：建议刷新
  const staleState = collectorHint({
    state: { updated_at: new Date(now - 100 * 3600000).toISOString() },
    heartbeat: null, nowMs: now,
  });
  assert.ok(staleState.indexOf('未刷新') >= 0);
});
