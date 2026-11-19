'use strict';

// M2.3 / M2.4：发送闸门与执行租约的接口级验证
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHandler } = require('../src/app');
const { MemoryStore } = require('../src/store-memory');
const { hashPassword } = require('../src/auth');

async function call(base, method, path, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + path, {
    method: method, headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, body: data };
}

async function setup(agentPatch) {
  const store = new MemoryStore();
  const admin = await store.createEmployee({
    tenantId: 'default', email: 'admin@example.com', name: 'Admin',
    passwordHash: hashPassword('adminpass1'), role: 'admin',
  });
  await store.bindMembership({ employeeId: admin.id, tenantId: 'default', sellerId: 'seller-1' });
  const server = http.createServer(createHandler({
    store, ingestToken: 'ingest-t', readToken: 'read-t', sellerId: 'seller-1', tenantId: 'default',
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = await call(base, 'POST', '/auth/login', { email: 'admin@example.com', password: 'adminpass1' }, '');
  assert.equal(login.status, 200);
  const agent = await store.createAgent(Object.assign({
    tenantId: 'default', sellerId: 'seller-1', name: '首响助手',
    dailyLimit: 20, cooldownHours: 24, quietStart: '23:00', quietEnd: '07:00',
  }, agentPatch || {}));
  const close = () => new Promise((resolve) => server.close(resolve));
  return { store, base, token: login.body.token, agent, close };
}

test('执行队列：返回闸门状态，正常时段可发送', async () => {
  const app = await setup({ quietStart: '00:00', quietEnd: '00:00' }); // 关闭静默
  try {
    const item = await app.store.seedTaskItem({
      tenantId: 'default', sellerId: 'seller-1', agentId: app.agent.id,
      customerKey: 'inquiry:1001', draftText: 'Hello, thanks for your inquiry.', customerName: 'Ann',
    });
    const list = await call(app.base, 'GET', '/api/executions?limit=10', undefined, app.token);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.allowed_count, 1);
    const row = list.body.items[0];
    assert.equal(row.id, item.id);
    assert.equal(row.gate.allowed, true);
    assert.equal(row.gate.daily_limit, 20);
    assert.equal(row.agent_name, '首响助手');
  } finally { await app.close(); }
});

test('执行租约：首次领取成功，重复领取被拒，回写幂等', async () => {
  const app = await setup({ quietStart: '00:00', quietEnd: '00:00' });
  try {
    const item = await app.store.seedTaskItem({
      tenantId: 'default', sellerId: 'seller-1', agentId: app.agent.id,
      customerKey: 'inquiry:2001', draftText: 'Draft A', customerName: 'Bob',
    });
    const first = await call(app.base, 'POST', '/api/executions/' + item.id + '/claim',
      { client_id: 'client-a', lease_seconds: 300 }, app.token);
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.ok(first.body.claim_token);

    const again = await call(app.base, 'POST', '/api/executions/' + item.id + '/claim',
      { client_id: 'client-b', lease_seconds: 300 }, app.token);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'claimed_by_other');

    const sent = await call(app.base, 'POST', '/api/executions/' + item.id + '/result',
      { status: 'sent', note: 'auto' }, app.token);
    assert.equal(sent.status, 200);
    assert.equal(sent.body.ok, true);

    // 同一状态再次回写：幂等，不报错也不重复计数
    const repeat = await call(app.base, 'POST', '/api/executions/' + item.id + '/result',
      { status: 'sent' }, app.token);
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.idempotent, true);

    // 已发送后不能再回写失败
    const flip = await call(app.base, 'POST', '/api/executions/' + item.id + '/result',
      { status: 'failed' }, app.token);
    assert.equal(flip.status, 409);
    assert.equal(flip.body.error, 'status_conflict');

    // 已发送的不能再领取
    const reclaim = await call(app.base, 'POST', '/api/executions/' + item.id + '/claim', {}, app.token);
    assert.equal(reclaim.status, 409);
    assert.equal(reclaim.body.error, 'already_sent');
  } finally { await app.close(); }
});

