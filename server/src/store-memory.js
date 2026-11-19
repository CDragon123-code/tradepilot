'use strict';

const { mergePayload } = require('./payload-merge');
const { dncActive, sameCustomerKey } = require('./exec-gate');

// 内存存储：与 PgStore 保持同一契约，供契约测试与本地演示使用
class MemoryStore {
  constructor() {
    this.name = 'memory';
    this.batches = new Map();
    this.parts = new Map();
    this.records = new Map();
  }

  async close() {}

  async ping() {
    return true;
  }

  async listTodoDecisions(tenantId, sellerId, ids) {
    const wanted = new Set(ids);
    return Array.from((this.todoDecisions || new Map()).values())
      .filter((row) => row.tenant_id === tenantId && row.seller_id === sellerId && wanted.has(row.todo_id));
  }

  async setTodoDecision({ tenantId, sellerId, todoId, state, note, title, actorId }) {
    if (!this.todoDecisions) this.todoDecisions = new Map();
    const key = [tenantId, sellerId, todoId].join('|');
    if (state === 'open') this.todoDecisions.delete(key);
    else this.todoDecisions.set(key, { tenant_id: tenantId, seller_id: sellerId, todo_id: todoId,
      state, note, title, actor_id: actorId, updated_at: new Date().toISOString() });
  }

  // ---------------- 主数据人工合并 ----------------

