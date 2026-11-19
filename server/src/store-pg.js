'use strict';

// PostgreSQL 存储：与 MemoryStore 同一契约，负责批次、分片、当前态与变更
const { Pool } = require('pg');
const { mergePayload } = require('./payload-merge');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 单条 SQL 处理的行数：太大占内存与参数上限，太小则往返变多
const COMMIT_CHUNK = 1000;

function err(status, code, message) {
  const e = new Error(message || code);
  e.status = status;
  e.code = code;
  return e;
}

class PgStore {
  constructor(databaseUrl) {
    this.name = 'pg';
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      application_name: 'ali-cloud-api',
    });
  }

  async close() {
    await this.pool.end();
  }

  // 健康检查：只做一次最轻的连通性探测
  async ping() {
    await this.pool.query('SELECT 1');
    return true;
  }

  async listTodoDecisions(tenantId, sellerId, ids) {
    if (!ids.length) return [];
    const r = await this.pool.query(
      `SELECT todo_id, state, note, title, actor_id, updated_at FROM todo_decision
       WHERE tenant_id = $1 AND seller_id = $2 AND todo_id = ANY($3::text[])
       ORDER BY updated_at DESC`, [tenantId, sellerId, ids]);
    return r.rows;
  }

  async setTodoDecision({ tenantId, sellerId, todoId, state, note, title, actorId }) {
    if (state === 'open') {
      await this.pool.query('DELETE FROM todo_decision WHERE tenant_id = $1 AND seller_id = $2 AND todo_id = $3',
        [tenantId, sellerId, todoId]);
      return;
    }
    await this.pool.query(
      `INSERT INTO todo_decision (tenant_id, seller_id, todo_id, state, note, title, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, seller_id, todo_id)
       DO UPDATE SET state = EXCLUDED.state, note = EXCLUDED.note, title = EXCLUDED.title,
         actor_id = EXCLUDED.actor_id, updated_at = now()`,
      [tenantId, sellerId, todoId, state, note, title, actorId]);
  }

  // ---------------- 主数据人工合并 ----------------

  async listMasterMerges(tenantId, sellerId) {
    const r = await this.pool.query(
      `SELECT tenant_id, seller_id, primary_uid, merged_uid, note, actor_id, created_at
       FROM master_merge
       WHERE tenant_id = $1 AND seller_id = $2
       ORDER BY created_at DESC`,
      [tenantId, sellerId],
    );
    return r.rows;
  }

  async upsertMasterMerge({ tenantId, sellerId, primaryUid, mergedUid, note, actorId }) {
    const r = await this.pool.query(
      `INSERT INTO master_merge (tenant_id, seller_id, primary_uid, merged_uid, note, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, seller_id, merged_uid) DO UPDATE SET
         primary_uid = EXCLUDED.primary_uid,
         note = EXCLUDED.note,
         actor_id = EXCLUDED.actor_id
       RETURNING tenant_id, seller_id, primary_uid, merged_uid, note, actor_id, created_at`,
      [tenantId, sellerId, primaryUid, mergedUid,
        String(note || '').slice(0, 200), String(actorId || '').slice(0, 200)],
    );
    return r.rows[0];
  }

  async deleteMasterMerge(tenantId, sellerId, mergedUid) {
    const r = await this.pool.query(
      `DELETE FROM master_merge
       WHERE tenant_id = $1 AND seller_id = $2 AND merged_uid = $3
       RETURNING tenant_id, seller_id, primary_uid, merged_uid, note, actor_id, created_at`,
      [tenantId, sellerId, mergedUid],
    );
    return r.rows[0] || null;
  }

  async createBatch({ tenantId, sellerId, kind, meta }) {
    const r = await this.pool.query(
      `INSERT INTO source_batch (id, tenant_id, seller_id, kind, meta)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)
       RETURNING id, status, created_at`,
      [tenantId, sellerId, kind, meta || {}],
    );
    return r.rows[0];
  }

  async putPart({ batchId, partNo, checksum, rows }) {
    if (!UUID_RE.test(String(batchId))) throw err(404, 'import_not_found', '导入批次不存在');
    const b = await this.pool.query('SELECT status FROM source_batch WHERE id = $1', [batchId]);
    if (!b.rowCount) throw err(404, 'import_not_found', '导入批次不存在');
    if (b.rows[0].status === 'committed') throw err(409, 'import_committed', '批次已提交，不能再上传分片');
    const ins = await this.pool.query(
      `INSERT INTO source_part (batch_id, part_no, checksum, row_count, rows)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (batch_id, part_no) DO NOTHING
       RETURNING row_count`,
      [batchId, partNo, checksum, rows.length, JSON.stringify(rows)],
    );
    if (ins.rowCount) return { duplicate: false, row_count: ins.rows[0].row_count };
    const prev = await this.pool.query('SELECT checksum, row_count FROM source_part WHERE batch_id = $1 AND part_no = $2', [batchId, partNo]);
    if (prev.rowCount && prev.rows[0].checksum === checksum) return { duplicate: true, row_count: prev.rows[0].row_count };
    throw err(409, 'part_conflict', '同一分片号已上传过不同内容');
  }

  async commit(batchId) {
    if (!UUID_RE.test(String(batchId))) throw err(404, 'import_not_found', '导入批次不存在');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const b = await client.query('SELECT * FROM source_batch WHERE id = $1 FOR UPDATE', [batchId]);
      if (!b.rowCount) throw err(404, 'import_not_found', '导入批次不存在');
      const batch = b.rows[0];
      if (batch.status === 'committed') {
        await client.query('COMMIT');
        return batch.result;
      }
      const parts = await client.query('SELECT part_no, rows FROM source_part WHERE batch_id = $1 ORDER BY part_no', [batchId]);
      if (!parts.rowCount) throw err(400, 'no_parts', '还没有上传任何分片');
      const merged = new Map();
      parts.rows.forEach((p) => {
        (p.rows || []).forEach((row) => merged.set(row.platform_id, row));
      });
      const list = Array.from(merged.values());
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      // 所有类型的空白字段都视为“未知”，任何来源都不应冲掉已有非空值
      // （主账号/子账号、采集器/扩展共用同一 seller_id 时，避免子账号的局部快照抹掉主账号字段）
      const keepFilled = true;
      // 分块批量写入：每块两条 SQL（原始留档 + 当前态 upsert），避免逐行往返
      for (let i = 0; i < list.length; i += COMMIT_CHUNK) {
        const chunk = list.slice(i, i + COMMIT_CHUNK);
        const ids = chunk.map((row) => row.platform_id);
        let payloads;
        if (keepFilled) {
          const prevs = await client.query(
            `SELECT platform_id, payload FROM current_record
             WHERE tenant_id = $1 AND seller_id = $2 AND kind = $3 AND platform_id = ANY($4::text[])`,
            [batch.tenant_id, batch.seller_id, batch.kind, ids],
          );
          const prevMap = new Map(prevs.rows.map((r) => [r.platform_id, r.payload]));
          payloads = chunk.map((row) => JSON.stringify(mergePayload(prevMap.get(row.platform_id), row.payload)));
        } else {
          payloads = chunk.map((row) => JSON.stringify(row.payload));
        }
        const businessAt = chunk.map((row) => (row.business_at ? new Date(row.business_at) : null));
        const observedAt = chunk.map((row) => new Date(row.observed_at || Date.now()));

        await client.query(
          `INSERT INTO source_record (tenant_id, seller_id, kind, platform_id, batch_id, payload, business_at, observed_at)
           SELECT $1, $2, $3, u.platform_id, $4, u.payload::jsonb, u.business_at, u.observed_at
           FROM unnest($5::text[], $6::text[], $7::timestamptz[], $8::timestamptz[])
             AS u(platform_id, payload, business_at, observed_at)`,
          [batch.tenant_id, batch.seller_id, batch.kind, batchId, ids, payloads, businessAt, observedAt],
        );

        const up = await client.query(
          `INSERT INTO current_record (tenant_id, seller_id, kind, platform_id, payload, business_at, observed_at, updated_at)
           SELECT $1, $2, $3, u.platform_id, u.payload::jsonb, u.business_at, u.observed_at, now()
           FROM unnest($4::text[], $5::text[], $6::timestamptz[], $7::timestamptz[])
             AS u(platform_id, payload, business_at, observed_at)
           ON CONFLICT (tenant_id, seller_id, kind, platform_id)
           DO UPDATE SET payload = EXCLUDED.payload,
                         business_at = EXCLUDED.business_at,
                         observed_at = EXCLUDED.observed_at,
                         updated_at = now()
           WHERE current_record.business_at IS NULL
              OR EXCLUDED.business_at IS NULL
              OR EXCLUDED.business_at >= current_record.business_at
           RETURNING (xmax = 0) AS inserted`,
          [batch.tenant_id, batch.seller_id, batch.kind, ids, payloads, businessAt, observedAt],
        );
        const ins = up.rows.filter((r) => r.inserted).length;
        inserted += ins;
        updated += up.rowCount - ins;
        skipped += chunk.length - up.rowCount;
      }
      const result = { received: merged.size, inserted: inserted, updated: updated, skipped: skipped, part_count: parts.rowCount };
      await client.query('UPDATE source_batch SET status = $2, committed_at = now(), result = $3 WHERE id = $1', [batchId, 'committed', result]);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async syncStatus(sellerId) {
    const [batches, records] = await Promise.all([
      this.pool.query(
        `SELECT kind, max(committed_at) AS last_success_at, count(*)::int AS batches
         FROM source_batch WHERE seller_id = $1 AND status = 'committed' GROUP BY kind`,
        [sellerId],
      ),
      this.pool.query(
        `SELECT kind, count(*)::int AS rows, max(business_at) AS last_business_at
         FROM current_record WHERE seller_id = $1 GROUP BY kind`,
        [sellerId],
      ),
    ]);
    const map = new Map();
    const blank = (kind) => ({ kind: kind, last_success_at: null, batches: 0, rows: 0, last_business_at: null });
    records.rows.forEach((r) => {
      const cur = map.get(r.kind) || blank(r.kind);
      cur.rows = r.rows;
      cur.last_business_at = r.last_business_at;
      map.set(r.kind, cur);
    });
    batches.rows.forEach((r) => {
      const cur = map.get(r.kind) || blank(r.kind);
      cur.batches = r.batches;
      cur.last_success_at = r.last_success_at;
      map.set(r.kind, cur);
    });
    return Array.from(map.values()).sort((a, b) => a.kind.localeCompare(b.kind));
  }

  async changes({ sellerId, since, limit }) {
    const r = await this.pool.query(
      `SELECT kind, platform_id, payload, business_at, updated_at
       FROM current_record
       WHERE seller_id = $1 AND updated_at > $2
       ORDER BY updated_at ASC
       LIMIT $3`,
      [sellerId, since, limit],
    );
    return r.rows;
  }

  // 按类型取当前态整行，供领域逻辑（待办/归并）复用
  async rowsByKind(sellerId, kinds, opts) {
    const list = kinds || [];
    if (!list.length) return {};
    const params = [sellerId, list];
    let sql = 'SELECT kind, payload FROM current_record WHERE seller_id = $1 AND kind = ANY($2::text[])';
    const sinceDays = Number(opts && opts.sinceDays) || 0;
    if (sinceDays) {
      params.push(new Date(Date.now() - sinceDays * 86400000));
      sql += ' AND (business_at IS NULL OR business_at >= $3)';
    }
    const r = await this.pool.query(sql, params);
    const out = {};
    list.forEach((k) => { out[k] = []; });
    r.rows.forEach((row) => {
      if (out[row.kind]) out[row.kind].push(row.payload);
    });
    return out;
  }

  // 询盘列表：关键词 / 国家 / 来源 / 加客 / 等级 + 分页
  async listInquiries(query) {
    const opts = query || {};
    const page = Math.max(1, Number(opts.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(opts.pageSize) || 20));
    const params = [opts.sellerId];
    const where = ['seller_id = $1', "kind = 'inquiry'"];
    const text = String(opts.q || '').trim();
    if (text) {
      params.push('%' + text + '%');
      const i = params.length;
      where.push("(coalesce(payload->>'客户名称','') ILIKE $" + i + " OR coalesce(payload->>'公司名称','') ILIKE $" + i + ')');
    }
    if (opts.country) { params.push(String(opts.country)); where.push("payload->>'国家' = $" + params.length); }
    if (opts.source) { params.push(String(opts.source)); where.push("payload->>'来源' = $" + params.length); }
    if (opts.added) { params.push(String(opts.added)); where.push("payload->>'是否已加为客户' = $" + params.length); }
    if (opts.grade) {
      params.push(String(opts.grade).toUpperCase());
      const i = params.length;
      where.push("(upper(coalesce(payload->>'买家等级','')) = $" + i + " OR upper(coalesce(payload->>'买家等级(字母)','')) = $" + i + ')');
    }
    const cond = where.join(' AND ');
    const count = await this.pool.query('SELECT count(*)::int AS total FROM current_record WHERE ' + cond, params);
    const offset = (page - 1) * pageSize;
    const rows = await this.pool.query(
      'SELECT platform_id, business_at, updated_at, payload FROM current_record WHERE ' + cond
      + ' ORDER BY business_at DESC NULLS LAST, updated_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2),
      params.concat([pageSize, offset]),
    );
    return { total: count.rows[0].total, page: page, pageSize: pageSize, rows: rows.rows };
  }

  // 只读摘要：逐源健康 + 数据缺口 + 最近批次
  async summary(sellerId, now) {
    const { composeSummary } = require('./summary');
    const [sources, inquiry, order, chat, recent] = await Promise.all([
      this.syncStatus(sellerId),
      this.pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE btrim(coalesce(payload->>'客户名称','')) IN ('','-'))::int AS no_name,
                count(*) FILTER (WHERE btrim(coalesce(payload->>'公司名称','')) IN ('','-'))::int AS no_company,
                count(*) FILTER (WHERE btrim(coalesce(payload->>'国家','')) IN ('','-'))::int AS no_country,
                count(*) FILTER (WHERE btrim(coalesce(payload->>'买家等级','')) IN ('','-')
                                   AND btrim(coalesce(payload->>'买家等级(字母)','')) IN ('','-'))::int AS no_grade,
                count(*) FILTER (WHERE (coalesce(payload->>'来源','') || coalesce(payload->>'来源端','')) ~ '营销|广告|直通车|mkt')::int AS ad_total,
                count(*) FILTER (WHERE (coalesce(payload->>'来源','') || coalesce(payload->>'来源端','')) ~ '营销|广告|直通车|mkt'
                                   AND btrim(coalesce(payload->>'客户名称','')) NOT IN ('','-'))::int AS ad_named
         FROM current_record WHERE seller_id = $1 AND kind = 'inquiry'`,
        [sellerId],
      ),
      this.pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE btrim(coalesce(payload->>'询盘ID','')) IN ('','-'))::int AS no_inquiry_id
         FROM current_record WHERE seller_id = $1 AND kind = 'order'`,
        [sellerId],
      ),
      this.pool.query(
        `SELECT count(*)::int AS total,
                count(DISTINCT nullif(btrim(coalesce(payload->>'会话','')), ''))::int AS sessions
         FROM current_record WHERE seller_id = $1 AND kind = 'chat'`,
        [sellerId],
      ),
      this.pool.query(
        `SELECT id, kind, committed_at, coalesce((result->>'received')::int, 0) AS rows
         FROM source_batch
         WHERE seller_id = $1 AND status = 'committed'
         ORDER BY committed_at DESC LIMIT 5`,
        [sellerId],
      ),
    ]);
    const iq = inquiry.rows[0] || {};
    const od = order.rows[0] || {};
    const ch = chat.rows[0] || {};
    return composeSummary({
      sellerId: sellerId,
      sources: sources,
      inquiry: {
        total: iq.total, noName: iq.no_name, noCompany: iq.no_company, noCountry: iq.no_country,
        noGrade: iq.no_grade, adTotal: iq.ad_total, adNamed: iq.ad_named,
      },
      order: { total: od.total, noInquiryId: od.no_inquiry_id },
      chat: { total: ch.total, sessions: ch.sessions },
      recent: recent.rows.map((r) => ({ id: r.id, kind: r.kind, committed_at: r.committed_at, rows: r.rows })),
      now: now,
    });
  }
  // ---------------- 员工与会话 ----------------

  async createEmployee({ tenantId, email, name, passwordHash, role }) {
    const r = await this.pool.query(
      `INSERT INTO employee (tenant_id, email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             name = EXCLUDED.name,
             role = EXCLUDED.role,
             updated_at = now()
       RETURNING id, email, name, role, status`,
      [tenantId, String(email).trim().toLowerCase(), name || '', passwordHash, role || 'operator'],
    );
    return r.rows[0];
  }

  async findEmployeeByEmail(tenantId, email) {
    const r = await this.pool.query(
      `SELECT id, tenant_id, email, name, password_hash, role, status
       FROM employee WHERE tenant_id = $1 AND email = $2`,
      [tenantId, String(email).trim().toLowerCase()],
    );
    return r.rows[0] || null;
  }

  async listEmployees(tenantId) {
    const r = await this.pool.query(
      `SELECT e.id, e.email, e.name, e.role, e.status, e.created_at, e.alibaba_account_id,
              a.login_name AS alibaba_login, a.account_type AS alibaba_type,
              a.owner_name, a.display_name AS alibaba_display_name, a.status AS alibaba_status,
              (SELECT m.seller_id FROM membership m
               WHERE m.employee_id = e.id ORDER BY m.created_at LIMIT 1) AS seller_id
       FROM employee e
       LEFT JOIN alibaba_account a ON a.id = e.alibaba_account_id
       WHERE e.tenant_id = $1
       ORDER BY e.created_at`,
      [tenantId],
    );
    return r.rows;
  }

  async getEmployee(tenantId, id) {
    const r = await this.pool.query(
      `SELECT id, email, name, role, status, created_at, alibaba_account_id
       FROM employee WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return r.rows[0] || null;
  }

  async updateEmployee({ tenantId, id, name, email, role, status, passwordHash }) {
    const r = await this.pool.query(
      `UPDATE employee
       SET name = COALESCE($3, name),
           role = COALESCE($4, role),
           status = COALESCE($5, status),
           password_hash = COALESCE($6, password_hash),
           email = COALESCE($7, email),
           updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING id, email, name, role, status`,
      [tenantId, id, name === undefined ? null : name, role || null, status || null, passwordHash || null,
        email === undefined ? null : email],
    );
    return r.rows[0] || null;
  }

  async deleteEmployee(tenantId, id) {
    const r = await this.pool.query(
      'DELETE FROM employee WHERE tenant_id = $1 AND id = $2 RETURNING email',
      [tenantId, id],
    );
    return r.rows[0] || null;
  }

  // ---------------- 阿里国际站账号注册表 ----------------

  async listAlibabaAccounts(tenantId) {
    const r = await this.pool.query(
      `SELECT id, tenant_id, seller_id, login_name, account_type, owner_name,
              display_name, note, status, created_at, updated_at
       FROM alibaba_account WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return r.rows;
  }

  async getAlibabaAccount(tenantId, id) {
    const r = await this.pool.query(
      `SELECT id, tenant_id, seller_id, login_name, account_type, owner_name,
              display_name, note, status, created_at, updated_at
       FROM alibaba_account WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenantId, id],
    );
    return r.rows[0] || null;
  }

  async findAlibabaAccountByLogin(tenantId, loginName) {
    const r = await this.pool.query(
      `SELECT id, tenant_id, seller_id, login_name, account_type, owner_name,
              display_name, note, status, created_at, updated_at
       FROM alibaba_account WHERE tenant_id = $1 AND login_name = $2`,
      [tenantId, loginName],
    );
    return r.rows[0] || null;
  }

  async createAlibabaAccount({ tenantId, sellerId, loginName, accountType, ownerName, displayName, note }) {
    const r = await this.pool.query(
      `INSERT INTO alibaba_account
         (tenant_id, seller_id, login_name, account_type, owner_name, display_name, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, tenant_id, seller_id, login_name, account_type, owner_name,
                 display_name, note, status, created_at, updated_at`,
      [tenantId, sellerId || '', loginName, accountType || 'sub',
        ownerName || '', displayName || '', note || ''],
    );
    return r.rows[0];
  }

  async updateAlibabaAccount({ tenantId, id, loginName, sellerId, accountType, ownerName, displayName, note, status }) {
    const r = await this.pool.query(
      `UPDATE alibaba_account SET
         login_name = COALESCE($3, login_name),
         seller_id = COALESCE($4, seller_id),
         account_type = COALESCE($5, account_type),
         owner_name = COALESCE($6, owner_name),
         display_name = COALESCE($7, display_name),
         note = COALESCE($8, note),
         status = COALESCE($9, status),
         updated_at = now()
       WHERE tenant_id = $1 AND id = $2::uuid
       RETURNING id, tenant_id, seller_id, login_name, account_type, owner_name,
                 display_name, note, status, created_at, updated_at`,
      [tenantId, id,
        loginName === undefined ? null : loginName,
        sellerId === undefined ? null : sellerId,
        accountType === undefined ? null : accountType,
        ownerName === undefined ? null : ownerName,
        displayName === undefined ? null : displayName,
        note === undefined ? null : note,
        status === undefined ? null : status],
    );
    return r.rows[0] || null;
  }

  async deleteAlibabaAccount(tenantId, id) {
    const r = await this.pool.query(
      'DELETE FROM alibaba_account WHERE tenant_id = $1 AND id = $2::uuid RETURNING login_name',
      [tenantId, id],
    );
    return r.rows[0] || null;
  }

  async setEmployeeAlibabaAccount(tenantId, employeeId, accountId) {
    const r = await this.pool.query(
      `UPDATE employee SET alibaba_account_id = $3::uuid, updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING id, alibaba_account_id`,
      [tenantId, employeeId, accountId || null],
    );
    return r.rows[0] || null;
  }

  async bindMembership({ employeeId, tenantId, sellerId, canIngest }) {
    await this.pool.query(
      `INSERT INTO membership (employee_id, tenant_id, seller_id, can_ingest)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (employee_id, tenant_id, seller_id) DO UPDATE SET can_ingest = EXCLUDED.can_ingest`,
      [employeeId, tenantId, sellerId, canIngest !== false],
    );
  }

  // 员工列表里的“店铺”是单值：改店铺时更新已有 membership，避免旧记录继续抢占 primaryMembership
  async setPrimaryMembership({ employeeId, tenantId, sellerId }) {
    const upd = await this.pool.query(
      `UPDATE membership SET seller_id = $3, can_ingest = true
       WHERE employee_id = $1 AND tenant_id = $2`,
      [employeeId, tenantId, sellerId],
    );
    if (!upd.rowCount) {
      await this.pool.query(
        `INSERT INTO membership (employee_id, tenant_id, seller_id, can_ingest)
         VALUES ($1, $2, $3, true)`,
        [employeeId, tenantId, sellerId],
      );
    }
  }

  async deleteSessionsByEmployee(employeeId) {
    const r = await this.pool.query('DELETE FROM auth_session WHERE employee_id = $1', [employeeId]);
    return r.rowCount;
  }

  async primaryMembership(employeeId) {
    const r = await this.pool.query(
      `SELECT tenant_id, seller_id, can_ingest FROM membership
       WHERE employee_id = $1 ORDER BY created_at LIMIT 1`,
      [employeeId],
    );
    return r.rows[0] || null;
  }

  async createSession({ tokenHash, employeeId, tenantId, sellerId, role, expiresAt }) {
    await this.pool.query(
      `INSERT INTO auth_session (token_hash, employee_id, tenant_id, seller_id, role, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tokenHash, employeeId, tenantId, sellerId || '', role, expiresAt],
    );
  }

  async resolveSession(tokenHash) {
    const r = await this.pool.query(
      `SELECT s.employee_id, s.tenant_id, s.seller_id, s.role, s.expires_at,
              e.name, e.email, e.status
       FROM auth_session s JOIN employee e ON e.id = s.employee_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND e.status = 'active'`,
      [tokenHash],
    );
    return r.rows[0] || null;
  }

  async deleteSession(tokenHash) {
    await this.pool.query('DELETE FROM auth_session WHERE token_hash = $1', [tokenHash]);
  }

  // ---------------- API 网关、调用流水与操作审计 ----------------

  async createApiClient({ tenantId, sellerId, name, kind, scopes, rateLimit, tokenHash, tokenPrefix, createdBy }) {
    const r = await this.pool.query(
      `INSERT INTO api_client
         (tenant_id, seller_id, name, kind, scopes, rate_limit, token_hash, token_prefix, created_by)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9)
       RETURNING id, tenant_id, seller_id, name, kind, scopes, rate_limit, token_prefix,
                 status, created_by, last_used_at, created_at, updated_at`,
      [tenantId, sellerId || '', name, kind || 'external', scopes, rateLimit, tokenHash,
        tokenPrefix || '', createdBy || ''],
    );
    return r.rows[0];
  }

  async listApiClients(tenantId) {
    const r = await this.pool.query(
      `SELECT id, tenant_id, seller_id, name, kind, scopes, rate_limit, token_prefix,
              status, created_by, last_used_at, created_at, updated_at
       FROM api_client WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return r.rows;
  }

  async getApiClientByTokenHash(hash) {
    const r = await this.pool.query(
      `SELECT id, tenant_id, seller_id, name, kind, scopes, rate_limit, token_hash,
              token_prefix, status, created_by, last_used_at, created_at
       FROM api_client WHERE token_hash = $1`,
      [hash],
    );
    return r.rows[0] || null;
  }

  async updateApiClient({ tenantId, id, name, scopes, rateLimit, status, tokenHash, tokenPrefix }) {
    const r = await this.pool.query(
      `UPDATE api_client SET
         name = COALESCE($3, name),
         scopes = COALESCE($4::text[], scopes),
         rate_limit = COALESCE($5, rate_limit),
         status = COALESCE($6, status),
         token_hash = COALESCE($7, token_hash),
         token_prefix = COALESCE($8, token_prefix),
         updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING id, tenant_id, seller_id, name, kind, scopes, rate_limit, token_prefix,
                 status, created_by, last_used_at, created_at, updated_at`,
      [tenantId, id,
        name === undefined ? null : name,
        scopes === undefined ? null : scopes,
        rateLimit === undefined ? null : rateLimit,
        status === undefined ? null : status,
        tokenHash === undefined ? null : tokenHash,
        tokenPrefix === undefined ? null : tokenPrefix],
    );
    return r.rows[0] || null;
  }

  async deleteApiClient(tenantId, id) {
    const r = await this.pool.query(
      'DELETE FROM api_client WHERE tenant_id = $1 AND id = $2 RETURNING name, token_prefix',
      [tenantId, id],
    );
    return r.rows[0] || null;
  }

  async touchApiClient(id) {
    await this.pool.query('UPDATE api_client SET last_used_at = now() WHERE id = $1', [id]);
  }

  async logApiCall({ tenantId, clientId, clientName, actorType, method, path, status, ms, ip, requestId }) {
    await this.pool.query(
      `INSERT INTO api_call_log
         (tenant_id, client_id, client_name, actor_type, method, path, status, ms, ip, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [tenantId, clientId || null, clientName || '', actorType || 'anonymous',
        method, path, status, ms, ip || '', requestId || ''],
    );
  }

  async listApiCalls(tenantId, options) {
    const opts = options || {};
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
    const minStatus = Number(opts.minStatus) || null;
    const r = await this.pool.query(
      `SELECT id, client_id, client_name, actor_type, method, path, status, ms, ip, request_id, created_at
       FROM api_call_log
       WHERE tenant_id = $1 AND ($2::int IS NULL OR status >= $2)
       ORDER BY created_at DESC LIMIT $3`,
      [tenantId, minStatus, limit],
    );
    return r.rows;
  }

  async apiCallStats(tenantId, since) {
    const [totals, paths] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status >= 400)::int AS errors,
                count(*) FILTER (WHERE status >= 500)::int AS server_errors,
                count(*) FILTER (WHERE status IN (401, 403))::int AS denied,
                coalesce(round(avg(ms)), 0)::int AS avg_ms
         FROM api_call_log WHERE tenant_id = $1 AND created_at >= $2`,
        [tenantId, since],
      ),
      this.pool.query(
        `SELECT path, count(*)::int AS count,
                count(*) FILTER (WHERE status >= 400)::int AS errors
         FROM api_call_log
         WHERE tenant_id = $1 AND created_at >= $2
         GROUP BY path ORDER BY count DESC LIMIT 8`,
        [tenantId, since],
      ),
    ]);
    const row = totals.rows[0] || {};
    return {
      total: row.total || 0, errors: row.errors || 0,
      server_errors: row.server_errors || 0, denied: row.denied || 0,
      avg_ms: row.avg_ms || 0, top_paths: paths.rows,
    };
  }

  async addAudit({ tenantId, actorType, actorId, actorName, action, target, detail, ip, requestId }) {
    await this.pool.query(
      `INSERT INTO audit_log
         (tenant_id, actor_type, actor_id, actor_name, action, target, detail, ip, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [tenantId, actorType || 'anonymous', actorId || '', actorName || '', action,
        target || '', JSON.stringify(detail || {}), ip || '', requestId || ''],
    );
  }

  async listAudit(tenantId, options) {
    const opts = options || {};
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
    const action = String(opts.action || '').trim();
    const actor = String(opts.actor || '').trim();
    const r = await this.pool.query(
      `SELECT id, tenant_id, actor_type, actor_id, actor_name, action, target, detail, ip, request_id, created_at
       FROM audit_log
       WHERE tenant_id = $1
         AND ($2 = '' OR action ILIKE '%' || $2 || '%')
         AND ($3 = '' OR actor_name ILIKE '%' || $3 || '%' OR actor_id ILIKE '%' || $3 || '%')
       ORDER BY created_at DESC LIMIT $4`,
      [tenantId, action, actor, limit],
    );
    return r.rows;
  }

  async countAudit(tenantId, since) {
    const r = await this.pool.query(
      'SELECT count(*)::int AS total FROM audit_log WHERE tenant_id = $1 AND created_at >= $2',
      [tenantId, since],
    );
    return (r.rows[0] && r.rows[0].total) || 0;
  }

  // ---------------- 提醒去重与待跟进询盘 ----------------

  async recentNotices(sellerId, withinHours) {
    const r = await this.pool.query(
      `SELECT platform_id, priority, sent_at FROM notice_log
       WHERE seller_id = $1 AND sent_at > now() - make_interval(hours => $2::int)`,
      [sellerId, Math.max(1, Number(withinHours) || 12)],
    );
    return r.rows;
  }

  async markNotices(rows) {
    for (const row of rows || []) {
      await this.pool.query(
        `INSERT INTO notice_log (tenant_id, seller_id, kind, platform_id, priority, sent_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (tenant_id, seller_id, kind, platform_id, priority) DO UPDATE SET sent_at = now()`,
        [row.tenantId, row.sellerId, row.kind || 'inquiry', row.platformId, row.priority],
      );
    }
  }

  async pendingInquiries(sellerId, hours, limit) {
    const r = await this.pool.query(
      `SELECT platform_id, payload, business_at, updated_at
       FROM current_record
       WHERE seller_id = $1 AND kind = 'inquiry'
         AND coalesce(payload->>'回复状态', '') NOT IN ('已回复', '1')
         AND coalesce(business_at, updated_at) > now() - make_interval(hours => $2::int)
       ORDER BY coalesce(business_at, updated_at) DESC
       LIMIT $3`,
      [sellerId, Math.max(1, Number(hours) || 72), Math.min(200, Number(limit) || 50)],
    );
    return r.rows;
  }

  // ---------------- 智能业务员 / 客户归属 / 任务 ----------------

  async listAgents(sellerId) {
    const r = await this.pool.query(
      `SELECT id, name, persona, language, daily_limit, cooldown_hours, quiet_start, quiet_end,
              tz_offset_minutes, status, dify_base_url, model, (dify_app_key <> '') AS has_key, created_at
       FROM ai_agent WHERE seller_id = $1 ORDER BY created_at`,
      [sellerId],
    );
    return r.rows;
  }

  async getAgent(tenantId, sellerId, id) {
    const r = await this.pool.query(
      `SELECT * FROM ai_agent WHERE tenant_id = $1 AND seller_id = $2 AND id = $3::uuid`,
      [tenantId, sellerId, id],
    );
    return r.rows[0] || null;
  }

  async createAgent({ tenantId, sellerId, name, persona, language, dailyLimit, cooldownHours, quietStart, quietEnd, tzOffsetMinutes, difyBaseUrl, difyAppKey, model }) {
    const r = await this.pool.query(
      `INSERT INTO ai_agent (tenant_id, seller_id, name, persona, language, daily_limit, cooldown_hours,
                             quiet_start, quiet_end, tz_offset_minutes, dify_base_url, dify_app_key, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, name, persona, language, daily_limit, cooldown_hours, quiet_start, quiet_end,
                 tz_offset_minutes, status, dify_base_url, model, (dify_app_key <> '') AS has_key`,
      [tenantId, sellerId, name, persona || '', language || 'en', dailyLimit || 20,
        Number.isFinite(Number(cooldownHours)) ? Number(cooldownHours) : 24,
        quietStart || '23:00', quietEnd || '07:00',
        Number.isFinite(Number(tzOffsetMinutes)) ? Number(tzOffsetMinutes) : 480,
        difyBaseUrl || '', difyAppKey || '', model || ''],
    );
    return r.rows[0];
  }

  async updateAgent({ tenantId, id, patch }) {
    const p = patch || {};
    const r = await this.pool.query(
      `UPDATE ai_agent SET
         name = COALESCE($3, name),
         persona = COALESCE($4, persona),
         daily_limit = COALESCE($5, daily_limit),
         status = COALESCE($6, status),
         dify_base_url = COALESCE($7, dify_base_url),
         dify_app_key = COALESCE($8, dify_app_key),
         cooldown_hours = COALESCE($9, cooldown_hours),
         quiet_start = COALESCE($10, quiet_start),
         quiet_end = COALESCE($11, quiet_end),
         tz_offset_minutes = COALESCE($12, tz_offset_minutes),
         language = COALESCE($13, language),
         model = COALESCE($14, model),
         updated_at = now()
       WHERE tenant_id = $1 AND id = $2::uuid
       RETURNING id, name, persona, language, daily_limit, cooldown_hours, quiet_start, quiet_end,
                 tz_offset_minutes, status, dify_base_url, model, (dify_app_key <> '') AS has_key`,
      [tenantId, id, p.name === undefined ? null : p.name, p.persona === undefined ? null : p.persona,
        p.dailyLimit === undefined ? null : Number(p.dailyLimit), p.status || null,
        p.difyBaseUrl === undefined ? null : p.difyBaseUrl,
        p.difyAppKey === undefined ? null : p.difyAppKey,
        Number.isFinite(Number(p.cooldownHours)) ? Number(p.cooldownHours) : null,
        p.quietStart === undefined ? null : p.quietStart,
        p.quietEnd === undefined ? null : p.quietEnd,
        Number.isFinite(Number(p.tzOffsetMinutes)) ? Number(p.tzOffsetMinutes) : null,
        p.language === undefined ? null : p.language,
        p.model === undefined ? null : p.model],
    );
    return r.rows[0] || null;
  }

  async deleteAgent(tenantId, id) {
    const r = await this.pool.query('DELETE FROM ai_agent WHERE tenant_id = $1 AND id = $2::uuid RETURNING name', [tenantId, id]);
    return r.rows[0] || null;
  }

  // ---------------- 店铺停机开关 / 不联系名单 ----------------

  async getSellerControl(tenantId, sellerId) {
    const r = await this.pool.query(
      `SELECT tenant_id, seller_id, send_paused, pause_reason, paused_at, updated_by, updated_at
       FROM seller_control WHERE tenant_id = $1 AND seller_id = $2`,
      [tenantId, sellerId],
    );
    return r.rows[0] || {
      tenant_id: tenantId, seller_id: sellerId, send_paused: false,
      pause_reason: '', paused_at: null, updated_by: '', updated_at: null,
    };
  }

  async setSellerControl({ tenantId, sellerId, paused, reason, actorId }) {
    const r = await this.pool.query(
      `INSERT INTO seller_control (tenant_id, seller_id, send_paused, pause_reason, paused_at, updated_by)
       VALUES ($1, $2, $3, $4, CASE WHEN $3 THEN now() ELSE NULL END, $5)
       ON CONFLICT (tenant_id, seller_id) DO UPDATE SET
         send_paused = EXCLUDED.send_paused,
         pause_reason = EXCLUDED.pause_reason,
         paused_at = EXCLUDED.paused_at,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING tenant_id, seller_id, send_paused, pause_reason, paused_at, updated_by, updated_at`,
      [tenantId, sellerId, !!paused, paused ? String(reason || '').slice(0, 200) : '',
        String(actorId || '').slice(0, 200)],
    );
    return r.rows[0];
  }

  async listDnc(tenantId, sellerId, options) {
    const opts = options || {};
    const activeOnly = opts.activeOnly !== false;
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
    const r = await this.pool.query(
      `SELECT tenant_id, seller_id, customer_key, reason, until, created_at, updated_at,
              (until IS NULL OR until > now()) AS active
       FROM do_not_contact
       WHERE tenant_id = $1 AND seller_id = $2 AND ($3 = false OR until IS NULL OR until > now())
       ORDER BY updated_at DESC LIMIT $4`,
      [tenantId, sellerId, activeOnly, limit],
    );
    return r.rows;
  }

  async getDnc(tenantId, sellerId, customerKey) {
    const key = String(customerKey === undefined || customerKey === null ? '' : customerKey).trim();
    if (!key) return null;
    const r = await this.pool.query(
      `SELECT tenant_id, seller_id, customer_key, reason, until, created_at, updated_at
       FROM do_not_contact
       WHERE tenant_id = $1 AND seller_id = $2
         AND (customer_key = $3 OR customer_key = regexp_replace($3, '^inquiry:', '')
              OR ('inquiry:' || customer_key) = $3)
         AND (until IS NULL OR until > now())
       ORDER BY updated_at DESC LIMIT 1`,
      [tenantId, sellerId, key],
    );
    return r.rows[0] || null;
  }

  async upsertDnc({ tenantId, sellerId, customerKey, reason, until }) {
    const r = await this.pool.query(
      `INSERT INTO do_not_contact (tenant_id, seller_id, customer_key, reason, until)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, seller_id, customer_key) DO UPDATE SET
         reason = EXCLUDED.reason, until = EXCLUDED.until, updated_at = now()
       RETURNING tenant_id, seller_id, customer_key, reason, until, created_at, updated_at`,
      [tenantId, sellerId, customerKey, String(reason || '').slice(0, 200), until || null],
    );
    return r.rows[0];
  }

  async deleteDnc(tenantId, sellerId, customerKey) {
    const key = String(customerKey === undefined || customerKey === null ? '' : customerKey).trim();
    if (!key) return false;
    const r = await this.pool.query(
      `DELETE FROM do_not_contact
       WHERE tenant_id = $1 AND seller_id = $2
         AND (customer_key = $3 OR customer_key = regexp_replace($3, '^inquiry:', '')
              OR ('inquiry:' || customer_key) = $3)`,
      [tenantId, sellerId, key],
    );
    return r.rowCount > 0;
  }

  async assignCustomers({ tenantId, sellerId, agentId, filter, limit }) {
    const f = filter || {};
    const params = [tenantId, sellerId, agentId];
    const where = ["c.seller_id = $2", "c.kind = 'inquiry'"];
    if (f.country) { params.push(String(f.country)); where.push("c.payload->>'国家' = $" + params.length); }
    if (f.source) { params.push('%' + String(f.source) + '%'); where.push("coalesce(c.payload->>'来源','') ILIKE $" + params.length); }
    if (f.replied) { params.push(String(f.replied)); where.push("coalesce(c.payload->>'回复状态','') = $" + params.length); }
    if (f.grade) {
      params.push(String(f.grade).toUpperCase());
      const i = params.length;
      where.push("(upper(coalesce(c.payload->>'买家等级','')) = $" + i + " OR upper(coalesce(c.payload->>'买家等级(字母)','')) = $" + i + ')');
    }
    params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
    const r = await this.pool.query(
      `INSERT INTO customer_owner (tenant_id, seller_id, customer_key, agent_id, source)
       SELECT $1, $2, c.platform_id, $3::uuid, 'rule'
       FROM current_record c
       WHERE ${where.join(' AND ')}
         AND NOT EXISTS (
           SELECT 1 FROM do_not_contact d
           WHERE d.tenant_id = $1 AND d.seller_id = $2 AND d.customer_key = c.platform_id
             AND (d.until IS NULL OR d.until > now()))
       ORDER BY c.business_at DESC NULLS LAST
       LIMIT $${params.length}
       ON CONFLICT (tenant_id, seller_id, customer_key)
       DO UPDATE SET agent_id = EXCLUDED.agent_id, assigned_at = now()
       RETURNING customer_key`,
      params,
    );
    return r.rowCount;
  }

  async listAssignments(agentId, limit) {
    const r = await this.pool.query(
      `SELECT o.customer_key, o.assigned_at,
              c.payload->>'客户名称' AS customer_name, c.payload->>'国家' AS country,
              c.payload->>'询盘主题' AS subject, c.payload->>'回复状态' AS replied
       FROM customer_owner o
       LEFT JOIN current_record c
         ON c.seller_id = o.seller_id AND c.kind = 'inquiry' AND c.platform_id = o.customer_key
       WHERE o.agent_id = $1::uuid
       ORDER BY o.assigned_at DESC LIMIT $2`,
      [agentId, Math.min(500, Number(limit) || 100)],
    );
    return r.rows;
  }

  async unassignAll(agentId) {
    const r = await this.pool.query('DELETE FROM customer_owner WHERE agent_id = $1::uuid', [agentId]);
    return r.rowCount;
  }

  async createPlaybook({ tenantId, sellerId, name, kind, steps }) {
    const r = await this.pool.query(
      `INSERT INTO playbook (tenant_id, seller_id, name, kind, steps) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, kind, version, status, created_at`,
      [tenantId, sellerId, name, kind, steps || []],
    );
    return r.rows[0];
  }

  async listPlaybooks(sellerId) {
    const r = await this.pool.query(
      `SELECT id, name, kind, version, status, created_at FROM playbook WHERE seller_id = $1 ORDER BY created_at DESC`,
      [sellerId],
    );
    return r.rows;
  }

  async createTask({ tenantId, sellerId, agentId, playbookId, name, dailyLimit }) {
    const r = await this.pool.query(
      `INSERT INTO ai_task (tenant_id, seller_id, agent_id, playbook_id, name, daily_limit)
       VALUES ($1,$2,$3::uuid,$4::uuid,$5,$6) RETURNING *`,
      [tenantId, sellerId, agentId, playbookId || null, name, dailyLimit || 20],
    );
    return r.rows[0];
  }

  async generateTaskItems({ taskId, tenantId, sellerId, agentId, playbookVersion }) {
    const r = await this.pool.query(
      `INSERT INTO task_item (task_id, tenant_id, seller_id, agent_id, customer_key, idempotency_key)
       SELECT $1::uuid, $2, $3, $4::uuid, o.customer_key,
              $1::text || ':' || o.customer_key || ':v' || $5::int
       FROM customer_owner o
       WHERE o.agent_id = $4::uuid AND o.tenant_id = $2 AND o.seller_id = $3
         AND NOT EXISTS (
           SELECT 1 FROM do_not_contact d
           WHERE d.tenant_id = $2 AND d.seller_id = $3 AND d.customer_key = o.customer_key
             AND (d.until IS NULL OR d.until > now()))
         AND NOT EXISTS (SELECT 1 FROM task_item t WHERE t.task_id = $1::uuid AND t.customer_key = o.customer_key)
       ON CONFLICT (task_id, customer_key) DO NOTHING
       RETURNING id`,
      [taskId, tenantId, sellerId, agentId, Number(playbookVersion) || 1],
    );
    return r.rowCount;
  }

  async listTasks(sellerId) {
    const r = await this.pool.query(
      `SELECT t.id, t.name, t.status, t.daily_limit, t.created_at, a.name AS agent_name,
              (SELECT count(*) FROM task_item i WHERE i.task_id = t.id)::int AS items,
              (SELECT count(*) FROM task_item i WHERE i.task_id = t.id AND i.state = 'drafted')::int AS drafted
       FROM ai_task t LEFT JOIN ai_agent a ON a.id = t.agent_id
       WHERE t.seller_id = $1 ORDER BY t.created_at DESC LIMIT 100`,
      [sellerId],
    );
    return r.rows;
  }

  async listTaskItems(taskId, limit) {
    const r = await this.pool.query(
      `SELECT i.id, i.customer_key, i.state, i.attempts, i.draft_text, i.last_error, i.created_at, i.updated_at,
              c.payload->>'客户名称' AS customer_name, c.payload->>'国家' AS country,
              c.payload->>'询盘主题' AS subject, c.payload->>'回复状态' AS replied
       FROM task_item i
       LEFT JOIN current_record c
         ON c.seller_id = i.seller_id AND c.kind = 'inquiry' AND c.platform_id = i.customer_key
       WHERE i.task_id = $1::uuid ORDER BY i.created_at DESC LIMIT $2`,
      [taskId, Math.min(500, Number(limit) || 100)],
    );
    return r.rows;
  }

  async getTaskItem(id) {
    const r = await this.pool.query(
      `SELECT i.*, c.payload AS payload FROM task_item i
       LEFT JOIN current_record c
         ON c.seller_id = i.seller_id AND c.kind = 'inquiry' AND c.platform_id = i.customer_key
       WHERE i.id = $1::uuid`,
      [id],
    );
    return r.rows[0] || null;
  }

  async updateTaskItem(id, patch) {
    const p = patch || {};
    const r = await this.pool.query(
      `UPDATE task_item SET
         state = COALESCE($2, state),
         draft_text = COALESCE($3, draft_text),
         last_error = COALESCE($4, last_error),
         attempts = attempts + CASE WHEN $5::boolean THEN 1 ELSE 0 END,
         updated_at = now()
       WHERE id = $1::uuid RETURNING id, state, draft_text, last_error`,
      [id, p.state || null, p.draftText === undefined ? null : p.draftText,
        p.lastError === undefined ? null : p.lastError, Boolean(p.countAttempt)],
    );
    return r.rows[0] || null;
  }

  async saveAiRun(run) {
    const r = await this.pool.query(
      `INSERT INTO ai_run (tenant_id, seller_id, agent_id, task_item_id, prompt_version, knowledge_version,
                           model, tokens, latency_ms, citations, output, state, error, risk)
       VALUES ($1,$2,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, created_at`,
      [run.tenantId, run.sellerId, run.agentId || null, run.taskItemId || null,
        run.promptVersion || 'v1', run.knowledgeVersion || '', run.model || '',
        Number(run.tokens) || 0, Number(run.latencyMs) || 0, JSON.stringify(run.citations || []),
        String(run.output || '').slice(0, 8000), run.state || 'ok', String(run.error || '').slice(0, 500),
        JSON.stringify(run.risk || [])],
    );
    return r.rows[0];
  }

  async listRunsByItem(itemId, limit) {
    const r = await this.pool.query(
      `SELECT id, model, tokens, latency_ms, citations, risk, output, state, error, created_at
       FROM ai_run WHERE task_item_id = $1::uuid ORDER BY created_at DESC LIMIT $2`,
      [itemId, Math.min(20, Number(limit) || 5)],
    );
    return r.rows;
  }

  // AI 智能体总览：配置、任务项、人工队列与运行统计
  async aiOverview(tenantId, sellerId, since) {
    const [counts, draftRuns, chatRuns] = await Promise.all([
      this.pool.query(
        `SELECT
           (SELECT count(*) FROM ai_agent WHERE tenant_id=$1 AND seller_id=$2)::int AS agents_total,
           (SELECT count(*) FROM ai_agent WHERE tenant_id=$1 AND seller_id=$2 AND status='active')::int AS agents_active,
           (SELECT count(*) FROM ai_task WHERE tenant_id=$1 AND seller_id=$2)::int AS tasks_total,
           (SELECT count(*) FROM ai_task WHERE tenant_id=$1 AND seller_id=$2 AND status='active')::int AS tasks_active,
           (SELECT count(*) FROM task_item WHERE tenant_id=$1 AND seller_id=$2)::int AS items_total,
           (SELECT count(*) FROM task_item WHERE tenant_id=$1 AND seller_id=$2 AND state='pending')::int AS items_pending,
           (SELECT count(*) FROM task_item WHERE tenant_id=$1 AND seller_id=$2 AND state='drafted')::int AS items_drafted,
           (SELECT count(*) FROM task_item WHERE tenant_id=$1 AND seller_id=$2 AND state='review_required')::int AS items_review,
           (SELECT count(*) FROM task_item WHERE tenant_id=$1 AND seller_id=$2 AND state='approved')::int AS items_approved,
           (SELECT count(*) FROM task_item WHERE tenant_id=$1 AND seller_id=$2 AND state='sent')::int AS items_sent,
           (SELECT count(*) FROM task_item WHERE tenant_id=$1 AND seller_id=$2 AND state='cancelled')::int AS items_cancelled,
           (SELECT count(*) FROM task_item WHERE tenant_id=$1 AND seller_id=$2 AND state='failed')::int AS items_failed,
           (SELECT count(*) FROM agent_escalation WHERE tenant_id=$1 AND seller_id=$2 AND status='open')::int AS escalations_open,
           (SELECT count(*) FROM assignment_suggestion WHERE tenant_id=$1 AND seller_id=$2 AND status='pending')::int AS suggestions_pending`,
        [tenantId, sellerId],
      ),
      this.pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE state <> 'ok')::int AS errors,
                coalesce(round(avg(latency_ms)), 0)::int AS avg_ms,
                coalesce(sum(tokens), 0)::int AS tokens
         FROM ai_run WHERE tenant_id=$1 AND seller_id=$2 AND created_at >= $3`,
        [tenantId, sellerId, since],
      ),
      this.pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE r.state <> 'ok')::int AS errors,
                coalesce(round(avg(r.latency_ms)), 0)::int AS avg_ms
         FROM agent_run r JOIN agent_thread t ON t.id = r.thread_id
         WHERE t.tenant_id=$1 AND t.seller_id=$2 AND r.created_at >= $3`,
        [tenantId, sellerId, since],
      ),
    ]);
    const row = counts.rows[0] || {};
    const draft = draftRuns.rows[0] || {};
    const chat = chatRuns.rows[0] || {};
    return {
      agents: { total: row.agents_total || 0, active: row.agents_active || 0 },
      tasks: { total: row.tasks_total || 0, active: row.tasks_active || 0 },
      items: {
        total: row.items_total || 0, pending: row.items_pending || 0,
        drafted: row.items_drafted || 0, review_required: row.items_review || 0,
        approved: row.items_approved || 0, sent: row.items_sent || 0,
        cancelled: row.items_cancelled || 0, failed: row.items_failed || 0,
      },
      escalations: { open: row.escalations_open || 0 },
      suggestions: { pending: row.suggestions_pending || 0 },
      runs: {
        draft: {
          total: draft.total || 0, errors: draft.errors || 0,
          avg_ms: draft.avg_ms || 0, tokens: draft.tokens || 0,
        },
        chat: { total: chat.total || 0, errors: chat.errors || 0, avg_ms: chat.avg_ms || 0 },
      },
    };
  }

  // 运行审计：草稿生成（ai_run）与会话回合（agent_run）统一列表
  async listAiRuns({ tenantId, sellerId, kind, state, agentId, limit }) {
    const kinds = String(kind || '');
    const states = String(state || '');
    const agent = String(agentId || '');
    const cap = Math.min(500, Math.max(1, Number(limit) || 100));
    const r = await this.pool.query(
      `SELECT * FROM (
         SELECT 'draft'::text AS kind, r.id::text AS id, r.agent_id, a.name AS agent_name,
                r.task_item_id::text AS ref_id, r.state, r.model, r.tokens, r.latency_ms,
                left(r.output, 300) AS output, r.error, r.created_at
         FROM ai_run r LEFT JOIN ai_agent a ON a.id = r.agent_id
         WHERE r.tenant_id = $1 AND r.seller_id = $2
         UNION ALL
         SELECT 'chat', r.id::text, r.agent_id, a.name,
                r.thread_id::text, r.state, r.model, 0, r.latency_ms,
                left(r.output, 300), r.error, r.created_at
         FROM agent_run r
         JOIN agent_thread t ON t.id = r.thread_id
         LEFT JOIN ai_agent a ON a.id = r.agent_id
         WHERE t.tenant_id = $1 AND t.seller_id = $2
       ) x
       WHERE ($3 = '' OR kind = $3)
         AND ($4 = '' OR state = $4)
         AND ($5 = '' OR agent_id::text = $5)
       ORDER BY created_at DESC LIMIT $6`,
      [tenantId, sellerId, kinds, states, agent, cap],
    );
    return r.rows;
  }

  // 待人工介入队列：草稿已生成（含守门命中）
  async reviewQueue(sellerId, limit) {
    const r = await this.pool.query(
      `SELECT i.id, i.customer_key, i.state, i.draft_text, i.last_error, i.updated_at,
              c.payload->>'客户名称' AS customer_name, c.payload->>'国家' AS country,
              c.payload->>'询盘主题' AS subject, c.payload->>'回复状态' AS replied,
              r.risk, r.citations, r.created_at AS drafted_at
       FROM task_item i
       LEFT JOIN current_record c
         ON c.seller_id = i.seller_id AND c.kind = 'inquiry' AND c.platform_id = i.customer_key
       LEFT JOIN LATERAL (
         SELECT risk, citations, created_at FROM ai_run
         WHERE task_item_id = i.id ORDER BY created_at DESC LIMIT 1
       ) r ON true
       WHERE i.seller_id = $1 AND i.state IN ('drafted', 'review_required')
       ORDER BY CASE WHEN i.state = 'review_required' THEN 0 ELSE 1 END, i.updated_at ASC
       LIMIT $2`,
      [sellerId, Math.min(200, Number(limit) || 50)],
    );
    return r.rows;
  }

  // 运营总览：待人工、草稿、业务员、未回复询盘
  async opsCounts(sellerId) {
    const r = await this.pool.query(
      `SELECT
         (SELECT count(*) FROM task_item WHERE seller_id = $1 AND state = 'review_required')::int AS need_review,
         (SELECT count(*) FROM task_item WHERE seller_id = $1 AND state = 'drafted')::int AS drafted,
         (SELECT count(*) FROM task_item WHERE seller_id = $1 AND state = 'approved')::int AS approved,
         (SELECT count(*) FROM ai_agent WHERE seller_id = $1 AND status = 'active')::int AS agents,
         (SELECT count(*) FROM ai_task WHERE seller_id = $1 AND status = 'active')::int AS tasks,
         (SELECT count(*) FROM current_record
          WHERE seller_id = $1 AND kind = 'inquiry'
            AND coalesce(payload->>'回复状态', '') NOT IN ('已回复', '1'))::int AS unreplied`,
      [sellerId],
    );
    return r.rows[0];
  }

  // ---------------- 智能体会话运行时 ----------------

  async getOrCreateThread({ tenantId, sellerId, agentId, customerKey, channel, subject }) {
    const ch = channel || 'inquiry';
    const found = await this.pool.query(
      'SELECT * FROM agent_thread WHERE agent_id = $1::uuid AND customer_key = $2 AND channel = $3',
      [agentId, customerKey, ch],
    );
    if (found.rowCount) return found.rows[0];
    const ins = await this.pool.query(
      `INSERT INTO agent_thread (tenant_id, seller_id, agent_id, customer_key, channel, subject)
       VALUES ($1,$2,$3::uuid,$4,$5,$6)
       ON CONFLICT (agent_id, customer_key, channel) DO UPDATE
         SET subject = CASE WHEN EXCLUDED.subject <> '' THEN EXCLUDED.subject ELSE agent_thread.subject END
       RETURNING *`,
      [tenantId, sellerId, agentId, customerKey, ch, subject || ''],
    );
    return ins.rows[0];
  }

  async getThread(id) {
    const r = await this.pool.query(
      `SELECT t.*, a.name AS agent_name, a.persona, c.payload AS customer
       FROM agent_thread t
       JOIN ai_agent a ON a.id = t.agent_id
       LEFT JOIN current_record c
         ON c.seller_id = t.seller_id AND c.kind = 'inquiry' AND c.platform_id = t.customer_key
       WHERE t.id = $1::uuid`,
      [id],
    );
    return r.rows[0] || null;
  }

  async listThreads(sellerId, status, limit) {
    const st = String(status || '');
    const r = await this.pool.query(
      `SELECT t.id, t.agent_id, t.customer_key, t.subject, t.status, t.last_message_at,
              a.name AS agent_name, m.content AS last_message, m.role AS last_role
       FROM agent_thread t
       JOIN ai_agent a ON a.id = t.agent_id
       LEFT JOIN LATERAL (
         SELECT content, role FROM agent_message WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1
       ) m ON true
       WHERE t.seller_id = $1 AND ($2 = '' OR t.status = $2)
       ORDER BY t.last_message_at DESC LIMIT $3`,
      [sellerId, st, Math.min(100, Number(limit) || 30)],
    );
    return r.rows;
  }

  async updateThread(id, patch) {
    const p = patch || {};
    const r = await this.pool.query(
      `UPDATE agent_thread SET status = COALESCE($2, status) WHERE id = $1::uuid RETURNING id, status`,
      [id, p.status || null],
    );
    return r.rows[0] || null;
  }

  async appendMessage({ threadId, role, content, state, meta }) {
    const r = await this.pool.query(
      `INSERT INTO agent_message (thread_id, role, content, state, meta)
       VALUES ($1::uuid,$2,$3,$4,$5) RETURNING id, created_at`,
      [threadId, role, content, state || 'ok', JSON.stringify(meta || {})],
    );
    await this.pool.query('UPDATE agent_thread SET last_message_at = now() WHERE id = $1::uuid', [threadId]);
    return r.rows[0];
  }

  async listMessages(threadId, limit) {
    const r = await this.pool.query(
      `SELECT id, role, content, state, meta, created_at FROM agent_message
       WHERE thread_id = $1::uuid ORDER BY created_at ASC, id ASC LIMIT $2`,
      [threadId, Math.min(200, Number(limit) || 50)],
    );
    return r.rows;
  }

  async createAgentRun({ threadId, agentId, trigger, input }) {
    const r = await this.pool.query(
      `INSERT INTO agent_run (thread_id, agent_id, trigger, state, input)
       VALUES ($1::uuid,$2::uuid,$3,'running',$4) RETURNING id, created_at`,
      [threadId, agentId, trigger || 'message', JSON.stringify(input || {})],
    );
    return r.rows[0];
  }

  async finishAgentRun(id, patch) {
    const p = patch || {};
    await this.pool.query(
      `UPDATE agent_run SET
         state = COALESCE($2, state),
         output = COALESCE($3, output),
         model = COALESCE($4, model),
         latency_ms = COALESCE($5, latency_ms),
         guard = COALESCE($6::jsonb, guard),
         escalation_id = COALESCE($7::uuid, escalation_id),
         error = COALESCE($8, error)
       WHERE id = $1`,
      [id, p.state || null, p.output === undefined ? null : p.output, p.model || null,
        Number.isFinite(p.latencyMs) ? p.latencyMs : null,
        p.guard ? JSON.stringify(p.guard) : null, p.escalationId || null,
        p.error === undefined ? null : p.error],
    );
  }

  async createEscalation({ tenantId, sellerId, threadId, runId, reasonCode, reason, question }) {
    const r = await this.pool.query(
      `INSERT INTO agent_escalation (tenant_id, seller_id, thread_id, run_id, reason_code, reason, question)
       VALUES ($1,$2,$3::uuid,$4,$5,$6,$7) RETURNING *`,
      [tenantId, sellerId, threadId, runId || null, reasonCode || 'guard', reason || '', JSON.stringify(question || {})],
    );
    return r.rows[0];
  }

  // 云端数据集：供扩展仪表盘直接读取（替代本地 IndexedDB 作为主数据源）
  async rowsByKindAll(sellerId, kinds, perKindLimit) {
    const list = kinds || [];
    if (!list.length) return [];
    const cap = Math.min(30000, Number(perKindLimit) || 30000);
    const r = await this.pool.query(
      `SELECT kind, payload, updated_at FROM (
         SELECT kind, payload, updated_at,
                row_number() OVER (PARTITION BY kind ORDER BY updated_at DESC) AS rn
         FROM current_record
         WHERE seller_id = $1 AND kind = ANY($2::text[])
       ) t WHERE rn <= $3`,
      [sellerId, list, cap],
    );
    return r.rows;
  }

  // ---------------- 云端采集登录态 ----------------

  async saveCollectorState({ tenantId, sellerId, cookies }) {
    await this.pool.query(
      `INSERT INTO collector_state (tenant_id, seller_id, cookies, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (tenant_id, seller_id) DO UPDATE SET cookies = EXCLUDED.cookies, updated_at = now()`,
      [tenantId, sellerId, cookies || ''],
    );
  }

  async getCollectorState(tenantId, sellerId) {
    const r = await this.pool.query(
      'SELECT cookies, updated_at FROM collector_state WHERE tenant_id = $1 AND seller_id = $2',
      [tenantId, sellerId],
    );
    return r.rows[0] || null;
  }

  async listCollectorStates(tenantId) {
    const r = await this.pool.query(
      'SELECT seller_id, updated_at FROM collector_state WHERE tenant_id = $1 ORDER BY seller_id',
      [tenantId],
    );
    return r.rows;
  }

  // ---------------- 扩展心跳与数据对账 ----------------

  async upsertHeartbeat({ tenantId, sellerId, clientId, version, queueRows, counts, lastUploadAt }) {
    await this.pool.query(
      `INSERT INTO client_heartbeat (tenant_id, seller_id, client_id, version, queue_rows, counts, last_upload_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (tenant_id, seller_id, client_id) DO UPDATE
         SET version = EXCLUDED.version,
             queue_rows = EXCLUDED.queue_rows,
             counts = EXCLUDED.counts,
             last_upload_at = COALESCE(EXCLUDED.last_upload_at, client_heartbeat.last_upload_at),
             updated_at = now()`,
      [tenantId, sellerId, clientId, version || '', Number(queueRows) || 0,
        JSON.stringify(counts || {}), lastUploadAt || null],
    );
  }

  async listHeartbeats(sellerId) {
    const r = await this.pool.query(
      `SELECT client_id, version, queue_rows, counts, last_upload_at, updated_at
       FROM client_heartbeat WHERE seller_id = $1 ORDER BY updated_at DESC LIMIT 20`,
      [sellerId],
    );
    return r.rows;
  }

  async countsByKind(sellerId) {
    const r = await this.pool.query(
      `SELECT kind, count(*)::int AS rows FROM current_record WHERE seller_id = $1 GROUP BY kind`,
      [sellerId],
    );
    const out = {};
    r.rows.forEach((x) => { out[x.kind] = x.rows; });
    return out;
  }

  // ---------------- 执行队列（扩展侧执行） ----------------

  async listExecutions(sellerId, limit) {
    const r = await this.pool.query(
      `SELECT i.id, i.customer_key, i.draft_text, i.state, i.updated_at, i.agent_id, i.attempts,
              i.claimed_by, i.claimed_at, i.sent_at, i.next_at,
              a.name AS agent_name, a.daily_limit, a.cooldown_hours, a.quiet_start, a.quiet_end,
              a.status AS agent_status, a.tz_offset_minutes,
              c.payload->>'客户名称' AS customer_name, c.payload->>'国家' AS country,
              c.payload->>'询盘主题' AS subject, c.payload->>'询盘ID' AS inquiry_id,
              (d.customer_key IS NOT NULL) AS dnc_active, d.reason AS dnc_reason
       FROM task_item i
       JOIN ai_agent a ON a.id = i.agent_id
       LEFT JOIN current_record c
         ON c.seller_id = i.seller_id AND c.kind = 'inquiry' AND c.platform_id = i.customer_key
       LEFT JOIN LATERAL (
         SELECT dn.customer_key, dn.reason
         FROM do_not_contact dn
         WHERE dn.tenant_id = i.tenant_id AND dn.seller_id = i.seller_id
           AND (dn.customer_key = i.customer_key
             OR dn.customer_key = regexp_replace(i.customer_key, '^inquiry:', '')
             OR ('inquiry:' || dn.customer_key) = i.customer_key)
           AND (dn.until IS NULL OR dn.until > now())
         ORDER BY dn.updated_at DESC LIMIT 1
       ) d ON true
       WHERE i.seller_id = $1 AND i.state = 'approved' AND btrim(i.draft_text) <> ''
       ORDER BY i.updated_at ASC LIMIT $2`,
      [sellerId, Math.min(100, Number(limit) || 30)],
    );
    return r.rows;
  }

  // 发送统计：按业务员统计店铺本地当天已成功发送数，并按客户取最近一次成功发送时间
  async executionStats(sellerId, sinceIso) {
    const [byAgent, byCustomer] = await Promise.all([
      this.pool.query(
        `SELECT i.agent_id, count(*)::int AS sent
         FROM message_event e JOIN task_item i ON i.id = e.task_item_id
         WHERE e.seller_id = $1 AND e.direction = 'out' AND e.state = 'sent_confirmed'
           AND e.created_at >= $2
         GROUP BY i.agent_id`,
        [sellerId, sinceIso],
      ),
      this.pool.query(
        `SELECT i.customer_key, max(e.created_at) AS last_at
         FROM message_event e JOIN task_item i ON i.id = e.task_item_id
         WHERE e.seller_id = $1 AND e.direction = 'out' AND e.state = 'sent_confirmed'
         GROUP BY i.customer_key`,
        [sellerId],
      ),
    ]);
    const agents = {};
    byAgent.rows.forEach((x) => { agents[x.agent_id] = x.sent; });
    const customers = {};
    byCustomer.rows.forEach((x) => { customers[x.customer_key] = x.last_at ? new Date(x.last_at).getTime() : null; });
    return { byAgent: agents, byCustomer: customers };
  }

  // 原子领取：只有 approved 才能领取；状态变化时再次复核店铺停机与 DNC
  async claimExecution(id, { clientId, leaseSeconds }) {
    if (!UUID_RE.test(String(id))) return { ok: false, code: 'execution_not_found' };
    const lease = Math.max(60, Math.min(3600, Number(leaseSeconds) || 300));
    const token = require('node:crypto').randomBytes(16).toString('hex');
    const upd = await this.pool.query(
      `UPDATE task_item
         SET state = 'sending', claimed_by = $2, claimed_at = now(), claim_token = $3,
             attempts = attempts + 1, updated_at = now()
       WHERE id = $1::uuid AND state = 'approved'
         AND NOT EXISTS (
           SELECT 1 FROM seller_control c
           WHERE c.tenant_id = task_item.tenant_id AND c.seller_id = task_item.seller_id
             AND c.send_paused)
         AND NOT EXISTS (
           SELECT 1 FROM do_not_contact d
           WHERE d.tenant_id = task_item.tenant_id AND d.seller_id = task_item.seller_id
             AND (d.customer_key = task_item.customer_key
               OR d.customer_key = regexp_replace(task_item.customer_key, '^inquiry:', '')
               OR ('inquiry:' || d.customer_key) = task_item.customer_key)
             AND (d.until IS NULL OR d.until > now()))
       RETURNING id, tenant_id, seller_id, agent_id, customer_key, draft_text, claim_token, claimed_at`,
      [id, String(clientId || '').slice(0, 120), token],
    );
    if (upd.rowCount) {
      return {
        ok: true,
        item: upd.rows[0],
        claim_token: token,
        expires_at: new Date(Date.now() + lease * 1000).toISOString(),
      };
    }
    const cur = await this.pool.query(
      `SELECT id, state, claimed_by, claimed_at FROM task_item WHERE id = $1::uuid`, [id],
    );
    if (!cur.rowCount) return { ok: false, code: 'execution_not_found' };
    const row = cur.rows[0];
    if (row.state === 'sent') return { ok: false, code: 'already_sent' };
    if (row.state === 'approved' || row.state === 'sending') {
      const guard = await this.pool.query(
        `SELECT
           EXISTS (SELECT 1 FROM seller_control c
             WHERE c.tenant_id = i.tenant_id AND c.seller_id = i.seller_id AND c.send_paused) AS store_paused,
           EXISTS (SELECT 1 FROM do_not_contact d
             WHERE d.tenant_id = i.tenant_id AND d.seller_id = i.seller_id
               AND (d.customer_key = i.customer_key
                 OR d.customer_key = regexp_replace(i.customer_key, '^inquiry:', '')
                 OR ('inquiry:' || d.customer_key) = i.customer_key)
               AND (d.until IS NULL OR d.until > now())) AS dnc_blocked
         FROM task_item i WHERE i.id = $1::uuid`, [id],
      );
      const g = guard.rows[0] || {};
      if (g.store_paused) return { ok: false, code: 'store_paused' };
      if (g.dnc_blocked) return { ok: false, code: 'dnc_blocked' };
    }
    if (row.state === 'sending') {
      const age = row.claimed_at ? (Date.now() - new Date(row.claimed_at).getTime()) / 1000 : 0;
      if (age < lease) {
        return { ok: false, code: 'claimed_by_other', claimed_by: row.claimed_by, retry_after_seconds: Math.ceil(lease - age) };
      }
      // 租约过期：允许抢占，避免客户端崩溃后任务永远卡住
      const steal = await this.pool.query(
        `UPDATE task_item SET claimed_by = $2, claimed_at = now(), claim_token = $3, attempts = attempts + 1, updated_at = now()
         WHERE id = $1::uuid AND state = 'sending'
           AND NOT EXISTS (
             SELECT 1 FROM seller_control c
             WHERE c.tenant_id = task_item.tenant_id AND c.seller_id = task_item.seller_id
               AND c.send_paused)
           AND NOT EXISTS (
             SELECT 1 FROM do_not_contact d
             WHERE d.tenant_id = task_item.tenant_id AND d.seller_id = task_item.seller_id
               AND (d.customer_key = task_item.customer_key
                 OR d.customer_key = regexp_replace(task_item.customer_key, '^inquiry:', '')
                 OR ('inquiry:' || d.customer_key) = task_item.customer_key)
               AND (d.until IS NULL OR d.until > now()))
         RETURNING id, tenant_id, seller_id, agent_id, customer_key, draft_text, claim_token, claimed_at`,
        [id, String(clientId || '').slice(0, 120), token],
      );
      if (steal.rowCount) {
        return {
          ok: true,
          item: steal.rows[0],
          claim_token: token,
          expires_at: new Date(Date.now() + lease * 1000).toISOString(),
        };
      }
    }
    return { ok: false, code: 'not_claimable', state: row.state };
  }

  // 回写结果：sent 计成功，failed 可重试，uncertain 待人工核实；同一项重复回写按幂等处理
  async markExecution(id, patch) {
    const p = patch || {};
    const status = p.status === 'sent' ? 'sent' : (p.status === 'uncertain' ? 'uncertain' : 'failed');
    const state = status;
    const eventState = status === 'sent' ? 'sent_confirmed' : (status === 'uncertain' ? 'send_uncertain' : 'send_failed');
    if (!UUID_RE.test(String(id))) return null;
    const item = await this.pool.query(
      `UPDATE task_item SET
         state = $2,
         last_error = COALESCE($3, last_error),
         platform_msg_id = COALESCE($4, platform_msg_id),
         sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
         claimed_by = '', claim_token = '', updated_at = now()
       WHERE id = $1::uuid AND state IN ('approved', 'sending')
       RETURNING id, tenant_id, seller_id, customer_key, draft_text, state`,
      [id, state, p.note === undefined ? null : String(p.note).slice(0, 300), p.platformMsgId || null],
    );
    if (!item.rowCount) {
      const cur = await this.pool.query(
        'SELECT id, tenant_id, seller_id, customer_key, draft_text, state FROM task_item WHERE id = $1::uuid', [id],
      );
      if (!cur.rowCount) return null;
      const row = cur.rows[0];
      // 已按同一状态落库：视为幂等成功；状态不同则冲突，避免把已成功改判为失败
      if (row.state === state) return Object.assign({ idempotent: true }, row);
      return Object.assign({ conflict: true, current: row.state }, row);
    }
    const row = item.rows[0];
    await this.pool.query(
      `INSERT INTO message_event (task_item_id, tenant_id, seller_id, direction, content, platform_msg_id, state)
       VALUES ($1::uuid,$2,$3,'out',$4,$5,$6)`,
      [row.id, row.tenant_id, row.seller_id, row.draft_text || '', p.platformMsgId || null, eventState],
    );
    return row;
  }

  async listEscalations(sellerId, status, limit) {
    const st = String(status || '');
    const r = await this.pool.query(
      `SELECT e.*, t.customer_key, t.subject, t.agent_id, a.name AS agent_name,
              c.payload->>'客户名称' AS customer_name, c.payload->>'国家' AS country
       FROM agent_escalation e
       JOIN agent_thread t ON t.id = e.thread_id
       JOIN ai_agent a ON a.id = t.agent_id
       LEFT JOIN current_record c
         ON c.seller_id = e.seller_id AND c.kind = 'inquiry' AND c.platform_id = t.customer_key
       WHERE e.seller_id = $1 AND ($2 = '' OR e.status = $2)
       ORDER BY e.created_at DESC LIMIT $3`,
      [sellerId, st, Math.min(100, Number(limit) || 30)],
    );
    return r.rows;
  }

  async getEscalation(id) {
    const r = await this.pool.query('SELECT * FROM agent_escalation WHERE id = $1::uuid', [id]);
    return r.rows[0] || null;
  }

  async resolveEscalation(id, { resolution, resolvedBy }) {
    const r = await this.pool.query(
      `UPDATE agent_escalation SET status = 'resolved', resolution = $2, resolved_by = $3::uuid, resolved_at = now()
       WHERE id = $1::uuid RETURNING *`,
      [id, resolution || '', resolvedBy || null],
    );
    return r.rows[0] || null;
  }

  // ---------------- 客户分配建议 ----------------

  async unassignedInquiries(sellerId, limit) {
    const r = await this.pool.query(
      `SELECT c.platform_id, c.payload, c.business_at
       FROM current_record c
       WHERE c.seller_id = $1 AND c.kind = 'inquiry'
         AND NOT EXISTS (SELECT 1 FROM customer_owner o
           WHERE o.seller_id = c.seller_id AND o.customer_key = c.platform_id)
         AND NOT EXISTS (SELECT 1 FROM do_not_contact d
           WHERE d.seller_id = c.seller_id AND d.customer_key = c.platform_id
             AND (d.until IS NULL OR d.until > now()))
       ORDER BY c.business_at DESC NULLS LAST
       LIMIT $2`,
      [sellerId, Math.min(300, Number(limit) || 50)],
    );
    return r.rows;
  }

  async upsertSuggestions({ tenantId, sellerId, agentId, items, createdBy }) {
    let created = 0;
    for (const item of items || []) {
      const r = await this.pool.query(
        `INSERT INTO assignment_suggestion (tenant_id, seller_id, agent_id, customer_key, score, reason, created_by)
         VALUES ($1,$2,$3::uuid,$4,$5,$6,$7)
         ON CONFLICT (agent_id, customer_key) DO NOTHING
         RETURNING id`,
        [tenantId, sellerId, agentId, item.customerKey, item.score, item.reason, createdBy || 'agent'],
      );
      if (r.rowCount) created += 1;
    }
    return created;
  }

  async listSuggestions(sellerId, status, limit) {
    const st = String(status || 'pending');
    const r = await this.pool.query(
      `SELECT s.*, a.name AS agent_name,
              c.payload->>'客户名称' AS customer_name, c.payload->>'国家' AS country,
              c.payload->>'询盘主题' AS subject
       FROM assignment_suggestion s
       JOIN ai_agent a ON a.id = s.agent_id
       LEFT JOIN current_record c
         ON c.seller_id = s.seller_id AND c.kind = 'inquiry' AND c.platform_id = s.customer_key
       WHERE s.seller_id = $1 AND ($2 = '' OR s.status = $2)
       ORDER BY s.score DESC, s.created_at DESC LIMIT $3`,
      [sellerId, st, Math.min(200, Number(limit) || 50)],
    );
    return r.rows;
  }

  async acceptSuggestion(id) {
    const s = await this.pool.query(
      `SELECT * FROM assignment_suggestion WHERE id = $1::uuid AND status = 'pending'`,
      [id],
    );
    if (!s.rowCount) return null;
    const row = s.rows[0];
    await this.pool.query(
      `INSERT INTO customer_owner (tenant_id, seller_id, customer_key, agent_id, source)
       VALUES ($1,$2,$3,$4::uuid,'suggest')
       ON CONFLICT (tenant_id, seller_id, customer_key)
       DO UPDATE SET agent_id = EXCLUDED.agent_id, source = 'suggest', assigned_at = now()`,
      [row.tenant_id, row.seller_id, row.customer_key, row.agent_id],
    );
    await this.pool.query(`UPDATE assignment_suggestion SET status = 'accepted' WHERE id = $1::uuid`, [id]);
    return row;
  }

  async rejectSuggestion(id) {
    const r = await this.pool.query(
      `UPDATE assignment_suggestion SET status = 'rejected' WHERE id = $1::uuid AND status = 'pending' RETURNING id`,
      [id],
    );
    return r.rowCount ? r.rows[0] : null;
  }
}

module.exports = { PgStore };
