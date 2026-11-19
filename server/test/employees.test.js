'use strict';

// 员工列表编辑：邮箱/姓名/角色/店铺/状态
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
    store, ingestToken: 'ingest-t', readToken: 'read-t', sellerId: '', tenantId: 'default',
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = await call(base, 'POST', '/auth/login', { email: 'admin@example.com', password: 'adminpass1' }, '');
  assert.equal(login.status, 200);
  return { store, base, token: login.body.token, adminId: admin.id, close: () => new Promise((r) => server.close(r)) };
}

test('员工列表：管理员可修改邮箱、姓名、角色、店铺和状态', async () => {
  const app = await setup();
  try {
    const created = await call(app.base, 'POST', '/api/employees', {
      email: 'alice@example.com', name: 'Alice', password: 'alicepass1',
      role: 'operator', seller_id: 'seller-1',
    }, app.token);
    assert.equal(created.status, 201);
    const id = created.body.employee.id;

    const patch = await call(app.base, 'PATCH', '/api/employees/' + id, {
      email: 'alice2@example.com', name: 'Alice 2', role: 'operator',
      seller_id: 'seller-2', status: 'active',
    }, app.token);
    assert.equal(patch.status, 200);
    assert.equal(patch.body.employee.email, 'alice2@example.com');
    assert.equal(patch.body.employee.name, 'Alice 2');
    assert.equal(patch.body.employee.seller_id, 'seller-2');

    const list = await call(app.base, 'GET', '/api/employees', undefined, app.token);
    const row = list.body.items.find((e) => e.id === id);
    assert.ok(row);
    assert.equal(row.email, 'alice2@example.com');
    assert.equal(row.name, 'Alice 2');
    assert.equal(row.seller_id, 'seller-2');

    const login = await call(app.base, 'POST', '/auth/login', {
      email: 'alice2@example.com', password: 'alicepass1',
    }, '');
    assert.equal(login.status, 200);
    assert.equal(login.body.seller_id, 'seller-2');
  } finally { await app.close(); }
});

test('员工列表：邮箱不能与其他员工重复', async () => {
  const app = await setup();
  try {
    const a = await call(app.base, 'POST', '/api/employees', {
      email: 'alice@example.com', name: 'Alice', password: 'alicepass1', role: 'operator', seller_id: 'seller-1',
    }, app.token);
    const b = await call(app.base, 'POST', '/api/employees', {
      email: 'bob@example.com', name: 'Bob', password: 'bobpass11', role: 'operator', seller_id: 'seller-1',
    }, app.token);
    const dup = await call(app.base, 'PATCH', '/api/employees/' + a.body.employee.id, {
      email: 'bob@example.com',
    }, app.token);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'email_exists');
    assert.ok(b.body.employee.id);
  } finally { await app.close(); }
});

test('员工列表：不能停用自己，也不能把最后一个管理员降级', async () => {
  const app = await setup();
  try {
    const selfDisable = await call(app.base, 'PATCH', '/api/employees/' + app.adminId, {
      status: 'disabled',
    }, app.token);
    assert.equal(selfDisable.status, 400);
    assert.equal(selfDisable.body.error, 'cannot_disable_self');

    const demote = await call(app.base, 'PATCH', '/api/employees/' + app.adminId, {
      role: 'operator',
    }, app.token);
    assert.equal(demote.status, 400);
    assert.equal(demote.body.error, 'last_admin');
  } finally { await app.close(); }
});

test('员工列表：角色或状态变化后旧会话失效', async () => {
  const app = await setup();
  try {
    const created = await call(app.base, 'POST', '/api/employees', {
      email: 'carol@example.com', name: 'Carol', password: 'carolpass1', role: 'operator', seller_id: 'seller-1',
    }, app.token);
    const id = created.body.employee.id;
    const login = await call(app.base, 'POST', '/auth/login', {
      email: 'carol@example.com', password: 'carolpass1',
    }, '');
    assert.equal(login.status, 200);
    const carolToken = login.body.token;

    const patch = await call(app.base, 'PATCH', '/api/employees/' + id, { role: 'viewer' }, app.token);
    assert.equal(patch.status, 200);

    const me = await call(app.base, 'GET', '/auth/me', undefined, carolToken);
    assert.equal(me.status, 401);
  } finally { await app.close(); }
});
