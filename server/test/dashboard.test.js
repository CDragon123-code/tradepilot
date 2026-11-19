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
  return { status: res.status, type: res.headers.get('content-type') || '', body: data };
}

async function load(base, kind, rows) {
  const created = await call(base, 'POST', '/imports', { kind: kind });
  await call(base, 'PUT', '/imports/' + created.body.import_id + '/parts/1', { rows: rows });
  const commit = await call(base, 'POST', '/imports/' + created.body.import_id + '/commit');
  assert.equal(commit.status, 200);
  return commit.body;
}

test('工作台静态页免鉴权，摘要接口需要 token', async () => {
  const app = await start();
  try {
    const page = await call(app.base, 'GET', '/', undefined, '');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(String(page.body), /数据总览|数据中台/);

    const quality = await call(app.base, 'GET', '/data-quality', undefined, '');
    assert.equal(quality.status, 200);
    assert.match(String(quality.body), /数据质量/);
    const legacy = await call(app.base, 'GET', '/workbench', undefined, '');
    assert.equal(legacy.status, 200);
    for (const asset of ['/assets/data-common.js', '/assets/data.js', '/assets/quality.js']) {
      const res = await call(app.base, 'GET', asset, undefined, '');
      assert.equal(res.status, 200);
      assert.match(res.type, /javascript/);
    }

    const css = await call(app.base, 'GET', '/assets/style.css', undefined, '');
    assert.equal(css.status, 200);
    assert.match(css.type, /text\/css/);
    const shellCss = await call(app.base, 'GET', '/assets/shell.css', undefined, '');
    const shellJs = await call(app.base, 'GET', '/assets/shell.js', undefined, '');
    assert.equal(shellCss.status, 200);
    assert.equal(shellJs.status, 200);

    const denied = await call(app.base, 'GET', '/dashboard/summary', undefined, '');
    assert.equal(denied.status, 401);

    const missing = await call(app.base, 'GET', '/dashboards/secret', undefined, '');
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});

test('摘要按阈值输出缺口与逐源健康', async () => {
  const app = await start();
  try {
    await load(app.base, 'inquiry', [
      { platform_id: 'i1', payload: { 询盘ID: 'i1', 客户名称: 'Ann', 公司名称: 'A Co', 国家: '美国', 买家等级: 'L3', 来源: '营销商机' } },
      { platform_id: 'i2', payload: { 询盘ID: 'i2', 来源: '营销商机' } },
      { platform_id: 'i3', payload: { 询盘ID: 'i3', 来源: '自然搜索' } },
    ]);
    await load(app.base, 'order', [
      { platform_id: 'o1', payload: { 订单ID: 'o1', 询盘ID: 'i1', 成交金额: '100' } },
      { platform_id: 'o2', payload: { 订单ID: 'o2', 成交金额: '200' } },
    ]);
    await load(app.base, 'chat', [
      { platform_id: 'c1', payload: { 会话: 'Ann', 内容: 'hi' } },
      { platform_id: 'c2', payload: { 会话: 'Ann', 内容: 'hello' } },
    ]);
    await load(app.base, 'customer', [
      { platform_id: 'cu1', payload: { 客户ID: 'cu1', 联系人: 'Ann' } },
    ]);

    const r = await call(app.base, 'GET', '/dashboard/summary');
    assert.equal(r.status, 200);
    const s = r.body;
    assert.equal(s.seller_id, 'seller-1');
    assert.equal(s.totals.rows, 8);
    assert.equal(s.totals.kinds, 4);
    assert.equal(s.recent.length, 4);

    const sources = Object.fromEntries(s.sources.map((x) => [x.kind, x]));
    assert.equal(sources.inquiry.rows, 3);
    assert.equal(sources.chat.rows, 2);
    assert.equal(sources.inquiry.status, 'ok');

    const ids = s.gaps.map((g) => g.id);
    assert.ok(ids.includes('inquiry_no_name'), '2/3 缺客户名称应报缺口');
    assert.ok(ids.includes('inquiry_no_grade'), '全部缺等级应报缺口');
    assert.ok(ids.includes('ad_inquiry_no_name'), '广告商机缺资料应报缺口');
    assert.ok(ids.includes('order_no_inquiry_id'), '1/2 订单缺询盘 ID 应报缺口');
    assert.equal(ids.includes('empty_order'), false);

    const noName = s.gaps.find((g) => g.id === 'inquiry_no_name');
    assert.equal(noName.count, 2);
    assert.equal(noName.ratio, 66.7);
    assert.equal(noName.level, 'P0');
    assert.equal(s.gaps[0].level, 'P0', 'P0 排在最前');
  } finally {
    await app.close();
  }
});

test('摘要拒绝跨店铺查询，空源给出提示缺口', async () => {
  const app = await start();
  try {
    const other = await call(app.base, 'GET', '/dashboard/summary?seller_id=seller-2');
    assert.equal(other.status, 403);

    const r = await call(app.base, 'GET', '/dashboard/summary');
    assert.equal(r.status, 200);
    const ids = r.body.gaps.map((g) => g.id);
    ['empty_inquiry', 'empty_customer', 'empty_chat', 'empty_order'].forEach((id) => {
      assert.ok(ids.includes(id), '缺少数据源应提示 ' + id);
    });
    assert.equal(r.body.totals.rows, 0);
    assert.equal(r.body.sources.length, 0);
  } finally {
    await app.close();
  }
});