test('执行闸门：每日上限触顶后拒绝领取', async () => {
  const app = await setup({ dailyLimit: 1, cooldownHours: 0, quietStart: '00:00', quietEnd: '00:00' });
  try {
    const done = await app.store.seedTaskItem({
      tenantId: 'default', sellerId: 'seller-1', agentId: app.agent.id,
      customerKey: 'inquiry:3001', draftText: 'first', customerName: 'Cara',
    });
    await app.store.markExecution(done.id, { status: 'sent' });

    const pending = await app.store.seedTaskItem({
      tenantId: 'default', sellerId: 'seller-1', agentId: app.agent.id,
      customerKey: 'inquiry:3002', draftText: 'second', customerName: 'Dan',
    });
    const list = await call(app.base, 'GET', '/api/executions', undefined, app.token);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].gate.allowed, false);
    assert.equal(list.body.items[0].gate.reasons[0].code, 'daily_limit');
    assert.equal(list.body.blocked_count, 1);

    const claim = await call(app.base, 'POST', '/api/executions/' + pending.id + '/claim', {}, app.token);
    assert.equal(claim.status, 409);
    assert.equal(claim.body.error, 'gate_blocked');
  } finally { await app.close(); }
});

test('执行闸门：静默时段拒绝领取，同客户冷却拒绝领取', async () => {
  // 全天静默，确保与运行时区无关
  const app = await setup({ cooldownHours: 24, quietStart: '00:00', quietEnd: '23:59' });
  try {
    const item = await app.store.seedTaskItem({
      tenantId: 'default', sellerId: 'seller-1', agentId: app.agent.id,
      customerKey: 'inquiry:4001', draftText: 'quiet', customerName: 'Eve',
    });
    const claim = await call(app.base, 'POST', '/api/executions/' + item.id + '/claim', {}, app.token);
    assert.equal(claim.status, 409);
    assert.equal(claim.body.error, 'gate_blocked');
    assert.equal(claim.body.reasons[0].code, 'quiet_hours');
  } finally { await app.close(); }

  const app2 = await setup({ cooldownHours: 24, quietStart: '00:00', quietEnd: '00:00' });
  try {
    const first = await app2.store.seedTaskItem({
      tenantId: 'default', sellerId: 'seller-1', agentId: app2.agent.id,
      customerKey: 'inquiry:5001', draftText: 'one', customerName: 'Fay',
    });
    await app2.store.markExecution(first.id, { status: 'sent' });
    const second = await app2.store.seedTaskItem({
      tenantId: 'default', sellerId: 'seller-1', agentId: app2.agent.id,
      customerKey: 'inquiry:5001', draftText: 'two', customerName: 'Fay',
    });
    const claim = await call(app2.base, 'POST', '/api/executions/' + second.id + '/claim', {}, app2.token);
    assert.equal(claim.status, 409);
    assert.equal(claim.body.reasons[0].code, 'cooldown');
  } finally { await app2.close(); }
});

test('执行接口：机器令牌不可访问', async () => {
  const app = await setup({});
  try {
    const res = await call(app.base, 'GET', '/api/executions', undefined, 'read-t');
    assert.equal(res.status, 403);
  } finally { await app.close(); }
});

test('发送复核：DNC 在执行列表、领取与存储层都被阻断', async () => {
  const app = await setup({ quietStart: '00:00', quietEnd: '00:00' });
  try {
    const item = await app.store.seedTaskItem({
      tenantId: 'default', sellerId: 'seller-1', agentId: app.agent.id,
      customerKey: 'inquiry:6001', draftText: 'Hello', customerName: 'Gina',
    });
    // 故意不带 inquiry: 前缀，验证客户键归一
    await app.store.upsertDnc({
      tenantId: 'default', sellerId: 'seller-1', customerKey: '6001', reason: '买家拒绝联系',
    });

    const list = await call(app.base, 'GET', '/api/executions', undefined, app.token);
    assert.equal(list.status, 200);
    assert.equal(list.body.allowed_count, 0);
    assert.equal(list.body.blocked_count, 1);
    assert.equal(list.body.items[0].gate.allowed, false);
    assert.equal(list.body.items[0].gate.reasons[0].code, 'dnc');
    assert.match(list.body.items[0].gate.reasons[0].label, /买家拒绝联系/);

    const claim = await call(app.base, 'POST', '/api/executions/' + item.id + '/claim',
      { client_id: 'client-dnc' }, app.token);
    assert.equal(claim.status, 409);
    assert.equal(claim.body.error, 'gate_blocked');
    assert.equal(claim.body.reasons[0].code, 'dnc');

    // 即使绕过接口直接调用存储层，也必须被原子复核拦住
    const direct = await app.store.claimExecution(item.id, { clientId: 'direct' });
    assert.equal(direct.ok, false);
    assert.equal(direct.code, 'dnc_blocked');
  } finally { await app.close(); }
});