  async listMasterMerges(tenantId, sellerId) {
    return Array.from((this.masterMerges || new Map()).values())
      .filter((row) => row.tenant_id === tenantId && row.seller_id === sellerId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async upsertMasterMerge({ tenantId, sellerId, primaryUid, mergedUid, note, actorId }) {
    if (!this.masterMerges) this.masterMerges = new Map();
    const key = [tenantId, sellerId, mergedUid].join('|');
    const old = this.masterMerges.get(key);
    const row = {
      tenant_id: tenantId, seller_id: sellerId,
      primary_uid: primaryUid, merged_uid: mergedUid,
      note: String(note || '').slice(0, 200),
      actor_id: String(actorId || '').slice(0, 200),
      created_at: old ? old.created_at : new Date().toISOString(),
    };
    this.masterMerges.set(key, row);
    return row;
  }

  async deleteMasterMerge(tenantId, sellerId, mergedUid) {
    if (!this.masterMerges) return null;
    const key = [tenantId, sellerId, mergedUid].join('|');
    const row = this.masterMerges.get(key);
    if (!row) return null;
    this.masterMerges.delete(key);
    return row;
  }

  // ---------------- 员工与会话（测试用最小实现） ----------------

  async createEmployee({ tenantId, email, name, passwordHash, role }) {
    const id = require('node:crypto').randomUUID();
    const key = tenantId + '|' + String(email).trim().toLowerCase();
    const row = { id, tenant_id: tenantId, email: key.split('|')[1], name: name || '', password_hash: passwordHash, role: role || 'operator', status: 'active', alibaba_account_id: null };
    if (!this.employees) this.employees = new Map();
    const old = this.employees.get(key);
    if (old) row.id = old.id;
    this.employees.set(key, row);
    return { id: row.id, email: row.email, name: row.name, role: row.role, status: row.status };
  }

  async findEmployeeByEmail(tenantId, email) {
    if (!this.employees) return null;
    return this.employees.get(tenantId + '|' + String(email).trim().toLowerCase()) || null;
  }

  async listEmployees(tenantId) {
    return Array.from(this.employees ? this.employees.values() : [])
      .filter((e) => e.tenant_id === tenantId)
      .map((e) => {
        const m = (this.memberships || []).find((x) => x.employee_id === e.id);
        const a = e.alibaba_account_id
          ? (this.alibabaAccounts || new Map()).get(e.alibaba_account_id) : null;
        return {
          id: e.id, email: e.email, name: e.name, role: e.role, status: e.status,
          seller_id: m ? m.seller_id : null,
          alibaba_account_id: e.alibaba_account_id || null,
          alibaba_login: a ? a.login_name : null,
          alibaba_type: a ? a.account_type : null,
          owner_name: a ? a.owner_name : null,
          alibaba_display_name: a ? a.display_name : null,
          alibaba_status: a ? a.status : null,
        };
      });
  }

  async getEmployee(tenantId, id) {
    const hit = Array.from(this.employees ? this.employees.values() : []).find((e) => e.id === id && e.tenant_id === tenantId);
    return hit || null;
  }

  async updateEmployee({ tenantId, id, name, email, role, status, passwordHash }) {
    const hit = await this.getEmployee(tenantId, id);
    if (!hit) return null;
    if (name !== undefined && name !== null) hit.name = name;
    if (role) hit.role = role;
    if (status) hit.status = status;
    if (passwordHash) hit.password_hash = passwordHash;
    if (email !== undefined && email !== null && email !== hit.email) {
      const oldKey = tenantId + '|' + hit.email;
      const newKey = tenantId + '|' + String(email).trim().toLowerCase();
      if (this.employees.get(newKey) && this.employees.get(newKey).id !== hit.id) return { conflict: true };
      this.employees.delete(oldKey);
      hit.email = String(email).trim().toLowerCase();
      this.employees.set(newKey, hit);
    }
    return { id: hit.id, email: hit.email, name: hit.name, role: hit.role, status: hit.status, alibaba_account_id: hit.alibaba_account_id || null };
  }

  // ---------------- 阿里国际站账号注册表 ----------------

  async listAlibabaAccounts(tenantId) {
    return Array.from(this.alibabaAccounts ? this.alibabaAccounts.values() : [])
      .filter((row) => row.tenant_id === tenantId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  async getAlibabaAccount(tenantId, id) {
    const row = this.alibabaAccounts && this.alibabaAccounts.get(id);
    return row && row.tenant_id === tenantId ? row : null;
  }

  async findAlibabaAccountByLogin(tenantId, loginName) {
    return Array.from(this.alibabaAccounts ? this.alibabaAccounts.values() : [])
      .find((row) => row.tenant_id === tenantId && row.login_name === loginName) || null;
  }

  async createAlibabaAccount({ tenantId, sellerId, loginName, accountType, ownerName, displayName, note }) {
    if (!this.alibabaAccounts) this.alibabaAccounts = new Map();
    const id = require('node:crypto').randomUUID();
    const at = new Date().toISOString();
    const row = {
      id, tenant_id: tenantId, seller_id: sellerId || '', login_name: loginName,
      account_type: accountType || 'sub', owner_name: ownerName || '',
      display_name: displayName || '', note: note || '', status: 'active',
      created_at: at, updated_at: at,
    };
    this.alibabaAccounts.set(id, row);
    return Object.assign({}, row);
  }

  async updateAlibabaAccount({ tenantId, id, loginName, sellerId, accountType, ownerName, displayName, note, status }) {
    const row = this.alibabaAccounts && this.alibabaAccounts.get(id);
    if (!row || row.tenant_id !== tenantId) return null;
    if (loginName !== undefined) row.login_name = loginName;
    if (sellerId !== undefined) row.seller_id = sellerId;
    if (accountType !== undefined) row.account_type = accountType;
    if (ownerName !== undefined) row.owner_name = ownerName;
    if (displayName !== undefined) row.display_name = displayName;
    if (note !== undefined) row.note = note;
    if (status !== undefined) row.status = status;
    row.updated_at = new Date().toISOString();
    return Object.assign({}, row);
  }

  async deleteAlibabaAccount(tenantId, id) {
    const row = this.alibabaAccounts && this.alibabaAccounts.get(id);
    if (!row || row.tenant_id !== tenantId) return null;
    this.alibabaAccounts.delete(id);
    Array.from(this.employees ? this.employees.values() : []).forEach((e) => {
      if (e.alibaba_account_id === id) e.alibaba_account_id = null;
    });
    return { login_name: row.login_name };
  }

  async setEmployeeAlibabaAccount(tenantId, employeeId, accountId) {
    const hit = await this.getEmployee(tenantId, employeeId);
    if (!hit) return null;
    hit.alibaba_account_id = accountId || null;
    return { id: hit.id, alibaba_account_id: hit.alibaba_account_id };
  }

  async deleteEmployee(tenantId, id) {
    const hit = await this.getEmployee(tenantId, id);
    if (!hit) return null;
    this.employees.delete(tenantId + '|' + hit.email);
    return { email: hit.email };
  }

  async bindMembership({ employeeId, tenantId, sellerId, canIngest }) {
    if (!this.memberships) this.memberships = [];
    this.memberships.push({ employee_id: employeeId, tenant_id: tenantId, seller_id: sellerId, can_ingest: canIngest !== false });
  }

  async setPrimaryMembership({ employeeId, tenantId, sellerId }) {
    if (!this.memberships) this.memberships = [];
    const hits = this.memberships.filter((m) => m.employee_id === employeeId && m.tenant_id === tenantId);
    if (hits.length) {
      hits.forEach((m) => { m.seller_id = sellerId; m.can_ingest = true; });
    } else {
      this.memberships.push({ employee_id: employeeId, tenant_id: tenantId, seller_id: sellerId, can_ingest: true });
    }
  }

  async deleteSessionsByEmployee(employeeId) {
    if (!this.sessions) return 0;
    let removed = 0;
    for (const [key, s] of this.sessions.entries()) {
      if (s.employee_id === employeeId) { this.sessions.delete(key); removed += 1; }
    }
    return removed;
  }

  async primaryMembership(employeeId) {
    const hit = (this.memberships || []).find((m) => m.employee_id === employeeId);
    return hit ? { tenant_id: hit.tenant_id, seller_id: hit.seller_id, can_ingest: hit.can_ingest } : null;
  }

  async createSession({ tokenHash, employeeId, tenantId, sellerId, role, expiresAt }) {
    if (!this.sessions) this.sessions = new Map();
    this.sessions.set(tokenHash, { employee_id: employeeId, tenant_id: tenantId, seller_id: sellerId || '', role, expires_at: new Date(expiresAt).toISOString() });
  }

  async resolveSession(tokenHash) {
    const s = this.sessions && this.sessions.get(tokenHash);
    if (!s || s.expires_at <= new Date().toISOString()) return null;
    const emp = Array.from(this.employees ? this.employees.values() : []).find((e) => e.id === s.employee_id);
    if (!emp || emp.status !== 'active') return null;
    return Object.assign({}, s, { name: emp.name, email: emp.email, status: emp.status });
  }

  async deleteSession(tokenHash) {
    if (this.sessions) this.sessions.delete(tokenHash);
  }

  // ---------------- API 网关、调用流水与操作审计 ----------------

  async createApiClient({ tenantId, sellerId, name, kind, scopes, rateLimit, tokenHash, tokenPrefix, createdBy }) {
    if (!this.apiClients) this.apiClients = new Map();
    const id = require('node:crypto').randomUUID();
    const at = new Date().toISOString();
    const row = {
      id: id, tenant_id: tenantId, seller_id: sellerId || '', name: name,
      kind: kind || 'external', scopes: scopes || ['read'],
      rate_limit: Number(rateLimit) || 120, token_hash: tokenHash,
      token_prefix: tokenPrefix || '', status: 'active', created_by: createdBy || '',
      last_used_at: null, created_at: at, updated_at: at,
    };
    this.apiClients.set(id, row);
    return Object.assign({}, row);
  }

  async listApiClients(tenantId) {
    return Array.from(this.apiClients ? this.apiClients.values() : [])
      .filter((row) => row.tenant_id === tenantId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((row) => {
        const copy = Object.assign({}, row);
        delete copy.token_hash;
        return copy;
      });
  }

  async getApiClientByTokenHash(hash) {
    const hit = Array.from(this.apiClients ? this.apiClients.values() : [])
      .find((row) => row.token_hash === hash);
    return hit ? Object.assign({}, hit) : null;
  }

  async updateApiClient({ tenantId, id, name, scopes, rateLimit, status, tokenHash, tokenPrefix }) {
    const row = this.apiClients && this.apiClients.get(id);
    if (!row || row.tenant_id !== tenantId) return null;
    if (name !== undefined) row.name = name;
    if (scopes !== undefined) row.scopes = scopes;
    if (rateLimit !== undefined) row.rate_limit = rateLimit;
    if (status !== undefined) row.status = status;
    if (tokenHash !== undefined) row.token_hash = tokenHash;
    if (tokenPrefix !== undefined) row.token_prefix = tokenPrefix;
    row.updated_at = new Date().toISOString();
    return Object.assign({}, row);
  }

  async deleteApiClient(tenantId, id) {
    const row = this.apiClients && this.apiClients.get(id);
    if (!row || row.tenant_id !== tenantId) return null;
    this.apiClients.delete(id);
    return { name: row.name, token_prefix: row.token_prefix };
  }

  async touchApiClient(id) {
    const row = this.apiClients && this.apiClients.get(id);
    if (row) row.last_used_at = new Date().toISOString();
  }

  async logApiCall({ tenantId, clientId, clientName, actorType, method, path, status, ms, ip, requestId }) {
    if (!this.apiCalls) this.apiCalls = [];
    this.apiCalls.push({
      id: this.apiCalls.length + 1, tenant_id: tenantId, client_id: clientId || null,
      client_name: clientName || '', actor_type: actorType || 'anonymous',
      method: method, path: path, status: status, ms: ms, ip: ip || '',
      request_id: requestId || '', created_at: new Date().toISOString(),
    });
  }

  async listApiCalls(tenantId, options) {
    const opts = options || {};
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
    const minStatus = Number(opts.minStatus) || null;
    return (this.apiCalls || [])
      .filter((row) => row.tenant_id === tenantId && (!minStatus || row.status >= minStatus))
      .slice()
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);
  }

  async apiCallStats(tenantId, since) {
    const rows = (this.apiCalls || []).filter((row) => row.tenant_id === tenantId
      && String(row.created_at) >= String(since));
    const errors = rows.filter((row) => row.status >= 400).length;
    const serverErrors = rows.filter((row) => row.status >= 500).length;
    const denied = rows.filter((row) => row.status === 401 || row.status === 403).length;
    const avg = rows.length ? Math.round(rows.reduce((sum, row) => sum + Number(row.ms || 0), 0) / rows.length) : 0;
    const paths = new Map();
    rows.forEach((row) => {
      const cur = paths.get(row.path) || { path: row.path, count: 0, errors: 0 };
      cur.count += 1;
      if (row.status >= 400) cur.errors += 1;
      paths.set(row.path, cur);
    });
    return {
      total: rows.length, errors: errors, server_errors: serverErrors, denied: denied,
      avg_ms: avg,
      top_paths: Array.from(paths.values()).sort((a, b) => b.count - a.count).slice(0, 8),
    };
  }

  async addAudit({ tenantId, actorType, actorId, actorName, action, target, detail, ip, requestId }) {
    if (!this.audits) this.audits = [];
    this.audits.push({
      id: this.audits.length + 1, tenant_id: tenantId, actor_type: actorType || 'anonymous',
      actor_id: actorId || '', actor_name: actorName || '', action: action,
      target: target || '', detail: detail || {}, ip: ip || '', request_id: requestId || '',
      created_at: new Date().toISOString(),
    });
  }

  async listAudit(tenantId, options) {
    const opts = options || {};
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
    const action = String(opts.action || '').trim().toLowerCase();
    const actor = String(opts.actor || '').trim().toLowerCase();
    return (this.audits || [])
      .filter((row) => row.tenant_id === tenantId)
      .filter((row) => !action || row.action.toLowerCase().indexOf(action) >= 0)
      .filter((row) => !actor || row.actor_name.toLowerCase().indexOf(actor) >= 0
        || String(row.actor_id).toLowerCase().indexOf(actor) >= 0)
      .slice()
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);
  }

  async countAudit(tenantId, since) {
    return (this.audits || []).filter((row) => row.tenant_id === tenantId
      && String(row.created_at) >= String(since)).length;
  }

  // 采集登录态：按 tenant + seller 保存，供多账号采集器读取
  async getCollectorState(tenantId, sellerId) {
    if (!this.collectorStates) this.collectorStates = new Map();
    return this.collectorStates.get(tenantId + '|' + sellerId) || null;
  }

  async saveCollectorState({ tenantId, sellerId, cookies }) {
    if (!this.collectorStates) this.collectorStates = new Map();
    const row = { cookies: cookies || '', updated_at: new Date().toISOString() };
    this.collectorStates.set(tenantId + '|' + sellerId, row);
    return row;
  }

  async listCollectorStates(tenantId) {
    if (!this.collectorStates) this.collectorStates = new Map();
    const prefix = tenantId + '|';
    return Array.from(this.collectorStates.keys())
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({
        seller_id: key.slice(prefix.length),
        updated_at: this.collectorStates.get(key).updated_at,
      }))
      .sort((a, b) => a.seller_id.localeCompare(b.seller_id));
  }

  async upsertHeartbeat({ tenantId, sellerId, clientId, version, queueRows, counts, lastUploadAt }) {
    if (!this.heartbeats) this.heartbeats = new Map();
    const key = [tenantId, sellerId, clientId].join('|');
    const row = {
      tenant_id: tenantId, seller_id: sellerId, client_id: clientId,
      version: version || '', queue_rows: Number(queueRows) || 0,
      counts: counts || {}, last_upload_at: lastUploadAt || null,
      updated_at: new Date().toISOString(),
    };
    this.heartbeats.set(key, row);
    return row;
  }

  async createBatch({ tenantId, sellerId, kind, meta }) {
    const id = require('node:crypto').randomUUID();
    const batch = {
      id: id,
      tenant_id: tenantId,
      seller_id: sellerId,
      kind: kind,
      meta: meta || {},
      status: 'open',
      created_at: new Date().toISOString(),
      committed_at: null,
      result: null,
    };
    this.batches.set(id, batch);
    this.parts.set(id, new Map());
    return batch;
  }

  async putPart({ batchId, partNo, checksum, rows }) {
    const batch = this.batches.get(batchId);
    if (!batch) throw err(404, 'import_not_found', '导入批次不存在');
    if (batch.status === 'committed') throw err(409, 'import_committed', '批次已提交，不能再上传分片');
    const parts = this.parts.get(batchId);
    const before = parts.get(partNo);
    if (before) {
      if (before.checksum === checksum) return { duplicate: true, row_count: before.rows.length };
      throw err(409, 'part_conflict', '同一分片号已上传过不同内容');
    }
    parts.set(partNo, { checksum: checksum, rows: rows });
    return { duplicate: false, row_count: rows.length };
  }

  async commit(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) throw err(404, 'import_not_found', '导入批次不存在');
    if (batch.status === 'committed') return batch.result;
    const parts = this.parts.get(batchId) || new Map();
    if (!parts.size) throw err(400, 'no_parts', '还没有上传任何分片');
    const merged = new Map();
    Array.from(parts.keys()).sort((a, b) => a - b).forEach((no) => {
      parts.get(no).rows.forEach((row) => merged.set(row.platform_id, row));
    });
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    // 所有类型的空白字段都视为“未知”，任何来源都不应冲掉已有非空值
    const keepFilled = true;
    merged.forEach((row, platformId) => {
      const key = [batch.tenant_id, batch.seller_id, batch.kind, platformId].join('|');
      const prev = this.records.get(key);
      if (!prev) {
        inserted += 1;
        this.records.set(key, {
          tenant_id: batch.tenant_id,
          seller_id: batch.seller_id,
          kind: batch.kind,
          platform_id: platformId,
          payload: row.payload,
          business_at: row.business_at,
          observed_at: row.observed_at,
          updated_at: new Date().toISOString(),
        });
        return;
      }
      if (!isNewerOrEqual(row.business_at, prev.business_at)) {
        skipped += 1;
        return;
      }
      updated += 1;
      this.records.set(key, Object.assign({}, prev, {
        payload: keepFilled ? mergePayload(prev.payload, row.payload) : row.payload,
        business_at: row.business_at,
        observed_at: row.observed_at,
        updated_at: new Date().toISOString(),
      }));
    });
    const result = { received: merged.size, inserted: inserted, updated: updated, skipped: skipped, part_count: parts.size };
    batch.status = 'committed';
    batch.committed_at = new Date().toISOString();
    batch.result = result;
    return result;
  }

  async syncStatus(sellerId) {
    const byKind = new Map();
    this.batches.forEach((b) => {
      if (b.seller_id !== sellerId || b.status !== 'committed') return;
      const cur = byKind.get(b.kind) || { kind: b.kind, last_success_at: null, batches: 0, rows: 0, last_business_at: null };
      cur.batches += 1;
      if (!cur.last_success_at || b.committed_at > cur.last_success_at) cur.last_success_at = b.committed_at;
      byKind.set(b.kind, cur);
    });
    this.records.forEach((r) => {
      if (r.seller_id !== sellerId) return;
      const cur = byKind.get(r.kind) || { kind: r.kind, last_success_at: null, batches: 0, rows: 0, last_business_at: null };
      cur.rows += 1;
      if (r.business_at && (!cur.last_business_at || r.business_at > cur.last_business_at)) cur.last_business_at = r.business_at;
      byKind.set(r.kind, cur);
    });
    return Array.from(byKind.values()).sort((a, b) => a.kind.localeCompare(b.kind));
  }

  async changes({ sellerId, since, limit }) {
    const out = [];
    this.records.forEach((r) => {
      if (r.seller_id !== sellerId) return;
      if (since && r.updated_at <= since) return;
      out.push({ kind: r.kind, platform_id: r.platform_id, payload: r.payload, business_at: r.business_at, updated_at: r.updated_at });
    });
    out.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    return out.slice(0, limit);
  }

  // 按类型取当前态整行，供领域逻辑（待办/归并）复用
  async rowsByKind(sellerId, kinds, opts) {
    const want = new Set(kinds || []);
    const sinceDays = Number(opts && opts.sinceDays) || 0;
    const since = sinceDays ? Date.now() - sinceDays * 86400000 : 0;
    const out = {};
    (kinds || []).forEach((k) => { out[k] = []; });
    this.records.forEach((r) => {
      if (r.seller_id !== sellerId || !want.has(r.kind)) return;
      if (since && r.business_at) {
        const t = Date.parse(r.business_at);
        if (Number.isFinite(t) && t < since) return;
      }
      out[r.kind].push(r.payload);
    });
    return out;
  }

  // ---------------- 业务员与执行队列（测试用最小实现） ----------------

  async listAgents(sellerId) {
    return Array.from((this.agents || new Map()).values()).filter((a) => a.seller_id === sellerId);
  }

  async createAgent(input) {
    if (!this.agents) this.agents = new Map();
    const id = require('node:crypto').randomUUID();
    const row = {
      id, tenant_id: input.tenantId, seller_id: input.sellerId, name: input.name,
      persona: input.persona || '', language: input.language || 'en',
      daily_limit: Number(input.dailyLimit) || 20,
      cooldown_hours: input.cooldownHours === undefined ? 24 : Number(input.cooldownHours),
      quiet_start: input.quietStart || '23:00', quiet_end: input.quietEnd || '07:00',
      tz_offset_minutes: input.tzOffsetMinutes === undefined ? 480 : Number(input.tzOffsetMinutes),
      status: 'active', dify_base_url: '', dify_app_key: '', model: '',
    };
    this.agents.set(id, row);
    return row;
  }

  async getAgent(tenantId, sellerId, id) {
    const a = (this.agents || new Map()).get(id);
    return a && a.tenant_id === tenantId && a.seller_id === sellerId ? a : null;
  }

  async updateAgent({ tenantId, id, patch }) {
    const a = (this.agents || new Map()).get(id);
    if (!a || a.tenant_id !== tenantId) return null;
    const p = patch || {};
    if (p.name !== undefined) a.name = p.name;
    if (p.persona !== undefined) a.persona = p.persona;
    if (p.dailyLimit !== undefined) a.daily_limit = Number(p.dailyLimit);
    if (p.cooldownHours !== undefined) a.cooldown_hours = Number(p.cooldownHours);
    if (p.quietStart !== undefined) a.quiet_start = p.quietStart;
    if (p.quietEnd !== undefined) a.quiet_end = p.quietEnd;
    if (p.tzOffsetMinutes !== undefined) a.tz_offset_minutes = Number(p.tzOffsetMinutes);
    if (p.language !== undefined) a.language = p.language;
    if (p.model !== undefined) a.model = p.model;
    if (p.status) a.status = p.status;
    return a;
  }

  async deleteAgent(tenantId, id) {
    const a = (this.agents || new Map()).get(id);
    if (!a || a.tenant_id !== tenantId) return null;
    this.agents.delete(id);
    return { name: a.name };
  }

  // ---------------- AI 运行与总览（测试用最小实现） ----------------

  async saveAiRun(run) {
    if (!this.aiRuns) this.aiRuns = [];
    const row = {
      id: this.aiRuns.length + 1,
      tenant_id: run.tenantId, seller_id: run.sellerId,
      agent_id: run.agentId || null, task_item_id: run.taskItemId || null,
      prompt_version: run.promptVersion || 'v1', knowledge_version: run.knowledgeVersion || '',
      model: run.model || '', tokens: Number(run.tokens) || 0, latency_ms: Number(run.latencyMs) || 0,
      citations: run.citations || [], risk: run.risk || [], output: String(run.output || ''),
      state: run.state || 'ok', error: String(run.error || ''),
      created_at: new Date().toISOString(),
    };
    this.aiRuns.push(row);
    return { id: row.id, created_at: row.created_at };
  }

  async listRunsByItem(itemId, limit) {
    return (this.aiRuns || [])
      .filter((row) => String(row.task_item_id) === String(itemId))
      .slice()
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, Math.min(20, Number(limit) || 5));
  }

