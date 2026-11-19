'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHandler } = require('../src/app');
const { MemoryStore } = require('../src/store-memory');

async function start(opts) {
  const options = opts || {};
  const store = new MemoryStore();
  const server = http.createServer(createHandler({
    store: store,
    token: options.token || 'test-token',
    sellerId: options.sellerId === undefined ? 'seller-1' : options.sellerId,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    base: base,
    store: store,
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
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function row(id, payload, businessAt) {
  return { platform_id: id, payload: payload, business_at: businessAt };
}

test('健康检查免鉴权，其余接口必须带 token', async () => {
  const app = await start();
  try {
    const health = await call(app.base, 'GET', '/health', undefined, '');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.store, 'memory');

    const noToken = await call(app.base, 'POST', '/imports', { kind: 'inquiry' }, '');
    assert.equal(noToken.status, 401);
    const wrong = await call(app.base, 'POST', '/imports', { kind: 'inquiry' }, 'wrong-token');
    assert.equal(wrong.status, 401);
  } finally {
    await app.close();
  }
});

test('分片重复上传与提交都是幂等的', async () => {
  const app = await start();
  try {
    const created = await call(app.base, 'POST', '/imports', { kind: 'inquiry', meta: { from: 'test' } });
    assert.equal(created.status, 201);
    const id = created.body.import_id;

    const rows = [row('i1', { 客户名称: 'A' }, '2026-11-10T00:00:00.000Z'), row('i2', { 客户名称: 'B' }, '2026-11-11T00:00:00.000Z')];
    const part = await call(app.base, 'PUT', '/imports/' + id + '/parts/1', { rows: rows });
    assert.equal(part.status, 200);
    assert.equal(part.body.row_count, 2);
    assert.equal(part.body.duplicate, false);

    const again = await call(app.base, 'PUT', '/imports/' + id + '/parts/1', { rows: rows });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);

    const conflict = await call(app.base, 'PUT', '/imports/' + id + '/parts/1', { rows: [row('i3', { 客户名称: 'C' }, null)] });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'part_conflict');

    const commit = await call(app.base, 'POST', '/imports/' + id + '/commit');
    assert.equal(commit.status, 200);
    assert.equal(commit.body.inserted, 2);
    assert.equal(commit.body.received, 2);

    const commitAgain = await call(app.base, 'POST', '/imports/' + id + '/commit');
    assert.equal(commitAgain.status, 200);
    assert.deepEqual(commitAgain.body, commit.body);

    const afterCommit = await call(app.base, 'PUT', '/imports/' + id + '/parts/2', { rows: rows });
    assert.equal(afterCommit.status, 409);
    assert.equal(afterCommit.body.error, 'import_committed');

    const status = await call(app.base, 'GET', '/sync/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.sources[0].kind, 'inquiry');
    assert.equal(status.body.sources[0].rows, 2);
    assert.equal(status.body.sources[0].batches, 1);

    const changes = await call(app.base, 'GET', '/changes?limit=10');
    assert.equal(changes.status, 200);
    assert.equal(changes.body.records.length, 2);
  } finally {
    await app.close();
  }
});

test('较旧的业务时间不会覆盖新数据', async () => {
  const app = await start();
  try {
    const first = await call(app.base, 'POST', '/imports', { kind: 'inquiry' });
    await call(app.base, 'PUT', '/imports/' + first.body.import_id + '/parts/1', { rows: [row('p1', { v: 2 }, '2026-11-10T00:00:00.000Z')] });
    await call(app.base, 'POST', '/imports/' + first.body.import_id + '/commit');

    const older = await call(app.base, 'POST', '/imports', { kind: 'inquiry' });
    await call(app.base, 'PUT', '/imports/' + older.body.import_id + '/parts/1', { rows: [row('p1', { v: 1 }, '2026-11-09T00:00:00.000Z')] });
    const olderCommit = await call(app.base, 'POST', '/imports/' + older.body.import_id + '/commit');
    assert.equal(olderCommit.body.skipped, 1);

    let changes = await call(app.base, 'GET', '/changes');
    assert.equal(changes.body.records.length, 1);
    assert.equal(changes.body.records[0].payload.v, 2);

    const newer = await call(app.base, 'POST', '/imports', { kind: 'inquiry' });
    await call(app.base, 'PUT', '/imports/' + newer.body.import_id + '/parts/1', { rows: [row('p1', { v: 3 }, '2026-11-12T00:00:00.000Z')] });
    const newerCommit = await call(app.base, 'POST', '/imports/' + newer.body.import_id + '/commit');
    assert.equal(newerCommit.body.updated, 1);

    changes = await call(app.base, 'GET', '/changes');
    assert.equal(changes.body.records[0].payload.v, 3);
  } finally {
    await app.close();
  }
});

test('采集器批次只补新值，不冲掉扩展补全的询盘字段', async () => {
  const app = await start();
  try {
    const ext = await call(app.base, 'POST', '/imports', { kind: 'inquiry', meta: { from: 'extension' } });
    await call(app.base, 'PUT', '/imports/' + ext.body.import_id + '/parts/1', {
      rows: [row('inquiry:i1', {
        询盘ID: 'i1', 客户名称: '旧客户', 公司名称: '旧公司', 买家等级: 'L3',
        国家: '美国', 创建时间: '2026/11/16 08:00:00',
      }, '2026-11-16T00:00:00.000Z')],
    });
    await call(app.base, 'POST', '/imports/' + ext.body.import_id + '/commit');

    const col = await call(app.base, 'POST', '/imports', { kind: 'inquiry', meta: { from: 'cloud-collector' } });
    await call(app.base, 'PUT', '/imports/' + col.body.import_id + '/parts/1', {
      rows: [row('inquiry:i1', {
        询盘ID: 'i1', 客户名称: '新客户', 公司名称: '', 买家等级: '', 国家: '美国',
        创建时间: '2026/11/16 09:00:00',
      }, '2026-11-16T01:00:00.000Z')],
    });
    const commit = await call(app.base, 'POST', '/imports/' + col.body.import_id + '/commit');
    assert.equal(commit.body.updated, 1);

    const changes = await call(app.base, 'GET', '/changes');
    const p = changes.body.records[0].payload;
    assert.equal(p.客户名称, '新客户');
    assert.equal(p.国家, '美国');
    assert.equal(p.公司名称, '旧公司', '采集器空值不应冲掉已有公司');
    assert.equal(p.买家等级, 'L3', '采集器空值不应冲掉已有等级');

    // 扩展再导一次时，空字段同样不应冲掉已有的客户名/公司/等级
    const ext2 = await call(app.base, 'POST', '/imports', { kind: 'inquiry' });
    await call(app.base, 'PUT', '/imports/' + ext2.body.import_id + '/parts/1', {
      rows: [row('inquiry:i1', {
        询盘ID: 'i1', 客户名称: '', 公司名称: '', 买家等级: '', 国家: '',
        创建时间: '2026/11/16 10:00:00',
      }, '2026-11-16T02:00:00.000Z')],
    });
    await call(app.base, 'POST', '/imports/' + ext2.body.import_id + '/commit');

    const afterExt = await call(app.base, 'GET', '/changes');
    const p2 = afterExt.body.records[0].payload;
    assert.equal(p2.客户名称, '新客户', '扩展空客户名不应冲掉已有客户名');
    assert.equal(p2.国家, '美国');
    assert.equal(p2.公司名称, '旧公司');
    assert.equal(p2.买家等级, 'L3');
  } finally {
    await app.close();
  }
});

test('非询盘类型的空值不会冲掉已有客户字段', async () => {
  const app = await start();
  try {
    const first = await call(app.base, 'POST', '/imports', { kind: 'customer' });
    await call(app.base, 'PUT', '/imports/' + first.body.import_id + '/parts/1', {
      rows: [row('c1', {
        公司名称: 'Lisbon Dental', 联系人: 'Ana', '国家/地区': 'Portugal', 买家等级: 'L3',
      }, '2026-11-10T00:00:00.000Z')],
    });
    await call(app.base, 'POST', '/imports/' + first.body.import_id + '/commit');

    const second = await call(app.base, 'POST', '/imports', { kind: 'customer' });
    await call(app.base, 'PUT', '/imports/' + second.body.import_id + '/parts/1', {
      rows: [row('c1', {
        公司名称: 'Lisbon Dental', 联系人: '', '国家/地区': '', 买家等级: 'L4',
      }, '2026-11-11T00:00:00.000Z')],
    });
    const commit = await call(app.base, 'POST', '/imports/' + second.body.import_id + '/commit');
    assert.equal(commit.body.updated, 1);

    const changes = await call(app.base, 'GET', '/changes');
    const p = changes.body.records[0].payload;
    assert.equal(p.联系人, 'Ana', '空联系人不应冲掉已有联系人');
    assert.equal(p['国家/地区'], 'Portugal', '空国家不应冲掉已有国家');
    assert.equal(p.买家等级, 'L4', '非空等级仍应更新');
  } finally {
    await app.close();
  }
});

test('拒绝未知类型、跨店铺写入与非法行', async () => {
  const app = await start();
  try {
    const badKind = await call(app.base, 'POST', '/imports', { kind: 'unknown' });
    assert.equal(badKind.status, 400);
    assert.equal(badKind.body.error, 'unsupported_kind');

    const otherSeller = await call(app.base, 'POST', '/imports', { kind: 'inquiry', seller_id: 'seller-2' });
    assert.equal(otherSeller.status, 403);
    assert.equal(otherSeller.body.error, 'seller_mismatch');

    const created = await call(app.base, 'POST', '/imports', { kind: 'order' });
    const noId = await call(app.base, 'PUT', '/imports/' + created.body.import_id + '/parts/1', { rows: [{ payload: {} }] });
    assert.equal(noId.status, 400);
    assert.equal(noId.body.error, 'platform_id_required');

    const empty = await call(app.base, 'PUT', '/imports/' + created.body.import_id + '/parts/1', { rows: [] });
    assert.equal(empty.status, 400);

    const commitEmpty = await call(app.base, 'POST', '/imports/' + created.body.import_id + '/commit');
    assert.equal(commitEmpty.status, 400);
    assert.equal(commitEmpty.body.error, 'no_parts');
  } finally {
    await app.close();
  }
});

test('分片内重复 platform_id 以最后一条为准', async () => {
  const app = await start();
  try {
    const created = await call(app.base, 'POST', '/imports', { kind: 'chat' });
    const part = await call(app.base, 'PUT', '/imports/' + created.body.import_id + '/parts/1', {
      rows: [
        { platform_id: 'c1', payload: { text: '旧' } },
        { platform_id: 'c1', payload: { text: '新' } },
      ],
    });
    assert.equal(part.body.row_count, 1);
    const commit = await call(app.base, 'POST', '/imports/' + created.body.import_id + '/commit');
    assert.equal(commit.body.received, 1);
    const changes = await call(app.base, 'GET', '/changes');
    assert.equal(changes.body.records[0].payload.text, '新');
  } finally {
    await app.close();
  }
});
