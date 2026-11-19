-- 005_shared_dify_guard.sql · 共用 Dify 知识库 + 守门风险记录
-- 业务员不再各自绑定 App Key，统一用平台级 DIFY_API_KEY
ALTER TABLE ai_run ADD COLUMN IF NOT EXISTS risk JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_item_human ON task_item (seller_id, state, updated_at DESC);