  async aiOverview(tenantId, sellerId, since) {
    const agents = Array.from(this.agents ? this.agents.values() : [])
      .filter((row) => row.tenant_id === tenantId && row.seller_id === sellerId);
    const tasks = (this.aiTasks || []).filter((row) => row.tenant_id === tenantId && row.seller_id === sellerId);
    const items = Array.from(this.taskItems ? this.taskItems.values() : [])
      .filter((row) => row.tenant_id === tenantId && row.seller_id === sellerId);
    const byState = {};
    items.forEach((row) => { byState[row.state] = (byState[row.state] || 0) + 1; });
    const draftRuns = (this.aiRuns || []).filter((row) => row.tenant_id === tenantId
      && row.seller_id === sellerId && String(row.created_at) >= String(since));
    const chatRuns = (this.agentRuns || []).filter((row) => row.tenant_id === tenantId
      && row.seller_id === sellerId && String(row.created_at) >= String(since));
    const stats = (rows) => ({
      total: rows.length,
      errors: rows.filter((row) => row.state !== 'ok').length,
      avg_ms: rows.length ? Math.round(rows.reduce((n, row) => n + Number(row.latency_ms || 0), 0) / rows.length) : 0,
    });
    const draft = Object.assign(stats(draftRuns), {
      tokens: draftRuns.reduce((n, row) => n + Number(row.tokens || 0), 0),
    });
    return {
      agents: { total: agents.length, active: agents.filter((row) => row.status === 'active').length },
      tasks: { total: tasks.length, active: tasks.filter((row) => row.status === 'active').length },
      items: {
        total: items.length,
        pending: byState.pending || 0, drafted: byState.drafted || 0,
        review_required: byState.review_required || 0, approved: byState.approved || 0,
        sent: byState.sent || 0, cancelled: byState.cancelled || 0, failed: byState.failed || 0,
      },
      escalations: { open: (this.escalations || []).filter((row) => row.tenant_id === tenantId
        && row.seller_id === sellerId && row.status === 'open').length },
      suggestions: { pending: (this.suggestions || []).filter((row) => row.tenant_id === tenantId
        && row.seller_id === sellerId && row.status === 'pending').length },
      runs: { draft: draft, chat: stats(chatRuns) },
    };
  }

