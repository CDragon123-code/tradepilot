'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHandler } = require('../src/app');
const { MemoryStore } = require('../src/store-memory');

async function start() {
  const store = new MemoryStore();
  const server = http.createServer(createHandler({ store, token: 'test-token', sellerId: 'seller-1' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function call(base, method, path, body, token) {
  const headers = { 'content-type': 'application/json' };
  const t = token === undefined ? 'test-token' : token;
  if (t) headers.authorization = 'Bearer ' + t;
  const res = await fetch(base + path, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, body: data };
}

async function load(base, kind, rows) {
  const created = await call(base, 'POST', '/imports', { kind: kind });
  await call(base, 'PUT', '/imports/' + created.body.import_id + '/parts/1', { rows: rows });
  const commit = await call(base, 'POST', '/imports/' + created.body.import_id + '/commit');
  assert.equal(commit.status, 200);
}

const NOW = new Date().toISOString();

test('业务 API：概览复用领域逻辑，询盘列表支持筛选与分页', async () => {
  const app = await start();
  try {
    await load(app.base, 'inquiry', [
      { platform_id: 'i1', payload: { 询盘ID: 'i1', 客户名称: 'Ann', 公司名称: 'A Co', 国家: '美国', 来源: '营销商机', 买家等级: 'L3', 是否已加为客户: '是', 创建时间: NOW, 询盘主题: 'Resin' } },
      { platform_id: 'i2', payload: { 询盘ID: 'i2', 客户名称: 'Bob', 公司名称: 'B Co', 国家: '德国', 来源: '自然搜索', 创建时间: NOW, 询盘主题: 'Printer' } },
      { platform_id: 'i3', payload: { 询盘ID: 'i3', 客户名称: 'Ann', 公司名称: 'C Co', 国家: '美国', 来源: '营销商机', 创建时间: NOW, 询盘主题: 'Wash' } },
    ]);
    await load(app.base, 'customer', [
      { platform_id: 'cu1', payload: { 客户ID: 'cu1', 联系人: 'Ann', 公司名称: 'A Co', 买家等级: 'L3' } },
    ]);
    await load(app.base, 'chat', [
      { platform_id: 'c1', payload: { 会话: 'Ann', 发送时间: NOW, 角色: '客户', 内容: 'hi' } },
    ]);

    const overview = await call(app.base, 'GET', '/api/overview');
    assert.equal(overview.status, 200);
    assert.equal(overview.body.domain_unavailable, false);
    assert.ok(overview.body.home, '应返回领域计算的首页数据');
    assert.ok(Array.isArray(overview.body.home.kpi));
    assert.ok(overview.body.home.todo_count >= 1);
    assert.ok(Array.isArray(overview.body.home.todos));
    assert.equal(overview.body.summary.totals.rows, 5);

    const page = await call(app.base, 'GET', '/api/inquiries?page=1&pageSize=2');
    assert.equal(page.status, 200);
    assert.equal(page.body.total, 3);
    assert.equal(page.body.items.length, 2);
    assert.ok(['i1', 'i2', 'i3'].includes(page.body.items[0].id), '平台 ID 原样返回');

    const byName = await call(app.base, 'GET', '/api/inquiries?q=Bob');
    assert.equal(byName.body.total, 1);
    assert.equal(byName.body.items[0].name, 'Bob');

    const byCountry = await call(app.base, 'GET', '/api/inquiries?country=' + encodeURIComponent('美国'));
    assert.equal(byCountry.body.total, 2);

    const byGrade = await call(app.base, 'GET', '/api/inquiries?grade=L3');
    assert.equal(byGrade.body.total, 1);
    assert.equal(byGrade.body.items[0].company, 'A Co');

    const clamp = await call(app.base, 'GET', '/api/inquiries?pageSize=999');
    assert.equal(clamp.body.pageSize, 100);

    const denied = await call(app.base, 'GET', '/api/inquiries', undefined, '');
    assert.equal(denied.status, 401);

    const other = await call(app.base, 'GET', '/api/overview?seller_id=seller-2');
    assert.equal(other.status, 403);
  } finally {
    await app.close();
  }
});

test('业务 API：空库也能返回结构', async () => {
  const app = await start();
  try {
    const r = await call(app.base, 'GET', '/api/overview');
    assert.equal(r.status, 200);
    assert.equal(r.body.summary.totals.rows, 0);
    assert.ok(r.body.home, '空库时仍应返回待办结构');
    assert.ok(r.body.home.todo_count >= 1);
    const list = await call(app.base, 'GET', '/api/inquiries');
    assert.equal(list.body.total, 0);
    assert.deepEqual(list.body.items, []);
  } finally {
    await app.close();
  }
});

test('员工处理待办后列表立即更新，刷新仍保留，且可恢复', async () => {
  const { hashPassword } = require('../src/auth');
  const store = new MemoryStore();
  const emp = await store.createEmployee({ tenantId: 'default', email: 'ops@example.com',
    name: '运营', passwordHash: hashPassword('secret123'), role: 'operator' });
  await store.bindMembership({ employeeId: emp.id, tenantId: 'default', sellerId: 'seller-1' });
  const server = http.createServer(createHandler({ store, ingestToken: 'ingest-t', readToken: 'read-t', sellerId: 'seller-1' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const batch = await call(base, 'POST', '/imports', { kind: 'inquiry' }, 'ingest-t');
    await call(base, 'PUT', '/imports/' + batch.body.import_id + '/parts/1', { rows: [
      { platform_id: 'i-todo', payload: { 询盘ID: 'i-todo', 客户名称: 'Buyer',
        创建时间: new Date().toISOString(), 回复状态: '待回复', 是否已加为客户: '否' } },
    ] }, 'ingest-t');
    await call(base, 'POST', '/imports/' + batch.body.import_id + '/commit', undefined, 'ingest-t');
    const login = await call(base, 'POST', '/auth/login', { email: 'ops@example.com', password: 'secret123' }, '');
    const token = login.body.token;
    const before = await call(base, 'GET', '/api/overview', undefined, token);
    const todo = before.body.home.todos[0];
    assert.match(todo.id, /^[0-9a-f]{64}$/);
    const machineDenied = await call(base, 'PATCH', '/api/todo-decisions', { id: todo.id, state: 'done' }, 'read-t');
    assert.equal(machineDenied.status, 403);
    const done = await call(base, 'PATCH', '/api/todo-decisions', { id: todo.id, state: 'done' }, token);
    assert.equal(done.status, 200);
    const after = await call(base, 'GET', '/api/overview', undefined, token);
    assert.equal(after.body.home.todo_count, before.body.home.todo_count - 1);
    assert.equal(after.body.home.resolved_count, 1);
    assert.equal(after.body.home.resolved[0].actor_id, emp.id);
    const reopen = await call(base, 'PATCH', '/api/todo-decisions', { id: todo.id, state: 'open' }, token);
    assert.equal(reopen.status, 200);
    const restored = await call(base, 'GET', '/api/overview', undefined, token);
    assert.equal(restored.body.home.todo_count, before.body.home.todo_count);
    assert.equal(restored.body.home.resolved_count, 0);
    const fake = await call(base, 'PATCH', '/api/todo-decisions', { id: 'a'.repeat(64), state: 'done' }, token);
    assert.equal(fake.status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('员工登录：会话可读写，退出后立即失效', async () => {
  const { hashPassword } = require('../src/auth');
  const store = new MemoryStore();
  await store.createEmployee({
    tenantId: 'default', email: 'ann@example.com', name: 'Ann',
    passwordHash: hashPassword('secret123'), role: 'operator',
  });
  const server = http.createServer(createHandler({
    store, ingestToken: 'ingest-t', readToken: 'read-t', sellerId: 'seller-1', tenantId: 'default',
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const bad = await call(base, 'POST', '/auth/login', { email: 'ann@example.com', password: 'wrong-pass' }, '');
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, 'invalid_credentials');

    const login = await call(base, 'POST', '/auth/login', { email: 'ann@example.com', password: 'secret123' }, '');
    assert.equal(login.status, 200);
    assert.equal(login.body.seller_id, 'seller-1');
    const token = login.body.token;
    assert.ok(token && token.length >= 32);

    const me = await call(base, 'GET', '/auth/me', undefined, token);
    assert.equal(me.status, 200);
    assert.equal(me.body.kind, 'employee');
    assert.equal(me.body.seller_id, 'seller-1');

    const write = await call(base, 'POST', '/imports', { kind: 'inquiry' }, token);
    assert.equal(write.status, 201);

    const read = await call(base, 'GET', '/sync/status', undefined, token);
    assert.equal(read.status, 200);

    const logout = await call(base, 'POST', '/auth/logout', undefined, token);
    assert.equal(logout.status, 200);

    const after = await call(base, 'GET', '/sync/status', undefined, token);
    assert.equal(after.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('管理后台：管理员可建改删员工，非管理员被拒', async () => {
  const { hashPassword } = require('../src/auth');
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
  try {
    const login = await call(base, 'POST', '/auth/login', { email: 'admin@example.com', password: 'adminpass1' }, '');
    assert.equal(login.status, 200);
    const token = login.body.token;

    const list = await call(base, 'GET', '/api/employees', undefined, token);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);

    const created = await call(base, 'POST', '/api/employees', {
      email: 'Bob@Example.com', name: 'Bob', password: 'bobpass123', role: 'operator', seller_id: 'seller-1',
    }, token);
    assert.equal(created.status, 201);
    assert.equal(created.body.employee.email, 'bob@example.com');

    const dup = await call(base, 'POST', '/api/employees', {
      email: 'bob@example.com', password: 'bobpass123', role: 'operator',
    }, token);
    assert.equal(dup.status, 409);

    const weak = await call(base, 'POST', '/api/employees', {
      email: 'weak@example.com', password: '123', role: 'operator',
    }, token);
    assert.equal(weak.status, 400);

    const upd = await call(base, 'PATCH', '/api/employees/' + created.body.employee.id, { role: 'viewer' }, token);
    assert.equal(upd.status, 200);
    assert.equal(upd.body.employee.role, 'viewer');

    const bobLogin = await call(base, 'POST', '/auth/login', { email: 'bob@example.com', password: 'bobpass123' }, '');
    assert.equal(bobLogin.status, 200);
    const forbidden = await call(base, 'GET', '/api/employees', undefined, bobLogin.body.token);
    assert.equal(forbidden.status, 403);

    const selfDelete = await call(base, 'DELETE', '/api/employees/' + admin.id, undefined, token);
    assert.equal(selfDelete.status, 400);

    const del = await call(base, 'DELETE', '/api/employees/' + created.body.employee.id, undefined, token);
    assert.equal(del.status, 200);
    const after = await call(base, 'GET', '/api/employees', undefined, token);
    assert.equal(after.body.items.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('令牌分层：采集令牌不能读，只读令牌不能写', async () => {
  const store = new MemoryStore();
  const server = http.createServer(createHandler({
    store, ingestToken: 'ingest-t', readToken: 'read-t', sellerId: 'seller-1',
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const writeWithRead = await call(base, 'POST', '/imports', { kind: 'inquiry' }, 'read-t');
    assert.equal(writeWithRead.status, 403);
    assert.equal(writeWithRead.body.error, 'forbidden');

    const readWithIngest = await call(base, 'GET', '/sync/status', undefined, 'ingest-t');
    assert.equal(readWithIngest.status, 401);

    const writeWithIngest = await call(base, 'POST', '/imports', { kind: 'inquiry' }, 'ingest-t');
    assert.equal(writeWithIngest.status, 201);

    const readWithRead = await call(base, 'GET', '/sync/status', undefined, 'read-t');
    assert.equal(readWithRead.status, 200);

    const health = await call(base, 'GET', '/health', undefined, '');
    assert.equal(health.body.store, 'memory');
    assert.equal(health.body.db.ok, true);
    assert.ok(health.body.disk && typeof health.body.disk.used_pct === 'number');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
