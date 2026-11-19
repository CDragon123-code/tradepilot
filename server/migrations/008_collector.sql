-- 008_collector.sql · 云端采集登录态
CREATE TABLE IF NOT EXISTS collector_state (
  tenant_id  TEXT NOT NULL,
  seller_id  TEXT NOT NULL,
  cookies    TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seller_id)
);
