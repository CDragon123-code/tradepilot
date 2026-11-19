-- 015_seller_partition.sql · 子账号数据仓初始化
-- seller_id 是业务表的分区键；这里只登记可被员工绑定的子账号，不迁移历史数据。
INSERT INTO alibaba_account (tenant_id, seller_id, login_name, account_type, owner_name, display_name, note)
SELECT 'default', 'seller-sub', 'Sub Account', 'sub', 'Sub Account', 'Sub Account（子账号）', '迁移初始化：子账号独立数据仓'
WHERE NOT EXISTS (
  SELECT 1 FROM alibaba_account WHERE tenant_id = 'default' AND seller_id = 'seller-sub'
);
