-- 013_api_gateway_permissions.sql · API 网关令牌、调用流水与操作审计
-- 说明：
--   1) api_client 只存令牌 sha256 与展示前缀，明文令牌仅在创建/轮换时返回一次；
--   2) api_call_log 记录每一次数据接口调用的状态与耗时，用于网关概览与排障；
--   3) audit_log 记录权限、主数据、门禁等关键操作，供「权限与审计」页面查询。
CREATE TABLE IF NOT EXISTS api_client (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL,
  seller_id    TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'external',
  scopes       TEXT[] NOT NULL DEFAULT ARRAY['read']::TEXT[],
  rate_limit   INT NOT NULL DEFAULT 120,
  token_hash   TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active',
  created_by   TEXT NOT NULL DEFAULT '',
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_client_tenant_idx
  ON api_client (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_call_log (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  client_id   UUID,
  client_name TEXT NOT NULL DEFAULT '',
  actor_type  TEXT NOT NULL DEFAULT 'anonymous',
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  status      INT NOT NULL,
  ms          INT NOT NULL DEFAULT 0,
  ip          TEXT NOT NULL DEFAULT '',
  request_id  TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_call_log_tenant_idx
  ON api_call_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_call_log_client_idx
  ON api_call_log (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'anonymous',
  actor_id   TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip         TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_tenant_idx
  ON audit_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx
  ON audit_log (tenant_id, action, created_at DESC);
