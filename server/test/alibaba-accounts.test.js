'use strict';

// 阿里国际站账号注册表：管理员维护账号、绑定员工、非管理员拒绝
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

async function setup() {
  const store = new MemoryStore();
  const admin = await store.createEmployee({
    tenantId: 'default', email: 'admin@example.com', name: 'Admin',
    passwordHash: hashPassword('adminpass1'), role: 'admin',
  });
  await store.bindMembership({ employeeId: admin.id, tenantId: 'default', sellerId: 'seller-1' });
  const server = http.createServer(createHandler({
    store, sellerId: 'seller-1', tenantId: 'default',
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = await call(base, 'POST', '/auth/login', { email: 'admin@example.com', password: 'adminpass1' });
  assert.equal(login.status, 200);
  return { store, base, token: login.body.token, close: () => new Promise((r) => server.close(r)) };
}

async function createMainAccount(app) {
  const r = await call(app.base, 'POST', '/api/alibaba-accounts', {
    login_name: 'main_account', account_type: 'main', seller_id: 'seller-1',
    owner_name: 'main_account', display_name: '主账号', note: '主账号',
  }, app.token);
  assert.equal(r.status, 201);
  return r.body.account;
}

test('阿里账号：管理员创建主账号并绑定员工', async () => {
  const app = await setup();
  try {
    const account = await createMainAccount(app);
    assert.equal(account.login_name, 'main_account');
    assert.equal(account.account_type, 'main');

    const list = await call(app.base, 'GET', '/api/alibaba-accounts', undefined, app.token);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);

    const created = await call(app.base, 'POST', '/api/employees', {
      email: 'sub@example.com', name: 'Sub', password: 'subpass1',
      role: 'operator', seller_id: 'seller-1', alibaba_account_id: account.id,
    }, app.token);
    assert.equal(created.status, 201);
    assert.equal(created.body.employee.alibaba_account_id, account.id);

    const employees = await call(app.base, 'GET', '/api/employees', undefined, app.token);
    assert.equal(employees.status, 200);
    const sub = employees.body.items.find((item) => item.email === 'sub@example.com');
    assert.ok(sub);
    assert.equal(sub.alibaba_login, 'main_account');
    assert.equal(sub.alibaba_type, 'main');
    assert.equal(sub.owner_name, 'main_account');
    assert.equal(sub.alibaba_display_name, '主账号');

    const dup = await call(app.base, 'POST', '/api/alibaba-accounts', {
      login_name: 'main_account', account_type: 'main', seller_id: 'seller-1',
    }, app.token);
    assert.equal(dup.status, 409);

    const locked = await call(app.base, 'POST', '/api/alibaba-accounts', {
      login_name: 'Other', account_type: 'sub', seller_id: 'seller-2',
    }, app.token);
    assert.equal(locked.status, 400);
    assert.equal(locked.body.error, 'seller_locked');
  } finally { await app.close(); }
});

test('阿里账号：非管理员不可访问，解绑与删除生效', async () => {
  const app = await setup();
  try {
    const account = await createMainAccount(app);
    const created = await call(app.base, 'POST', '/api/employees', {
      email: 'sub@example.com', name: 'Sub', password: 'subpass1',
      role: 'operator', seller_id: 'seller-1', alibaba_account_id: account.id,
    }, app.token);
    assert.equal(created.status, 201);
    const employeeId = created.body.employee.id;

    const subLogin = await call(app.base, 'POST', '/auth/login', {
      email: 'sub@example.com', password: 'subpass1',
    });
    assert.equal(subLogin.status, 200);
    const denied = await call(app.base, 'GET', '/api/alibaba-accounts', undefined, subLogin.body.token);
    assert.equal(denied.status, 403);

    const unbound = await call(app.base, 'PATCH', '/api/employees/' + employeeId, {
      alibaba_account_id: '',
    }, app.token);
    assert.equal(unbound.status, 200);
    assert.equal(unbound.body.employee.alibaba_account_id, null);

    const rebound = await call(app.base, 'PATCH', '/api/employees/' + employeeId, {
      alibaba_account_id: account.id,
    }, app.token);
    assert.equal(rebound.status, 200);

    const removed = await call(app.base, 'DELETE', '/api/alibaba-accounts/' + account.id, undefined, app.token);
    assert.equal(removed.status, 200);

    const employees = await call(app.base, 'GET', '/api/employees', undefined, app.token);
    const sub = employees.body.items.find((item) => item.email === 'sub@example.com');
    assert.ok(sub);
    assert.equal(sub.alibaba_account_id, null);
    assert.equal(sub.alibaba_login, null);
  } finally { await app.close(); }
});
