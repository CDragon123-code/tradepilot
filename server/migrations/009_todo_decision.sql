-- 员工待办处理结果；按租户和店铺隔离，原始分析结果不改写。
CREATE TABLE IF NOT EXISTS todo_decision (
  tenant_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  todo_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('done', 'dismissed')),
  note TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  actor_id UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seller_id, todo_id)
);
