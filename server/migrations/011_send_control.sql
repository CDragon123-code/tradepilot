-- 011_send_control.sql · 店铺级发送停机开关
-- 说明：与业务员状态（ai_agent.status）分离。停机后执行列表与领取接口都返回阻断原因，
--       自动发送与人工执行台都不能再领取；恢复后无需重启服务。
CREATE TABLE IF NOT EXISTS seller_control (
  tenant_id    TEXT NOT NULL,
  seller_id    TEXT NOT NULL,
  send_paused  BOOLEAN NOT NULL DEFAULT false,
  pause_reason TEXT NOT NULL DEFAULT '',
  paused_at    TIMESTAMPTZ,
  updated_by   TEXT NOT NULL DEFAULT '',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seller_id)
);

-- 不联系名单已有表；补更新时间用于列表排序与审计
ALTER TABLE do_not_contact ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