test('发送复核：店铺停机开关阻断列表与领取，恢复后放行', async () => {
  const app = await setup({ quietStart: '00:00', quietEnd: '00:00' });
  try {
    const item = await app.store.seedTaskItem({
      tenantId: 'default', sellerId: 'seller-1', agentId: app.agent.id,
      customerKey: 'inquiry:6101', draftText: 'Hello', customerName: 'Hank',
    });

    const pause = await call(app.base, 'PUT', '/api/send-control',
      { paused: true, reason: '投诉演练' }, app.token);
    assert.equal(pause.status, 200);
    assert.equal(pause.body.control.send_paused, true);
    assert.equal(pause.body.control.pause_reason, '投诉演练');

    const list = await call(app.base, 'GET', '/api/executions', undefined, app.token);
    assert.equal(list.body.store_paused, true);
    assert.equal(list.body.store_pause_reason, '投诉演练');
    assert.equal(list.body.items[0].gate.allowed, false);
    assert.equal(list.body.items[0].gate.reasons[0].code, 'store_paused');

    const claim = await call(app.base, 'POST', '/api/executions/' + item.id + '/claim',
      { client_id: 'client-paused' }, app.token);
    assert.equal(claim.status, 409);
    assert.equal(claim.body.error, 'gate_blocked');
    assert.equal(claim.body.reasons[0].code, 'store_paused');

    const direct = await app.store.claimExecution(item.id, { clientId: 'direct' });
    assert.equal(direct.ok, false);
    assert.equal(direct.code, 'store_paused');

    const resume = await call(app.base, 'PUT', '/api/send-control', { paused: false }, app.token);
    assert.equal(resume.status, 200);
    assert.equal(resume.body.control.send_paused, false);
    assert.equal(resume.body.control.pause_reason, '');

    const list2 = await call(app.base, 'GET', '/api/executions', undefined, app.token);
    assert.equal(list2.body.store_paused, false);
    assert.equal(list2.body.allowed_count, 1);
    const claim2 = await call(app.base, 'POST', '/api/executions/' + item.id + '/claim',
      { client_id: 'client-ok' }, app.token);
    assert.equal(claim2.status, 200);
    assert.equal(claim2.body.ok, true);
  } finally { await app.close(); }
});

test('DNC 接口：新增、列表与删除；过期记录不阻断', async () => {
  const app = await setup({ quietStart: '00:00', quietEnd: '00:00' });
  try {
    await app.store.seedTaskItem({
      tenantId: 'default', sellerId: 'seller-1', agentId: app.agent.id,
      customerKey: 'inquiry:7002', draftText: 'Hello', customerName: 'Ivy',
    });

    const expired = await call(app.base, 'POST', '/api/dnc',
      { customer_key: 'inquiry:7001', reason: '临时', until: '2020-01-01T00:00:00.000Z' }, app.token);
    assert.equal(expired.status, 201);
    const all = await call(app.base, 'GET', '/api/dnc?active=0', undefined, app.token);
    assert.equal(all.body.items.length, 1);
    assert.equal(all.body.items[0].active, false);
    const activeOnly = await call(app.base, 'GET', '/api/dnc', undefined, app.token);
    assert.equal(activeOnly.body.items.length, 0);

    const added = await call(app.base, 'POST', '/api/dnc',
      { customer_key: 'inquiry:7002', reason: '买家拒绝' }, app.token);
    assert.equal(added.status, 201);
    const list = await call(app.base, 'GET', '/api/executions', undefined, app.token);
    assert.equal(list.body.allowed_count, 0);
    assert.equal(list.body.items[0].gate.reasons[0].code, 'dnc');

    const removed = await call(app.base, 'DELETE', '/api/dnc?customer_key=inquiry:7002',
      undefined, app.token);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);
    const list2 = await call(app.base, 'GET', '/api/executions', undefined, app.token);
    assert.equal(list2.body.allowed_count, 1);
    assert.equal(list2.body.items[0].gate.allowed, true);
  } finally { await app.close(); }
});

test('发送复核接口：管理员之外的身份不可修改停机开关', async () => {
  const app = await setup({});
  try {
    const res = await call(app.base, 'PUT', '/api/send-control', { paused: true }, 'read-t');
    assert.equal(res.status, 403);
  } finally { await app.close(); }
});