  async listAiRuns({ tenantId, sellerId, kind, state, agentId, limit }) {
    const agents = this.agents || new Map();
    const nameOf = (id) => {
      const agent = agents.get(id);
      return agent ? agent.name : '';
    };
    const draft = (this.aiRuns || [])
      .filter((row) => row.tenant_id === tenantId && row.seller_id === sellerId)
      .map((row) => ({
        kind: 'draft', id: String(row.id), agent_id: row.agent_id, agent_name: nameOf(row.agent_id),
        ref_id: row.task_item_id, state: row.state, model: row.model, tokens: row.tokens,
        latency_ms: row.latency_ms, output: String(row.output || '').slice(0, 300),
        error: row.error, created_at: row.created_at,
      }));
    const chat = (this.agentRuns || [])
      .filter((row) => row.tenant_id === tenantId && row.seller_id === sellerId)
      .map((row) => ({
        kind: 'chat', id: String(row.id), agent_id: row.agent_id, agent_name: nameOf(row.agent_id),
        ref_id: row.thread_id, state: row.state, model: row.model, tokens: 0,
        latency_ms: row.latency_ms, output: String(row.output || '').slice(0, 300),
        error: row.error, created_at: row.created_at,
      }));
    return draft.concat(chat)
      .filter((row) => !kind || row.kind === kind)
      .filter((row) => !state || row.state === state)
      .filter((row) => !agentId || String(row.agent_id) === String(agentId))
      .slice()
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, Math.min(500, Math.max(1, Number(limit) || 100)));
  }

  // ---------------- 店铺停机开关 / 不联系名单 ----------------

  async getSellerControl(tenantId, sellerId) {
    return (this.sellerControls || new Map()).get(tenantId + '|' + sellerId)
      || { tenant_id: tenantId, seller_id: sellerId, send_paused: false, pause_reason: '',
        paused_at: null, updated_by: '', updated_at: null };
  }

  async setSellerControl({ tenantId, sellerId, paused, reason, actorId }) {
    if (!this.sellerControls) this.sellerControls = new Map();
    const at = new Date().toISOString();
    const row = {
      tenant_id: tenantId, seller_id: sellerId, send_paused: !!paused,
      pause_reason: paused ? String(reason || '').slice(0, 200) : '',
      paused_at: paused ? at : null,
      updated_by: String(actorId || '').slice(0, 200), updated_at: at,
    };
    this.sellerControls.set(tenantId + '|' + sellerId, row);
    return row;
  }

  async listDnc(tenantId, sellerId, options) {
    const opts = options || {};
    const now = Date.now();
    const rows = Array.from((this.dnc || new Map()).values())
      .filter((r) => r.tenant_id === tenantId && r.seller_id === sellerId)
      .map((r) => Object.assign({}, r, { active: dncActive(r, now) }));
    const filtered = opts.activeOnly === false ? rows : rows.filter((r) => r.active);
    filtered.sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
    return filtered.slice(0, Math.min(500, Math.max(1, Number(opts.limit) || 100)));
  }

  dncFor(tenantId, sellerId, customerKey, nowMs) {
    const now = Number(nowMs) || Date.now();
    return Array.from((this.dnc || new Map()).values()).find((r) => r.tenant_id === tenantId
      && r.seller_id === sellerId && sameCustomerKey(r.customer_key, customerKey) && dncActive(r, now)) || null;
  }

  async getDnc(tenantId, sellerId, customerKey) {
    return this.dncFor(tenantId, sellerId, customerKey);
  }

  async upsertDnc({ tenantId, sellerId, customerKey, reason, until, actorId }) {
    if (!this.dnc) this.dnc = new Map();
    const key = [tenantId, sellerId, customerKey].join('|');
    const prev = this.dnc.get(key);
    const row = {
      tenant_id: tenantId, seller_id: sellerId, customer_key: customerKey,
      reason: String(reason || '').slice(0, 200), until: until || null,
      updated_by: String(actorId || '').slice(0, 200),
      created_at: prev ? prev.created_at : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.dnc.set(key, row);
    return row;
  }

  async deleteDnc(tenantId, sellerId, customerKey) {
    if (!this.dnc) return false;
    for (const [key, row] of this.dnc.entries()) {
      if (row.tenant_id === tenantId && row.seller_id === sellerId && sameCustomerKey(row.customer_key, customerKey)) {
        this.dnc.delete(key);
        return true;
      }
    }
    return false;
  }

  // 测试辅助：直接造一条已批准的执行项
  async seedTaskItem({ tenantId, sellerId, agentId, customerKey, draftText, customerName, state }) {
    if (!this.taskItems) this.taskItems = new Map();
    const id = require('node:crypto').randomUUID();
    const row = {
      id, tenant_id: tenantId, seller_id: sellerId, agent_id: agentId,
      customer_key: customerKey, draft_text: draftText || '',
      customer_name: customerName || '', state: state || 'approved',
      attempts: 0, claimed_by: '', claimed_at: null, claim_token: '',
      sent_at: null, created_at: new Date().toISOString(),
    };
    this.taskItems.set(id, row);
    if (!this.messageEvents) this.messageEvents = [];
    return row;
  }

  async getTaskItem(id) {
    return (this.taskItems || new Map()).get(id) || null;
  }

  async listExecutions(sellerId, limit) {
    const agents = this.agents || new Map();
    const now = Date.now();
    const rows = Array.from((this.taskItems || new Map()).values())
      .filter((i) => i.seller_id === sellerId && i.state === 'approved' && String(i.draft_text).trim());
    return rows.slice(0, Math.min(100, Number(limit) || 30)).map((i) => {
      const a = agents.get(i.agent_id) || {};
      const dnc = this.dncFor(i.tenant_id, i.seller_id, i.customer_key, now);
      return Object.assign({}, i, {
        agent_name: a.name || '', daily_limit: a.daily_limit, cooldown_hours: a.cooldown_hours,
        quiet_start: a.quiet_start, quiet_end: a.quiet_end, agent_status: a.status,
        tz_offset_minutes: a.tz_offset_minutes,
        dnc_active: !!dnc, dnc_reason: dnc ? dnc.reason : null,
      });
    });
  }

  async executionStats(sellerId, sinceIso) {
    const since = Date.parse(sinceIso);
    const items = this.taskItems || new Map();
    const byAgent = {};
    const byCustomer = {};
    (this.messageEvents || []).forEach((e) => {
      if (e.seller_id !== sellerId || e.direction !== 'out' || e.state !== 'sent_confirmed') return;
      const item = items.get(e.task_item_id);
      if (!item) return;
      if (Number.isFinite(since) && Date.parse(e.created_at) < since) return;
      byAgent[item.agent_id] = (byAgent[item.agent_id] || 0) + 1;
    });
    (this.messageEvents || []).forEach((e) => {
      if (e.seller_id !== sellerId || e.direction !== 'out' || e.state !== 'sent_confirmed') return;
      const item = items.get(e.task_item_id);
      if (!item) return;
      const prev = byCustomer[item.customer_key];
      const at = Date.parse(e.created_at);
      if (!prev || at > prev) byCustomer[item.customer_key] = at;
    });
    return { byAgent, byCustomer };
  }

  async claimExecution(id, { clientId, leaseSeconds }) {
    const item = (this.taskItems || new Map()).get(id);
    if (!item) return { ok: false, code: 'execution_not_found' };
    if (item.state === 'sent') return { ok: false, code: 'already_sent' };
    // 领取前再次复核店铺停机与 DNC，避免列表通过后状态变化仍被发出
    const control = await this.getSellerControl(item.tenant_id, item.seller_id);
    if (control.send_paused) return { ok: false, code: 'store_paused' };
    if (await this.getDnc(item.tenant_id, item.seller_id, item.customer_key)) {
      return { ok: false, code: 'dnc_blocked' };
    }
    const lease = Math.max(60, Math.min(3600, Number(leaseSeconds) || 300));
    const token = require('node:crypto').randomBytes(8).toString('hex');
    if (item.state === 'approved') {
      item.state = 'sending';
      item.claimed_by = String(clientId || '');
      item.claimed_at = new Date().toISOString();
      item.claim_token = token;
      item.attempts = (item.attempts || 0) + 1;
      return { ok: true, item, claim_token: token, expires_at: new Date(Date.now() + lease * 1000).toISOString() };
    }
    if (item.state === 'sending') {
      const age = item.claimed_at ? (Date.now() - Date.parse(item.claimed_at)) / 1000 : 0;
      if (age < lease) return { ok: false, code: 'claimed_by_other', retry_after_seconds: Math.ceil(lease - age) };
      item.claimed_by = String(clientId || '');
      item.claimed_at = new Date().toISOString();
      item.claim_token = token;
      return { ok: true, item, claim_token: token, expires_at: new Date(Date.now() + lease * 1000).toISOString() };
    }
    return { ok: false, code: 'not_claimable', state: item.state };
  }

  async markExecution(id, patch) {
    const item = (this.taskItems || new Map()).get(id);
    if (!item) return null;
    const p = patch || {};
    const state = p.status === 'sent' ? 'sent' : (p.status === 'uncertain' ? 'uncertain' : 'failed');
    if (item.state === state) return Object.assign({ idempotent: true }, item);
    if (item.state !== 'approved' && item.state !== 'sending') {
      return Object.assign({ conflict: true, current: item.state }, item);
    }
    item.state = state;
    if (state === 'sent') item.sent_at = new Date().toISOString();
    if (p.note) item.last_error = String(p.note).slice(0, 300);
    item.claimed_by = '';
    item.claim_token = '';
    if (!this.messageEvents) this.messageEvents = [];
    this.messageEvents.push({
      task_item_id: item.id, tenant_id: item.tenant_id, seller_id: item.seller_id,
      direction: 'out', content: item.draft_text,
      state: state === 'sent' ? 'sent_confirmed' : (state === 'uncertain' ? 'send_uncertain' : 'send_failed'),
      created_at: new Date().toISOString(),
    });
    return item;
  }

  // 询盘列表：关键词 / 国家 / 来源 / 加客 / 等级 + 分页
  async listInquiries(query) {
    const opts = query || {};
    const page = Math.max(1, Number(opts.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(opts.pageSize) || 20));
    const text = String(opts.q || '').trim().toLowerCase();
    const rows = [];
    this.records.forEach((r) => {
      if (r.seller_id !== opts.sellerId || r.kind !== 'inquiry') return;
      const p = r.payload || {};
      if (text) {
        const name = String(p['客户名称'] || '').toLowerCase();
        const company = String(p['公司名称'] || '').toLowerCase();
        if (name.indexOf(text) < 0 && company.indexOf(text) < 0) return;
      }
      if (opts.country && String(p['国家'] || '') !== opts.country) return;
      if (opts.source && String(p['来源'] || '') !== opts.source) return;
      if (opts.added && String(p['是否已加为客户'] || '') !== opts.added) return;
      if (opts.grade) {
        const g = String(p['买家等级'] || p['买家等级(字母)'] || '').toUpperCase();
        if (g !== String(opts.grade).toUpperCase()) return;
      }
      rows.push({ platform_id: r.platform_id, business_at: r.business_at, updated_at: r.updated_at, payload: p });
    });
    rows.sort((a, b) => String(b.business_at || '').localeCompare(String(a.business_at || ''))
      || String(b.updated_at).localeCompare(String(a.updated_at)));
    const start = (page - 1) * pageSize;
    return { total: rows.length, page: page, pageSize: pageSize, rows: rows.slice(start, start + pageSize) };
  }

  // 只读摘要：与 PgStore.summary 输出同一结构
  async summary(sellerId, now) {
    const { composeSummary } = require('./summary');
    const sources = await this.syncStatus(sellerId);
    const blank = (v) => v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim() !== '-';
    const inquiry = { total: 0, noName: 0, noCompany: 0, noCountry: 0, noGrade: 0, adTotal: 0, adNamed: 0 };
    const order = { total: 0, noInquiryId: 0 };
    let chatTotal = 0;
    const chatSessions = new Set();
    this.records.forEach((r) => {
      if (r.seller_id !== sellerId) return;
      const p = r.payload || {};
      if (r.kind === 'inquiry') {
        inquiry.total += 1;
        if (!blank(p['客户名称'])) inquiry.noName += 1;
        if (!blank(p['公司名称'])) inquiry.noCompany += 1;
        if (!blank(p['国家'])) inquiry.noCountry += 1;
        if (!blank(p['买家等级']) && !blank(p['买家等级(字母)'])) inquiry.noGrade += 1;
        const ad = /营销|广告|直通车|mkt/i.test(String(p['来源'] || '') + String(p['来源端'] || ''));
        if (ad) {
          inquiry.adTotal += 1;
          if (blank(p['客户名称'])) inquiry.adNamed += 1;
        }
      } else if (r.kind === 'order') {
        order.total += 1;
        if (!blank(p['询盘ID'])) order.noInquiryId += 1;
      } else if (r.kind === 'chat') {
        chatTotal += 1;
        const s = String(p['会话'] || '').trim();
        if (s) chatSessions.add(s);
      }
    });
    const recent = Array.from(this.batches.values())
      .filter((b) => b.seller_id === sellerId && b.status === 'committed')
      .sort((a, b) => String(b.committed_at).localeCompare(String(a.committed_at)))
      .slice(0, 5)
      .map((b) => ({ id: b.id, kind: b.kind, committed_at: b.committed_at, rows: (b.result && b.result.received) || 0 }));
    return composeSummary({
      sellerId: sellerId,
      sources: sources,
      inquiry: inquiry,
      order: order,
      chat: { total: chatTotal, sessions: chatSessions.size },
      recent: recent,
      now: now,
    });
  }
}

// 业务时间未知时不覆盖已知时间；同时间视为可更新
function isNewerOrEqual(incoming, current) {
  if (!incoming || !current) return true;
  return incoming >= current;
}

function err(status, code, message) {
  const e = new Error(message || code);
  e.status = status;
  e.code = code;
  return e;
}

module.exports = { MemoryStore };
