-- 010_exec_control.sql · 发送闸门与执行租约
-- 说明：M2.3 让每日上限、冷却期、静默时段真正生效；M2.4 用租约避免同一执行项被重复发送。
ALTER TABLE ai_agent ADD COLUMN IF NOT EXISTS cooldown_hours INTEGER NOT NULL DEFAULT 24;
-- 店铺时区偏移（分钟，东八区为 480），用于判定“当日”和静默时段，避免服务器 UTC 误判
ALTER TABLE ai_agent ADD COLUMN IF NOT EXISTS tz_offset_minutes INTEGER NOT NULL DEFAULT 480;

ALTER TABLE task_item ADD COLUMN IF NOT EXISTS claimed_by   TEXT NOT NULL DEFAULT '';
ALTER TABLE task_item ADD COLUMN IF NOT EXISTS claimed_at   TIMESTAMPTZ;
ALTER TABLE task_item ADD COLUMN IF NOT EXISTS claim_token  TEXT NOT NULL DEFAULT '';
ALTER TABLE task_item ADD COLUMN IF NOT EXISTS sent_at      TIMESTAMPTZ;
ALTER TABLE task_item ADD COLUMN IF NOT EXISTS platform_msg_id TEXT;

CREATE INDEX IF NOT EXISTS idx_item_claim ON task_item (state, claimed_at);
CREATE INDEX IF NOT EXISTS idx_message_out ON message_event (seller_id, direction, created_at DESC);
