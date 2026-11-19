'use strict';

// 多店铺数据分仓：登录按成员店铺、员工隔离、管理员与采集令牌跨店、采集器账号列表
process.env.SECRET_KEY = process.env.SECRET_KEY || 'multi-seller-test-secret-key-000000';

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
  const sub = await store.createEmployee({
    tenantId: 'default', email: 'sub@example.com', name: 'Sub',
    passwordHash: hashPassword('subpass1'), role: 'operator',
  });
  await store.bindMembership({ employeeId: sub.id, tenantId: 'default', sellerId: 'seller-sub' });
  await store.createAlibabaAccount({
    tenantId: 'default', sellerId: 'seller-main', loginName: 'main_account',
    accountType: 'main', ownerName: 'main_account', displayName: '主账号',
  });
  const subAccount = await store.createAlibabaAccount({
    tenantId: 'default', sellerId: 'seller-sub', loginName: 'Sub Account',
    accountType: 'sub', ownerName: 'Sub Account', displayName: 'Sub Account（子账号）',
  });
  await store.setEmployeeAlibabaAccount('default', sub.id, subAccount.id);

  const server = http.createServer(createHandler({
    store, ingestToken: 'ingest-t', readToken: 'read-t',
    sellerId: 'seller-main', sellerIds: ['seller-main', 'seller-sub'], tenantId: 'default',
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const adminLogin = await call(base, 'POST', '/auth/login', { email: 'admin@example.com', password: 'adminpass1' });
  const subLogin = await call(base, 'POST', '/auth/login', { email: 'sub@example.com', password: 'subpass1' });
  assert.equal(adminLogin.status, 200);
  assert.equal(subLogin.status, 200);
  return {
    store, base,
    adminToken: adminLogin.body.token,
    subToken: subLogin.body.token,
    admin, sub, subAccount,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function load(base, kind, seller, platformId, payload) {
  const created = await call(base, 'POST', '/imports', { kind, seller_id: seller }, 'ingest-t');
  assert.equal(created.status, 201);
  const part = await call(base, 'PUT', '/imports/' + created.body.import_id + '/parts/1', {
    rows: [{ platform_id: platformId, payload }],
  }, 'ingest-t');
  assert.equal(part.status, 200);
  const commit = await call(base, 'POST', '/imports/' + created.body.import_id + '/commit', undefined, 'ingest-t');
  assert.equal(commit.status, 200);
}

test('多店铺：登录按成员店铺，员工只看自己的数据，管理员可跨店查看', async () => {
  const app = await setup();
  try {
    await load(app.base, 'inquiry', 'seller-main', 'm1', {
      询盘ID: 'm1', 客户名称: 'Main Buyer', 创建时间: NOW, 负责人: 'main_account',
    });
    await load(app.base, 'inquiry', 'seller-sub', 's1', {
      询盘ID: 's1', 客户名称: 'Sub Buyer', 创建时间: NOW, 负责人: 'Sub Account',
    });

    const adminLogin = await call(app.base, 'POST', '/auth/login', { email: 'admin@example.com', password: 'adminpass1' });
    assert.equal(adminLogin.body.seller_id, 'seller-main');
    const subLogin = await call(app.base, 'POST', '/auth/login', { email: 'sub@example.com', password: 'subpass1' });
    assert.equal(subLogin.body.seller_id, 'seller-sub');

    const subList = await call(app.base, 'GET', '/api/inquiries', undefined, app.subToken);
    assert.equal(subList.status, 200);
    assert.equal(subList.body.total, 1);
    assert.equal(subList.body.items[0].name, 'Sub Buyer');

    const adminList = await call(app.base, 'GET', '/api/inquiries', undefined, app.adminToken);
    assert.equal(adminList.status, 200);
    assert.equal(adminList.body.total, 1);
    assert.equal(adminList.body.items[0].name, 'Main Buyer');

    const adminCross = await call(app.base, 'GET', '/api/inquiries?seller_id=seller-sub', undefined, app.adminToken);
    assert.equal(adminCross.status, 200);
    assert.equal(adminCross.body.items[0].name, 'Sub Buyer');

    const subCross = await call(app.base, 'GET', '/api/inquiries?seller_id=seller-main', undefined, app.subToken);
    assert.equal(subCross.status, 403);
    assert.equal(subCross.body.error, 'seller_mismatch');

    const machineCross = await call(app.base, 'GET', '/api/inquiries?seller_id=seller-sub', undefined, 'read-t');
    assert.equal(machineCross.status, 200);
    assert.equal(machineCross.body.items[0].name, 'Sub Buyer');

    const machineDenied = await call(app.base, 'POST', '/imports', { kind: 'inquiry', seller_id: 'seller-other' }, 'ingest-t');
    assert.equal(machineDenied.status, 403);
    assert.equal(machineDenied.body.error, 'seller_not_allowed');
  } finally { await app.close(); }
});

test('采集器多账号：登录态按店铺隔离，账号列表只返回有托管登录态的店铺', async () => {
  const app = await setup();
  try {
    const mainCookies = [{ name: 'main_cookie', value: 'main-value' }];
    const subCookies = [{ name: 'sub_cookie', value: 'sub-value' }];

    const savedMain = await call(app.base, 'POST', '/api/collector/cookies', {
      seller_id: 'seller-main', cookies: mainCookies,
    }, app.adminToken);
    assert.equal(savedMain.status, 200);

    const savedSub = await call(app.base, 'POST', '/api/collector/cookies', {
      cookies: subCookies,
    }, app.subToken);
    assert.equal(savedSub.status, 200, JSON.stringify(savedSub.body));

    const accounts = await call(app.base, 'GET', '/api/collector/accounts', undefined, 'ingest-t');
    assert.equal(accounts.status, 200);
    assert.deepEqual(accounts.body.items.map((item) => item.seller_id), ['seller-main', 'seller-sub']);
    const subRow = accounts.body.items.find((item) => item.seller_id === 'seller-sub');
    assert.equal(subRow.login_name, 'Sub Account');
    assert.equal(subRow.account_type, 'sub');

    const mainState = await call(app.base, 'GET', '/api/collector/cookies?seller_id=seller-main', undefined, 'ingest-t');
    assert.equal(mainState.status, 200);
    assert.equal(mainState.body.cookies[0].name, 'main_cookie');

    const subState = await call(app.base, 'GET', '/api/collector/cookies?seller_id=seller-sub', undefined, 'ingest-t');
    assert.equal(subState.status, 200);
    assert.equal(subState.body.cookies[0].name, 'sub_cookie');

    const subReadsMain = await call(app.base, 'GET', '/api/collector/cookies?seller_id=seller-main', undefined, app.subToken);
    assert.equal(subReadsMain.status, 403);

    const readTokenDenied = await call(app.base, 'GET', '/api/collector/accounts', undefined, 'read-t');
    assert.equal(readTokenDenied.status, 403);
  } finally { await app.close(); }
});

test('单店铺部署：未配置 SELLER_IDS 时仍只允许 SELLER_ID', async () => {
  const store = new MemoryStore();
  const server = http.createServer(createHandler({
    store, ingestToken: 'ingest-t', readToken: 'read-t', sellerId: 'seller-main', tenantId: 'default',
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const same = await call(base, 'GET', '/api/overview', undefined, 'read-t');
    assert.equal(same.status, 200);
    const other = await call(base, 'GET', '/api/overview?seller_id=seller-sub', undefined, 'read-t');
    assert.equal(other.status, 403);
    assert.equal(other.body.error, 'seller_not_allowed');
    const write = await call(base, 'POST', '/imports', { kind: 'inquiry', seller_id: 'seller-sub' }, 'ingest-t');
    assert.equal(write.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
