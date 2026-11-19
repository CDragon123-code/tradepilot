-- 007_heartbeat.sql · 扩展心跳与数据对账
CREATE TABLE IF NOT EXISTS client_heartbeat (
  tenant_id      TEXT NOT NULL,
  seller_id      TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  version        TEXT NOT NULL DEFAULT '',
  queue_rows     INTEGER NOT NULL DEFAULT 0,
  counts         JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_upload_at TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seller_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_heartbeat_seller ON client_heartbeat (seller_id, updated_at DESC);
