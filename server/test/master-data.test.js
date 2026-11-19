'use strict';

// 数据中台 P1：数据资产字典 / 主数据合并与取消合并
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHandler } = require('../src/app');
const { MemoryStore } = require('../src/store-memory');
const { hashPassword } = require('../src/auth');

const NOW = new Date().toISOString();
const INQUIRIES = [
  { platform_id: 'i1', payload: { 询盘ID: 'i1', 客户名称: 'Ann', 公司名称: 'A Trading Co', 国家: '美国', 来源: '营销商机', 买家等级: 'L3', 创建时间: NOW, 询盘主题: 'Resin', 负责人: '张三' } },
];
const CUSTOMERS = [
  { platform_id: 'cu1', payload: { '客户ID': 'cu1', '联系人': 'Ann', '公司名称': 'A Trading Co', '国家/地区': '美国', '买家等级': 'L3', '负责人': '张三', '邮箱': 'ann@example.com' } },
  { platform_id: 'cu2', payload: { '客户ID': 'cu2', '联系人': 'Ann', '公司名称': 'A Trading Co., Ltd', '国家/地区': '美国' } },
];

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
  await store.bindMembership({ employeeId: admin.id, tenantId: 'default', sellerId: 'seller-1' });
  const server = http.createServer(createHandler({
    store, ingestToken: 'ingest-t', readToken: 'read-t', sellerId: 'seller-1', tenantId: 'default',
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
  await load(base, 'inquiry', INQUIRIES);
  await load(base, 'customer', CUSTOMERS);
}

function uids() {
  const domain = require('../src/domain').loadDomain();
  const idx = domain.identity.build({
    inquiry: INQUIRIES.map((row) => row.payload),
    customer: CUSTOMERS.map((row) => row.payload),
    public_customer: [], chat: [], order: [],
  });
  return {
    primary: idx.uidOfCustomer(CUSTOMERS[0].payload),
    second: idx.uidOfCustomer(CUSTOMERS[1].payload),
  };
}

test('数据资产：按数据源返回字段覆盖率、样本与新鲜度', async () => {
  const app = await setup();
  try {
    await seed(app.base);
    const r = await call(app.base, 'GET', '/api/data-assets?kind=inquiry&sample=100&rows=5', undefined, app.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'inquiry');
    assert.equal(r.body.total, 1);
    assert.equal(r.body.sample_size, 1);
    assert.ok(Array.isArray(r.body.fields) && r.body.fields.length > 0);
    const field = r.body.fields.find((item) => item.key === '询盘ID');
    assert.ok(field);
    assert.equal(field.ratio, 100);
    assert.equal(r.body.rows.length, 1);
    assert.ok(r.body.data_version);

    const bad = await call(app.base, 'GET', '/api/data-assets?kind=nope', undefined, app.token);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'kind_invalid');
  } finally { await app.close(); }
});

test('主数据：返回重复候选，合并后档案收敛且客户档案可反查', async () => {
  const app = await setup();
  try {
    await seed(app.base);
    const { primary, second } = uids();
    assert.notEqual(primary, second);

    const before = await call(app.base, 'GET', '/api/master-data', undefined, app.token);
    assert.equal(before.status, 200);
    assert.equal(before.body.summary.profiles, 2);
    assert.ok(before.body.summary.duplicate_groups >= 1);
    assert.ok(before.body.duplicate_groups.some((group) =>
      group.members.some((member) => member.uid === primary)
      && group.members.some((member) => member.uid === second)));

    const merged = await call(app.base, 'POST', '/api/master-data/merge', {
      primary_uid: primary, merged_uid: second, note: '同一客户的两个公司名',
    }, app.token);
    assert.equal(merged.status, 201);

    const after = await call(app.base, 'GET', '/api/master-data', undefined, app.token);
    assert.equal(after.status, 200);
    assert.equal(after.body.summary.profiles, 1);
    assert.equal(after.body.summary.merges, 1);
    assert.equal(after.body.summary.duplicate_groups, 0);
    const profile = after.body.profiles.find((item) => item.uid === primary);
    assert.ok(profile);
    assert.deepEqual(profile.merged_uids, [second]);
    assert.equal(profile.customer_ids.length, 2);

    const viaMerged = await call(app.base, 'GET', '/api/customer-profile?uid=' + encodeURIComponent(second), undefined, app.token);
    assert.equal(viaMerged.status, 200);
    assert.equal(viaMerged.body.profile.uid, primary);
    assert.deepEqual(viaMerged.body.profile.merged_uids, [second]);
    assert.equal(viaMerged.body.profile.inquiry_count, 1);
    assert.equal(viaMerged.body.inquiries.length, 1);

    const cycle = await call(app.base, 'POST', '/api/master-data/merge', {
      primary_uid: second, merged_uid: primary,
    }, app.token);
    assert.equal(cycle.status, 409);
  } finally { await app.close(); }
});

test('主数据：取消合并后恢复两份档案，非管理员不能合并', async () => {
  const app = await setup();
  try {
    await seed(app.base);
    const { primary, second } = uids();
    const merged = await call(app.base, 'POST', '/api/master-data/merge', {
      primary_uid: primary, merged_uid: second,
    }, app.token);
    assert.equal(merged.status, 201);

    const removed = await call(app.base, 'POST', '/api/master-data/unmerge', { merged_uid: second }, app.token);
    assert.equal(removed.status, 200);
    const restored = await call(app.base, 'GET', '/api/master-data', undefined, app.token);
    assert.equal(restored.body.summary.profiles, 2);
    assert.equal(restored.body.summary.merges, 0);

    const denied = await call(app.base, 'POST', '/api/master-data/merge', {
      primary_uid: primary, merged_uid: second,
    }, 'read-t');
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'admin_required');
  } finally { await app.close(); }
});
