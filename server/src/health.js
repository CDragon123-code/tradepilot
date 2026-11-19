'use strict';

// 健康与容量探测：数据库连通、磁盘水位；供 /health 与巡检脚本共用
const fs = require('node:fs');

const DB_TIMEOUT_MS = 2500;
const DISK_WARN_PCT = 90;

function diskUsage(path) {
  try {
    const s = fs.statfsSync(path || '/');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const usedPct = total ? Math.round(((total - free) / total) * 100) : null;
    return {
      total_gb: Number((total / 1e9).toFixed(1)),
      free_gb: Number((free / 1e9).toFixed(1)),
      used_pct: usedPct,
      ok: usedPct === null || usedPct < DISK_WARN_PCT,
    };
  } catch (e) {
    return null;
  }
}

async function healthPayload(store) {
  const out = {
    ok: true,
    store: store.name,
    uptime_s: Math.round(process.uptime()),
    now: new Date().toISOString(),
  };
  const started = Date.now();
  try {
    await Promise.race([
      Promise.resolve(store.ping ? store.ping() : null),
      new Promise((_, reject) => setTimeout(() => reject(new Error('db_timeout')), DB_TIMEOUT_MS)),
    ]);
    out.db = { ok: true, latency_ms: Date.now() - started };
  } catch (e) {
    out.db = { ok: false, latency_ms: Date.now() - started, error: String((e && e.message) || e) };
    out.ok = false;
  }
  const disk = diskUsage('/');
  if (disk) {
    out.disk = disk;
    if (!disk.ok) out.ok = false;
  }
  return out;
}

module.exports = { healthPayload, diskUsage, DISK_WARN_PCT };
