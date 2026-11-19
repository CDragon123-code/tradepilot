-- 014_alibaba_accounts.sql · 阿里国际站账号注册表与员工绑定
-- 说明：
--   1) 只存阿里登录名、账号类型、店铺、负责人与显示名，不存阿里密码；
--   2) 员工通过 alibaba_account_id 绑定一个阿里账号，云端登录仍使用独立邮箱和密码；
--   3) seller_id 仍由 membership 决定，绑定时要求与阿里账号的 seller_id 一致。
CREATE TABLE IF NOT EXISTS alibaba_account (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL,
  seller_id    TEXT NOT NULL DEFAULT '',
  login_name   TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'sub',
  owner_name   TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, login_name)
);

CREATE INDEX IF NOT EXISTS alibaba_account_tenant_idx
  ON alibaba_account (tenant_id, created_at DESC);

ALTER TABLE employee
  ADD COLUMN IF NOT EXISTS alibaba_account_id UUID
  REFERENCES alibaba_account(id) ON DELETE SET NULL;

-- 示例主账号；仅初始化一次，不改已有数据
INSERT INTO alibaba_account (tenant_id, seller_id, login_name, account_type, owner_name, display_name, note)
SELECT 'default', 'seller-main', 'main_account', 'main', 'main_account', '主账号', '迁移初始化'
WHERE NOT EXISTS (
  SELECT 1 FROM alibaba_account WHERE tenant_id = 'default' AND login_name = 'main_account'
);
