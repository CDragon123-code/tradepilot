'use strict';

// 服务入口：启动时自动跑迁移，然后监听 HTTP
const http = require('node:http');
const { createHandler } = require('./app');
const { PgStore } = require('./store-pg');
const { runMigrations } = require('./migrate');
const log = require('./log');

// 采集令牌只允许写导入，只读令牌只允许查询；两者都缺省时回落到 API_TOKEN（兼容旧配置）
const legacyToken = String(process.env.API_TOKEN || '').trim();
const ingestToken = String(process.env.INGEST_TOKEN || legacyToken).trim();
const readToken = String(process.env.READ_TOKEN || legacyToken).trim();
const sellerId = String(process.env.SELLER_ID || '').trim();
// 多店铺白名单：SELLER_IDS=seller-main,seller-sub；未配置时沿用单店铺 SELLER_ID
const sellerIds = String(process.env.SELLER_IDS || '')
  .split(',').map((item) => item.trim()).filter(Boolean);
const tenantId = String(process.env.TENANT_ID || 'default').trim();
const port = Number(process.env.PORT || 8787);
const databaseUrl = String(process.env.DATABASE_URL || '').trim();

if (!ingestToken || !readToken) {
  log.error('startup_failed', { reason: 'missing_token', hint: '需要 INGEST_TOKEN 与 READ_TOKEN（或兼容用的 API_TOKEN）' });
  process.exit(1);
}
if (!databaseUrl) {
  log.error('startup_failed', { reason: 'missing_database_url' });
  process.exit(1);
}
if (ingestToken === readToken) {
  log.warn('token_not_separated', { hint: '采集与只读共用一个令牌，建议拆开' });
}

(async () => {
  const store = new PgStore(databaseUrl);
  await runMigrations(store.pool);
  const server = http.createServer(createHandler({
    store, ingestToken, readToken, sellerId, sellerIds, tenantId,
  }));
  server.listen(port, () => {
    log.info('listening', {
      port: port, store: 'pg',
      seller: sellerId || '(未限制)',
      sellers: sellerIds.length ? sellerIds.join(',') : '(单店铺)',
    });
  });
  const shutdown = (signal) => {
    log.info('shutdown', { signal: signal });
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})().catch((e) => {
  log.error('startup_failed', { error: String((e && e.message) || e), stack: e && e.stack });
  process.exit(1);
});
