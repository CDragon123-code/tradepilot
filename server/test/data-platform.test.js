'use strict';

// 数据中台 P0：待办 / 客户档案 / 经营指标 / 发送门禁
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHandler } = require('../src/app');
const { MemoryStore } = require('../src/store-memory');

const NOW = new Date().toISOString();
const INQUIRIES = [
  { platform_id: 'i1', payload: { 询盘ID: 'i1', 客户名称: 'Ann', 公司名称: 'A Co', 国家: '美国', 来源: '营销商机', 买家等级: 'L3', 是否已加为客户: '是', 创建时间: NOW, 询盘主题: 'Resin', 负责人: '张三' } },
  { platform_id: 'i2', payload: { 询盘ID: 'i2', 客户名称: 'Ann', 公司名称: 'A Co', 国家: '美国', 来源: '自然搜索', 买家等级: 'L3', 创建时间: NOW, 询盘主题: 'Printer', 负责人: '张三' } },
];
const CUSTOMERS = [
  { platform_id: 'cu1', payload: { '客户ID': 'cu1', '联系人': 'Ann', '公司名称': 'A Co', '国家/地区': '美国', '买家等级': 'L3', '负责人': '张三', '邮箱': 'ann@example.com' } },
];
const CHATS = [
  { platform_id: 'c1', payload: { 会话: 'Ann', 发送时间: NOW, 角色: '客户', 内容: 'hi' } },
];
const ORDERS = [
  { platform_id: 'o1', payload: { 订单ID: 'o1', 订单状态: '已完成', 成交金额: '100', 币种: 'USD', 下单时间: NOW, 客户名称: 'Ann', 公司名称: 'A Co' } },
];

async function start() {
  const store = new MemoryStore();
  const server = http.createServer(createHandler({ store, token: 'test-token', sellerId: 'seller-1' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    store,
    base: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function call(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, body: data };
}

async function load(base, kind, rows) {
  const created = await call(base, 'POST', '/imports', { kind });
  assert.ok(created.status === 200 || created.status === 201);
  const part = await call(base, 'PUT', '/imports/' + created.body.import_id + '/parts/1', { rows });
  assert.equal(part.status, 200);
  const commit = await call(base, 'POST', '/imports/' + created.body.import_id + '/commit');
  assert.equal(commit.status, 200);
}

async function seed(base) {
  await load(base, 'inquiry', INQUIRIES);
  await load(base, 'customer', CUSTOMERS);
  await load(base, 'chat', CHATS);
  await load(base, 'order', ORDERS);
}

function customerUid() {
  const domain = require('../src/domain').loadDomain();
  const idx = domain.identity.build({
    inquiry: INQUIRIES.map((row) => row.payload),
    customer: CUSTOMERS.map((row) => row.payload),
    public_customer: [], chat: CHATS.map((row) => row.payload), order: ORDERS.map((row) => row.payload),
  });
  return idx.uidOfCustomer(CUSTOMERS[0].payload);
}

test('数据中台：待办接口返回云端计算结果与数据版本', async () => {
  const app = await start();
  try {
    await seed(app.base);
    const r = await call(app.base, 'GET', '/api/todos?status=all');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.todos));
    assert.ok(r.body.counts && typeof r.body.counts.total === 'number');
    assert.ok(r.body.data_version);
  } finally { await app.close(); }
});

test('数据中台：客户档案返回分层、负责人、完整度与订单', async () => {
  const app = await start();
  try {
    await seed(app.base);
    const uid = customerUid();
    const r = await call(app.base, 'GET', '/api/customer-profile?uid=' + encodeURIComponent(uid));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.profile.name, 'Ann');
    assert.equal(r.body.profile.company, 'A Co');
    assert.equal(r.body.profile.level, 'L3');
    assert.equal(r.body.profile.owner, '张三');
    assert.equal(r.body.profile.inquiry_count, 2);
    assert.equal(r.body.inquiries.length, 2);
    assert.equal(r.body.order_count, 1);
    assert.ok(r.body.profile.completeness.percent > 0);
  } finally { await app.close(); }
});

test('数据中台：经营指标返回 KPI、漏斗与趋势', async () => {
  const app = await start();
  try {
    await seed(app.base);
    const r = await call(app.base, 'GET', '/api/metrics/overview');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.kpis) && r.body.kpis.length >= 5);
    assert.ok(Array.isArray(r.body.funnel) && r.body.funnel.length >= 3);
    assert.ok(Array.isArray(r.body.trend));
    assert.ok(r.body.headline);
    assert.ok(r.body.data_version);
  } finally { await app.close(); }
});

test('数据中台：发送门禁能拦住 DNC 与店铺停机', async () => {
  const app = await start();
  try {
    await seed(app.base);
    const ok = await call(app.base, 'POST', '/api/send-check', { customer_key: 'cu1' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.allowed, true);

    await app.store.upsertDnc({ tenantId: 'default', sellerId: 'seller-1', customerKey: 'cu1', reason: '客户要求不再联系' });
    const blocked = await call(app.base, 'POST', '/api/send-check', { customer_key: 'cu1' });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.allowed, false);
    assert.ok(blocked.body.reasons.some((x) => x.code === 'dnc'));

    await app.store.upsertDnc({ tenantId: 'default', sellerId: 'seller-1', customerKey: 'cu1', reason: '', until: '2000-01-01T00:00:00.000Z' });
    await app.store.setSellerControl({ tenantId: 'default', sellerId: 'seller-1', paused: true, reason: '演练' });
    const paused = await call(app.base, 'POST', '/api/send-check', { customer_key: 'i1' });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.allowed, false);
    assert.ok(paused.body.reasons.some((x) => x.code === 'store_paused'));
  } finally { await app.close(); }
});
