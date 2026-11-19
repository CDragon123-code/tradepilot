-- 003_ai_agent.sql · 智能业务员平台层
-- 说明：M1 只做“业务员 + 客户归属 + 剧本 + 任务 + 触达流水”，发送仍由人工一键确认
-- 客户键 customer_key 暂用询盘 platform_id（M1 以询盘为触达单元），后续升级为客户身份 ID

CREATE TABLE IF NOT EXISTS ai_agent (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL,
  seller_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  persona     TEXT NOT NULL DEFAULT '',
  language    TEXT NOT NULL DEFAULT 'en',
  daily_limit INTEGER NOT NULL DEFAULT 20,
  quiet_start TEXT NOT NULL DEFAULT '23:00',
  quiet_end   TEXT NOT NULL DEFAULT '07:00',
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_seller ON ai_agent (seller_id, status);

CREATE TABLE IF NOT EXISTS customer_owner (
  tenant_id    TEXT NOT NULL,
  seller_id    TEXT NOT NULL,
  customer_key TEXT NOT NULL,
  agent_id     UUID NOT NULL REFERENCES ai_agent(id) ON DELETE CASCADE,
  source       TEXT NOT NULL DEFAULT 'rule',
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seller_id, customer_key)
);
CREATE INDEX IF NOT EXISTS idx_owner_agent ON customer_owner (agent_id);

CREATE TABLE IF NOT EXISTS playbook (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  TEXT NOT NULL,
  seller_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  steps      JSONB NOT NULL DEFAULT '[]'::jsonb,
  version    INTEGER NOT NULL DEFAULT 1,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_task (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL,
  seller_id   TEXT NOT NULL,
  agent_id    UUID NOT NULL REFERENCES ai_agent(id) ON DELETE CASCADE,
  playbook_id UUID REFERENCES playbook(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  daily_limit INTEGER NOT NULL DEFAULT 20,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_agent ON ai_task (agent_id, status);

CREATE TABLE IF NOT EXISTS task_item (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID NOT NULL REFERENCES ai_task(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL,
  seller_id       TEXT NOT NULL,
  agent_id        UUID NOT NULL,
  customer_key    TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  draft_text      TEXT NOT NULL DEFAULT '',
  last_error      TEXT NOT NULL DEFAULT '',
  next_at         TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, customer_key)
);
CREATE INDEX IF NOT EXISTS idx_item_state ON task_item (task_id, state, next_at);

CREATE TABLE IF NOT EXISTS message_event (
  id              BIGSERIAL PRIMARY KEY,
  task_item_id    UUID REFERENCES task_item(id) ON DELETE SET NULL,
  tenant_id       TEXT NOT NULL,
  seller_id       TEXT NOT NULL,
  direction       TEXT NOT NULL,
  content         TEXT NOT NULL,
  platform_msg_id TEXT,
  state           TEXT NOT NULL DEFAULT 'recorded',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_item ON message_event (task_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS do_not_contact (
  tenant_id    TEXT NOT NULL,
  seller_id    TEXT NOT NULL,
  customer_key TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  until        TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seller_id, customer_key)
);
