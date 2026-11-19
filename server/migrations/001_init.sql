-- 001_init.sql · 云端最小数据平台
-- 约定：所有业务表带 tenant_id + seller_id；业务时间/采集时间/入库时间分开记录

CREATE TABLE IF NOT EXISTS source_batch (
  id           UUID PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  seller_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ,
  result       JSONB
);
CREATE INDEX IF NOT EXISTS idx_batch_seller ON source_batch (seller_id, status, committed_at DESC);

CREATE TABLE IF NOT EXISTS source_part (
  batch_id   UUID NOT NULL REFERENCES source_batch(id) ON DELETE CASCADE,
  part_no    INTEGER NOT NULL,
  checksum   TEXT NOT NULL,
  row_count  INTEGER NOT NULL,
  rows       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, part_no)
);

CREATE TABLE IF NOT EXISTS source_record (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  seller_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  batch_id    UUID REFERENCES source_batch(id) ON DELETE SET NULL,
  payload     JSONB NOT NULL,
  business_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_source_record_lookup ON source_record (tenant_id, seller_id, kind, platform_id);

CREATE TABLE IF NOT EXISTS current_record (
  tenant_id        TEXT NOT NULL,
  seller_id        TEXT NOT NULL,
  kind             TEXT NOT NULL,
  platform_id      TEXT NOT NULL,
  payload          JSONB NOT NULL,
  business_at      TIMESTAMPTZ,
  observed_at      TIMESTAMPTZ NOT NULL,
  first_ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seller_id, kind, platform_id)
);
CREATE INDEX IF NOT EXISTS idx_current_updated ON current_record (seller_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_current_business ON current_record (seller_id, kind, business_at DESC);
