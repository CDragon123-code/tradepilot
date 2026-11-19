'use strict';

// 数据中台 P3：AI 智能体总览、运行审计与配置更新
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
    store, ingestToken: 'ingest-t', readToken: 'read-t', sellerId: 'seller-1', tenantId: 'default',
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = await call(base, 'POST', '/auth/login', { email: 'admin@example.com', password: 'adminpass1' });
  assert.equal(login.status, 200);
  return { store, base, token: login.body.token, close: () => new Promise((r) => server.close(r)) };
}

async function createAgent(app, name) {
  const created = await call(app.base, 'POST', '/api/agents', {
    name: name || '首响助手',
    persona: '你是资深外贸业务员，英文回复，先确认需求再提问。',
    language: 'en',
    daily_limit: 20,
    cooldown_hours: 24,
    quiet_start: '23:00',
    quiet_end: '07:00',
  }, app.token);
  assert.equal(created.status, 201);
  return created.body.agent;
}

test('AI 智能体：总览返回配置、任务项、人工队列与运行统计', async () => {
  const app = await setup();
  try {
    const agent = await createAgent(app);
    await app.store.saveAiRun({
      tenantId: 'default', sellerId: 'seller-1', agentId: agent.id,
      model: 'dify', tokens: 120, latencyMs: 800, state: 'ok',
      citations: [{ document: '产品手册' }], output: 'Hello, thanks for your inquiry.',
    });
    const overview = await call(app.base, 'GET', '/api/ai/overview', undefined, app.token);
    assert.equal(overview.status, 200);
    assert.equal(overview.body.ok, true);
    assert.equal(overview.body.agents.total, 1);
    assert.equal(overview.body.agents.active, 1);
    assert.equal(overview.body.items.total, 0);
    assert.equal(overview.body.runs.draft.total, 1);
    assert.equal(overview.body.runs.draft.tokens, 120);
    assert.equal(overview.body.runs.draft.avg_ms, 800);
    assert.ok(overview.body.guard_rules.length >= 5);
    assert.equal(typeof overview.body.dify.configured, 'boolean');
    assert.equal(overview.body.recent_runs.length, 1);
    assert.equal(overview.body.recent_runs[0].agent_name, '首响助手');
  } finally { await app.close(); }
});

test('AI 智能体：运行审计支持按类型与状态筛选', async () => {
  const app = await setup();
  try {
    const agent = await createAgent(app);
    await app.store.saveAiRun({
      tenantId: 'default', sellerId: 'seller-1', agentId: agent.id,
      model: 'dify', tokens: 80, latencyMs: 500, state: 'ok', output: 'ok',
    });
    await app.store.saveAiRun({
      tenantId: 'default', sellerId: 'seller-1', agentId: agent.id,
      model: 'dify', latencyMs: 1200, state: 'error', error: 'Dify timeout',
    });
    const all = await call(app.base, 'GET', '/api/ai/runs?limit=10', undefined, app.token);
    assert.equal(all.status, 200);
    assert.equal(all.body.items.length, 2);
    assert.equal(all.body.items[0].kind, 'draft');

    const errors = await call(app.base, 'GET', '/api/ai/runs?kind=draft&state=error', undefined, app.token);
    assert.equal(errors.status, 200);
    assert.equal(errors.body.items.length, 1);
    assert.equal(errors.body.items[0].error, 'Dify timeout');

    const bad = await call(app.base, 'GET', '/api/ai/runs?kind=unknown', undefined, app.token);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'kind_invalid');
  } finally { await app.close(); }
});

test('AI 智能体：可更新语言、模型与状态，非管理员不可访问', async () => {
  const app = await setup();
  try {
    const agent = await createAgent(app);
    const updated = await call(app.base, 'PATCH', '/api/agents/' + agent.id, {
      language: 'zh', model: 'gpt-4o-mini', status: 'disabled', daily_limit: 10,
    }, app.token);
    assert.equal(updated.status, 200);
    assert.equal(updated.body.agent.language, 'zh');
    assert.equal(updated.body.agent.model, 'gpt-4o-mini');
    assert.equal(updated.body.agent.status, 'disabled');
    assert.equal(updated.body.agent.daily_limit, 10);

    const list = await call(app.base, 'GET', '/api/agents', undefined, app.token);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].language, 'zh');

    const denied = await call(app.base, 'GET', '/api/ai/overview', undefined, 'read-t');
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'admin_required');
    const deniedRuns = await call(app.base, 'GET', '/api/ai/runs', undefined, 'read-t');
    assert.equal(deniedRuns.status, 403);
  } finally { await app.close(); }
});
