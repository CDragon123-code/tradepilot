'use strict';

// 导入基准：直接走存储层灌入 N 行并计时 commit（容器内运行，绕开 HTTP 与扩展）
// 用法：node src/bench-commit.js [行数，默认 20000]
// 说明：用独立 seller_id=bench-test 写入，跑完自动清理，不影响真实店铺数据
const { PgStore } = require('./store-pg');

const ROWS = Math.max(1, Number(process.argv[2]) || 20000);
const PART = 5000;
const SELLER = 'bench-test';

function makeRows(start, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const n = start + i;
    out.push({
      platform_id: 'bench-' + n,
      payload: { 客户名称: '客户' + n, 公司名称: '公司' + (n % 500), 国家: '美国', 来源: n % 3 ? '自然搜索' : '营销商机' },
      business_at: new Date(Date.now() - n * 60000).toISOString(),
      observed_at: new Date().toISOString(),
    });
  }
  return out;
}

(async () => {
  const store = new PgStore(process.env.DATABASE_URL);
  const t0 = Date.now();
  try {
    const batch = await store.createBatch({ tenantId: 'default', sellerId: SELLER, kind: 'inquiry', meta: { bench: true } });
    for (let i = 0; i < ROWS; i += PART) {
      await store.putPart({ batchId: batch.id, partNo: i / PART + 1, checksum: 'bench-' + i, rows: makeRows(i, Math.min(PART, ROWS - i)) });
    }
    const t1 = Date.now();
    const result = await store.commit(batch.id);
    const t2 = Date.now();
    console.log(JSON.stringify({
      rows: ROWS,
      parts: Math.ceil(ROWS / PART),
      load_ms: t1 - t0,
      commit_ms: t2 - t1,
      rows_per_sec_commit: Math.round(ROWS / Math.max(0.001, (t2 - t1) / 1000)),
      result: result,
    }));
    await store.pool.query('DELETE FROM source_batch WHERE seller_id = $1', [SELLER]);
    await store.pool.query('DELETE FROM source_record WHERE seller_id = $1', [SELLER]);
    await store.pool.query('DELETE FROM current_record WHERE seller_id = $1', [SELLER]);
  } finally {
    await store.close();
  }
})().catch((e) => {
  console.error('[bench] 失败', e);
  process.exit(1);
});
