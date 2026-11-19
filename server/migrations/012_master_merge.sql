-- 012_master_merge.sql · 主数据人工合并记录
-- 说明：只记录“被合并档案 → 主档案”的映射，不改写原始业务记录。
--       身份归并结果每次实时计算，人工合并作为一层覆盖规则叠加，可随时取消。
CREATE TABLE IF NOT EXISTS master_merge (
  tenant_id   TEXT NOT NULL,
  seller_id   TEXT NOT NULL,
  primary_uid TEXT NOT NULL,
  merged_uid  TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  actor_id    TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seller_id, merged_uid)
);

CREATE INDEX IF NOT EXISTS master_merge_primary_idx
  ON master_merge (tenant_id, seller_id, primary_uid);
