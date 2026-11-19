-- 004_ai_run.sql · 业务员与 Dify 应用绑定 + AI 生成审计
ALTER TABLE ai_agent ADD COLUMN IF NOT EXISTS dify_base_url TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_agent ADD COLUMN IF NOT EXISTS dify_app_key TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_agent ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS ai_run (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  seller_id         TEXT NOT NULL,
  agent_id          UUID,
  task_item_id      UUID REFERENCES task_item(id) ON DELETE SET NULL,
  prompt_version    TEXT NOT NULL DEFAULT 'v1',
  knowledge_version TEXT NOT NULL DEFAULT '',
  model             TEXT NOT NULL DEFAULT '',
  tokens            INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  citations         JSONB NOT NULL DEFAULT '[]'::jsonb,
  output            TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL DEFAULT 'ok',
  error             TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_run_item ON ai_run (task_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_run_agent ON ai_run (agent_id, created_at DESC);
