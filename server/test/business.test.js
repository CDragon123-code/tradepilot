'use strict';

// 经营总览：指标、漏斗、趋势、身份、新鲜度与 AI 状态聚合
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHandler } = require('../src/app');
const { MemoryStore } = require('../src/store-memory');
const { hashPassword } = require('../src/auth');

const NOW = new Date().toISOString();

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

async function setup() {
  const store = new MemoryStore();
  const admin = await store.createEmployee({
    tenantId: 'default', email: 'admin@example.com', name: 'Admin',
    passwordHash: hashPassword('adminpass1'), role: 'admin',
  });
  await store.bindMembership({ employeeId: admin.id, tenantId: 'default', sellerId: 'seller-main' });
  const server = http.createServer(createHandler({
    store, ingestToken: 'ingest-t', readToken: 'read-t', sellerId: 'seller-main', tenantId: 'default',
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = await call(base, 'POST', '/auth/login', { email: 'admin@example.com', password: 'adminpass1' });
  assert.equal(login.status, 200);
  return { store, base, token: login.body.token, close: () => new Promise((r) => server.close(r)) };
}

async function load(base, kind, rows) {
  const created = await call(base, 'POST', '/imports', { kind }, 'ingest-t');
  assert.ok(created.status === 200 || created.status === 201);
  const part = await call(base, 'PUT', '/imports/' + created.body.import_id + '/parts/1', { rows }, 'ingest-t');
  assert.equal(part.status, 200);
  const commit = await call(base, 'POST', '/imports/' + created.body.import_id + '/commit', undefined, 'ingest-t');
  assert.equal(commit.status, 200);
}

async function seed(base) {
  await load(base, 'inquiry', [
    { platform_id: 'i1', payload: { 询盘ID: 'i1', 客户名称: 'Ann', 公司名称: 'A Trading Co', 国家: '美国', 来源: '营销商机', 买家等级: 'L3', 是否已加为客户: '是', 创建时间: NOW, 询盘主题: 'Resin', 负责人: '张三', 回复状态: '已回复' } },
    { platform_id: 'i2', payload: { 询盘ID: 'i2', 客户名称: 'Bob', 公司名称: 'B Trading Co', 国家: '德国', 来源: '自然搜索', 买家等级: 'L2', 创建时间: NOW, 询盘主题: 'Printer', 负责人: '李四', 回复状态: '待回复' } },
    { platform_id: 'i3', payload: { 询盘ID: 'i3', 客户名称: '', 公司名称: 'C Trading Co', 国家: '美国', 来源: '营销商机', '买家等级(字母)': 'L1', 创建时间: NOW, 询盘主题: 'Film', 负责人: '张三', 回复状态: '待回复' } },
    { platform_id: 'i4', payload: { 询盘ID: 'i4', 客户名称: 'Dora', 公司名称: 'D Trading Co', 国家: '美国', 来源: 'APP端详情页商机', 创建时间: NOW, 询盘主题: 'Packaging', 负责人: 'Sub Account', 回复状态: '待回复' } },
  ]);
  await load(base, 'customer', [
    { platform_id: 'cu1', payload: { 客户ID: 'cu1', 联系人: 'Ann', 公司名称: 'A Trading Co', '国家/地区': '美国', 买家等级: 'L3', 负责人: '张三', 邮箱: 'ann@example.com' } },
  ]);
  await load(base, 'chat', [
    { platform_id: 'c1', payload: { 会话: 'Ann', 发送时间: NOW, 角色: '客户', 内容: 'hi' } },
  ]);
  await load(base, 'order', [
    { platform_id: 'o1', payload: { 订单ID: 'o1', 订单状态: '已完成', 成交金额: '100', 币种: 'USD', 下单时间: NOW, 客户名称: 'Ann', 公司名称: 'A Trading Co', 询盘ID: 'i1' } },
    { platform_id: 'o2', payload: { 订单ID: 'o2', 订单状态: '已完成', 成交金额: '50', 币种: 'USD', 下单时间: '2026-05-18', 客户名称: 'Bob', 公司名称: 'B Trading Co' } },
  ]);
}

test('经营总览：返回 KPI、漏斗、趋势、身份、新鲜度与 AI 状态', async () => {
  const app = await setup();
  try {
    await seed(app.base);
    await app.store.createAlibabaAccount({
      tenantId: 'default', sellerId: 'seller-main', loginName: 'main_account',
      accountType: 'main', ownerName: 'main_account', displayName: '主账号',
    });
    const r = await call(app.base, 'GET', '/api/business/overview', undefined, app.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.owner, '全部');
    assert.equal(r.body.owner_labels['main_account'], '主账号');
    assert.ok(r.body.headline.indexOf('近30天') >= 0);
    assert.ok(Array.isArray(r.body.kpis) && r.body.kpis.length === 12);
    const kpi = (label) => r.body.kpis.find((item) => item[0] === label);
    assert.equal(kpi('近30天订单')[1], 1);
    assert.equal(kpi('累计订单')[1], 2);
    assert.equal(kpi('近30天成交额')[1], 'USD 100');
    assert.equal(kpi('累计成交额')[1], 'USD 150');
    assert.equal(r.body.funnel.length, 4);
    assert.equal(r.body.trend.length, 6);
    assert.equal(r.body.identity.inquiries, 4);
    assert.ok(r.body.identity.profiles >= 1);
    assert.ok(Array.isArray(r.body.freshness) && r.body.freshness.length >= 4);
    assert.ok(r.body.ai && r.body.ai.items);
    assert.ok(Array.isArray(r.body.quality));
    assert.ok(r.body.quality_recent.some((row) => row.id === 'name' && row.recent_count === 1));
    assert.ok(r.body.quality_recent.some((row) => row.id === 'grade' && row.recent_count === 1));
    assert.equal(r.body.grade_missing.length, 1);
    assert.equal(r.body.grade_missing[0].inquiry_id, 'i4');
    assert.equal(r.body.grade_missing[0].source, 'APP端详情页商机');
    assert.equal(r.body.grade_missing[0].owner, 'Sub Account');
    assert.equal(r.body.grade_missing_summary.total, 1);
    assert.ok(r.body.quality_history.some((row) => row.id === 'order-link' && row.history_count === 1));
    assert.equal(r.body.direct_deals.length, 1);
    assert.equal(r.body.direct_summary.orders, 1);
    assert.equal(r.body.direct_deals[0].orders, 1);
    assert.equal(r.body.direct_deals[0].amounts[0].amount, 50);
    assert.ok(Array.isArray(r.body.gmv) && r.body.gmv.length === 1);
    assert.equal(r.body.gmv[0].amount, 150);
    assert.ok(r.body.headline.indexOf('近30天成交') >= 0);
    assert.ok(r.body.headline.indexOf('累计成交') >= 0);
    assert.ok(r.body.data_version);
  } finally { await app.close(); }
});

test('经营总览：只读令牌可访问，并支持按负责人筛选', async () => {
  const app = await setup();
  try {
    await seed(app.base);
    const read = await call(app.base, 'GET', '/api/business/overview', undefined, 'read-t');
    assert.equal(read.status, 200);
    assert.equal(read.body.identity.inquiries, 4);

    const filtered = await call(app.base, 'GET', '/api/business/overview?owner=' + encodeURIComponent('张三'), undefined, 'read-t');
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.owner, '张三');
    assert.equal(filtered.body.identity.inquiries, 2);
    assert.equal(filtered.body.grade_missing.length, 0);
    assert.ok(filtered.body.headline.indexOf('近30天') >= 0);
  } finally { await app.close(); }
});
