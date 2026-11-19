-- 006_agent_runtime.sql · 智能体会话运行时
-- 会话 / 消息 / 回合 / 升级单 / 客户分配建议

CREATE TABLE IF NOT EXISTS agent_thread (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  seller_id       TEXT NOT NULL,
  agent_id        UUID NOT NULL REFERENCES ai_agent(id) ON DELETE CASCADE,
  customer_key    TEXT NOT NULL,
  channel         TEXT NOT NULL DEFAULT 'inquiry',
  subject         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'open',
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, customer_key, channel)
);
CREATE INDEX IF NOT EXISTS idx_thread_status ON agent_thread (seller_id, status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS agent_message (
  id         BIGSERIAL PRIMARY KEY,
  thread_id  UUID NOT NULL REFERENCES agent_thread(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'ok',
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_thread ON agent_message (thread_id, created_at);

CREATE TABLE IF NOT EXISTS agent_run (
  id            BIGSERIAL PRIMARY KEY,
  thread_id     UUID NOT NULL REFERENCES agent_thread(id) ON DELETE CASCADE,
  agent_id      UUID NOT NULL,
  trigger       TEXT NOT NULL DEFAULT 'message',
  state         TEXT NOT NULL DEFAULT 'running',
  input         JSONB NOT NULL DEFAULT '{}'::jsonb,
  output        TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL DEFAULT '',
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  guard         JSONB NOT NULL DEFAULT '[]'::jsonb,
  escalation_id UUID,
  error         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_run_thread ON agent_run (thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_escalation (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL,
  seller_id   TEXT NOT NULL,
  thread_id   UUID NOT NULL REFERENCES agent_thread(id) ON DELETE CASCADE,
  run_id      BIGINT,
  reason_code TEXT NOT NULL DEFAULT 'guard',
  reason      TEXT NOT NULL DEFAULT '',
  question    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'open',
  resolution  TEXT NOT NULL DEFAULT '',
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_escalation_open ON agent_escalation (seller_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS assignment_suggestion (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL,
  seller_id    TEXT NOT NULL,
  agent_id     UUID NOT NULL REFERENCES ai_agent(id) ON DELETE CASCADE,
  customer_key TEXT NOT NULL,
  score        NUMERIC(5, 2) NOT NULL DEFAULT 0,
  reason       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',
  created_by   TEXT NOT NULL DEFAULT 'agent',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, customer_key)
);
CREATE INDEX IF NOT EXISTS idx_suggestion_pending ON assignment_suggestion (seller_id, status, score DESC);
