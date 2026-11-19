'use strict';

// 数据中台 P2：API 网关令牌、范围、限流、调用流水与审计
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
  return { status: res.status, body: data, headers: res.headers };
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

async function createToken(app, body) {
  const created = await call(app.base, 'POST', '/api/gateway/clients', body, app.token);
  assert.equal(created.status, 201);
  assert.ok(created.body.token.startsWith('rk_'));
  return created.body;
}

test('API 网关：只读令牌可读数据，不能写入或访问管理接口', async () => {
  const app = await setup();
  try {
    const created = await createToken(app, {
      name: '扩展只读', kind: 'extension', scopes: ['read'], rate_limit: 60,
    });
    assert.deepEqual(created.client.scopes, ['read']);
    assert.equal(created.client.seller_id, 'seller-1');

    const read = await call(app.base, 'GET', '/api/data-assets?kind=inquiry', undefined, created.token);
    assert.equal(read.status, 200);
    assert.equal(read.body.ok, true);

    const write = await call(app.base, 'POST', '/imports', { kind: 'inquiry' }, created.token);
    assert.equal(write.status, 403);

    const adminDenied = await call(app.base, 'GET', '/api/gateway/clients', undefined, created.token);
    assert.equal(adminDenied.status, 403);
    assert.equal(adminDenied.body.error, 'api_admin_forbidden');

    const list = await call(app.base, 'GET', '/api/gateway/clients', undefined, app.token);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].token_hash, undefined);

    const badScopes = await call(app.base, 'POST', '/api/gateway/clients', {
      name: '非法范围', scopes: ['root'],
    }, app.token);
    assert.equal(badScopes.status, 400);
    assert.equal(badScopes.body.error, 'scopes_invalid');
  } finally { await app.close(); }
});

test('API 网关：写入令牌可导入，轮换后旧令牌失效，停用后不可用', async () => {
  const app = await setup();
  try {
    const created = await createToken(app, {
      name: '采集写入', kind: 'collector', scopes: ['write'], rate_limit: 60,
    });
    const createdBatch = await call(app.base, 'POST', '/imports', { kind: 'inquiry' }, created.token);
    assert.equal(createdBatch.status, 201);

    const rotated = await call(app.base, 'POST', '/api/gateway/clients/' + created.client.id + '/rotate', {}, app.token);
    assert.equal(rotated.status, 200);
    assert.ok(rotated.body.token && rotated.body.token !== created.token);

    const oldToken = await call(app.base, 'POST', '/imports', { kind: 'inquiry' }, created.token);
    assert.equal(oldToken.status, 401);
    const newToken = await call(app.base, 'POST', '/imports', { kind: 'inquiry' }, rotated.body.token);
    assert.equal(newToken.status, 201);

    const disabled = await call(app.base, 'PATCH', '/api/gateway/clients/' + created.client.id, {
      status: 'disabled',
    }, app.token);
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.client.status, 'disabled');
    const after = await call(app.base, 'POST', '/imports', { kind: 'inquiry' }, rotated.body.token);
    assert.equal(after.status, 401);
  } finally { await app.close(); }
});

test('API 网关：按令牌限流并返回 429', async () => {
  const app = await setup();
  try {
    const created = await createToken(app, {
      name: '限流测试', kind: 'external', scopes: ['read'], rate_limit: 2,
    });
    const first = await call(app.base, 'GET', '/api/data-assets?kind=inquiry', undefined, created.token);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-ratelimit-limit'), '2');
    const second = await call(app.base, 'GET', '/api/data-assets?kind=inquiry', undefined, created.token);
    assert.equal(second.status, 200);
    const third = await call(app.base, 'GET', '/api/data-assets?kind=inquiry', undefined, created.token);
    assert.equal(third.status, 429);
    assert.equal(third.body.error, 'rate_limited');
    assert.ok(Number(third.headers.get('retry-after')) >= 1);
  } finally { await app.close(); }
});

test('API 网关：collector 范围才能读取采集登录态', async () => {
  const app = await setup();
  try {
    const readOnly = await createToken(app, {
      name: '普通只读', kind: 'external', scopes: ['read'], rate_limit: 60,
    });
    const denied = await call(app.base, 'GET', '/api/collector/cookies', undefined, readOnly.token);
    assert.equal(denied.status, 403);

    const collector = await createToken(app, {
      name: '采集登录态', kind: 'collector', scopes: ['collector'], rate_limit: 60,
    });
    const missing = await call(app.base, 'GET', '/api/collector/cookies', undefined, collector.token);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'collector_state_missing');
  } finally { await app.close(); }
});

test('权限审计：调用流水、操作审计与网关概览可查询', async () => {
  const app = await setup();
  try {
    const created = await createToken(app, {
      name: '审计测试', kind: 'external', scopes: ['read'], rate_limit: 60,
    });
    await call(app.base, 'GET', '/api/data-assets?kind=inquiry', undefined, created.token);
    const deniedCall = await call(app.base, 'GET', '/api/gateway/clients', undefined, created.token);
    assert.equal(deniedCall.status, 403);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const calls = await call(app.base, 'GET', '/api/gateway/calls?limit=50', undefined, app.token);
    assert.equal(calls.status, 200);
    assert.ok(calls.body.items.some((row) => row.path === '/api/data-assets'));
    assert.ok(calls.body.items.some((row) => row.client_name === '审计测试'));

    const audit = await call(app.base, 'GET', '/api/audit?limit=50', undefined, app.token);
    assert.equal(audit.status, 200);
    assert.ok(audit.body.items.some((row) => row.action === 'api_token.create'));
    assert.ok(audit.body.items.some((row) => row.action === 'auth.login'));

    const overview = await call(app.base, 'GET', '/api/gateway/overview', undefined, app.token);
    assert.equal(overview.status, 200);
    assert.ok(overview.body.clients.total >= 1);
    assert.ok(overview.body.clients.active >= 1);
    assert.ok(overview.body.calls.total >= 1);
    assert.equal(overview.body.calls.server_errors, 0);
    assert.ok(overview.body.calls.denied >= 1);
    assert.ok(overview.body.audit.total >= 2);
    assert.ok(Array.isArray(overview.body.calls.top_paths));

    const denied = await call(app.base, 'GET', '/api/audit', undefined, 'read-t');
    assert.equal(denied.status, 403);
  } finally { await app.close(); }
});
