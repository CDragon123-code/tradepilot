'use strict';

// 员工账号管理（运维用）
// 新增/改密：node src/user-cli.js add <email> <password> [--name 张三] [--role admin] [--seller seller-main]
// 绑定阿里账号：node src/user-cli.js bind-account <email> <阿里登录名>
// 列表：    node src/user-cli.js list
const { PgStore } = require('./store-pg');
const { hashPassword } = require('./auth');
const log = require('./log');

function argOf(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

(async () => {
  const cmd = process.argv[2] || 'list';
  const store = new PgStore(process.env.DATABASE_URL);
  const tenantId = String(process.env.TENANT_ID || 'default').trim();
  try {
    if (cmd === 'list') {
      const rows = await store.listEmployees(tenantId);
      rows.forEach((r) => console.log([r.email, r.name || '-', r.role, r.status].join('\t')));
      return;
    }
    if (cmd === 'bind-account') {
      const email = String(process.argv[3] || '').trim().toLowerCase();
      const loginName = String(process.argv[4] || '').trim();
      if (!email || !loginName) {
        console.error('用法：node src/user-cli.js bind-account <email> <阿里登录名>');
        process.exit(1);
      }
      const emp = await store.findEmployeeByEmail(tenantId, email);
      if (!emp) {
        console.error('员工不存在：' + email);
        process.exit(1);
      }
      const account = await store.findAlibabaAccountByLogin(tenantId, loginName);
      if (!account) {
        console.error('阿里账号不存在：' + loginName);
        process.exit(1);
      }
      const seller = argOf('seller', account.seller_id);
      if (seller !== account.seller_id) {
        console.error('员工店铺必须与阿里账号一致：' + account.seller_id);
        process.exit(1);
      }
      await store.setPrimaryMembership({ employeeId: emp.id, tenantId: tenantId, sellerId: seller });
      await store.setEmployeeAlibabaAccount(tenantId, emp.id, account.id);
      await store.deleteSessionsByEmployee(emp.id);
      log.info('employee_bound', {
        email: emp.email, login_name: account.login_name, seller: seller, account_id: account.id,
      });
      return;
    }
    if (cmd !== 'add') {
      console.error('用法：node src/user-cli.js add <email> <password> [--name 张三] [--role admin] [--seller seller-main]'
        + ' 或 bind-account <email> <阿里登录名>');
      process.exit(1);
    }
    const email = String(process.argv[3] || '').trim().toLowerCase();
    const password = String(process.argv[4] || '');
    if (!email || password.length < 8) {
      console.error('邮箱必填，密码至少 8 位');
      process.exit(1);
    }
    const emp = await store.createEmployee({
      tenantId: tenantId,
      email: email,
      name: argOf('name', ''),
      passwordHash: hashPassword(password),
      role: argOf('role', 'operator'),
    });
    const seller = argOf('seller', String(process.env.SELLER_ID || 'seller-main'));
    await store.bindMembership({ employeeId: emp.id, tenantId: tenantId, sellerId: seller, canIngest: true });
    log.info('employee_saved', { email: emp.email, role: emp.role, seller: seller });
  } finally {
    await store.close();
  }
})().catch((e) => {
  log.error('user_cli_failed', { error: String((e && e.message) || e) });
  process.exit(1);
});
