'use strict';

// 手动迁移：npm run migrate
const { PgStore } = require('./store-pg');
const { runMigrations } = require('./migrate');

const databaseUrl = String(process.env.DATABASE_URL || '').trim();
if (!databaseUrl) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}

(async () => {
  const store = new PgStore(databaseUrl);
  const files = await runMigrations(store.pool);
  console.log('[migrate] 完成，共 ' + files.length + ' 个迁移文件');
  await store.close();
})().catch((e) => {
  console.error('[migrate] 失败', e);
  process.exit(1);
});
