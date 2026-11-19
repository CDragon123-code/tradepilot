-- 002_auth_notice.sql · 员工账号、会话与提醒去重
-- 目标：扩展登录一次即可自动绑定店铺；提醒机器人按“询盘 + 优先级”去重，避免重复轰炸

CREATE TABLE IF NOT EXISTS employee (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'operator',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS membership (
  employee_id UUID NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL,
  seller_id   TEXT NOT NULL,
  can_ingest  BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, tenant_id, seller_id)
);

CREATE TABLE IF NOT EXISTS auth_session (
  token_hash   TEXT PRIMARY KEY,
  employee_id  UUID NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  tenant_id    TEXT NOT NULL,
  seller_id    TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_employee ON auth_session (employee_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS notice_log (
  tenant_id   TEXT NOT NULL,
  seller_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  priority    TEXT NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seller_id, kind, platform_id, priority)
);
CREATE INDEX IF NOT EXISTS idx_notice_sent ON notice_log (seller_id, sent_at DESC);
