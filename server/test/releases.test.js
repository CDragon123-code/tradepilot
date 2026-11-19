'use strict';

// 扩展自动更新：/extension/version.json 与 /extension/latest.zip 不需要登录，直接可下载
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali-releases-'));
fs.writeFileSync(path.join(releaseDir, 'version.json'), JSON.stringify({
  version: '9.9.9', file: 'latest.zip', sha256: 'TEST',
}));
fs.writeFileSync(path.join(releaseDir, 'latest.zip'), Buffer.from('PK-test-zip'));
process.env.RELEASE_DIR = releaseDir;

const { createHandler } = require('../src/app');
const { MemoryStore } = require('../src/store-memory');

async function start() {
  const store = new MemoryStore();
  const server = http.createServer(createHandler({ store, token: 'test-token' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('扩展自动更新文件可直接下载且不被缓存', async () => {
  const app = await start();
  try {
    const v = await fetch(app.base + '/extension/version.json');
    assert.equal(v.status, 200);
    assert.match(v.headers.get('content-type') || '', /application\/json/);
    assert.equal(v.headers.get('cache-control'), 'no-store');
    const meta = await v.json();
    assert.equal(meta.version, '9.9.9');

    const z = await fetch(app.base + '/extension/latest.zip');
    assert.equal(z.status, 200);
    assert.match(z.headers.get('content-type') || '', /application\/zip/);
    assert.equal(Buffer.from(await z.arrayBuffer()).toString(), 'PK-test-zip');
  } finally {
    await app.close();
  }
});

test('发布文件缺失时返回 404', async () => {
  const app = await start();
  try {
    fs.renameSync(path.join(releaseDir, 'version.json'), path.join(releaseDir, 'version.json.bak'));
    const v = await fetch(app.base + '/extension/version.json');
    assert.equal(v.status, 404);
  } finally {
    fs.renameSync(path.join(releaseDir, 'version.json.bak'), path.join(releaseDir, 'version.json'));
    await app.close();
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }
});
