'use strict';

// 云端最小数据平台的 HTTP 入口：鉴权 → 校验 → 存储
// 约定：扩展/采集器持采集令牌（INGEST_TOKEN），员工端持只读令牌（READ_TOKEN），都不碰数据库口令

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const log = require('./log');
const { healthPayload } = require('./health');
const { verifyPassword, hashPassword, newToken, tokenHash } = require('./auth');
const { seal, open: openSecret } = require('./secret-box');
const { generateDraft, difyConfig } = require('./draft-service');
const { RULES: GUARD_RULES } = require('./guard');
const { runTurn, resumeAfterEscalation, suggestForAgent } = require('./agent-runtime');
const { evaluate, startOfLocalDay, dncActive } = require('./exec-gate');

const KINDS = new Set(['inquiry', 'customer', 'public_customer', 'chat', 'order', 'visitor', 'ad_report']);
const MAX_ROWS_PER_PART = 5000;
// 写接口只认采集令牌，读接口只认员工令牌，避免一条令牌通吃
const INGEST_ROUTES = new Set(['create', 'part', 'commit', 'collectorCookiesSave']);
// 员工账号管理只允许 admin 访问
const ADMIN_ROUTES = [
  'employees', 'employeeCreate', 'employeeUpdate', 'employeeDelete',
  'agents', 'agentCreate', 'agentUpdate', 'agentDelete',
  'agentAssign', 'agentAssignments', 'agentUnassign',
  'tasks', 'taskCreate', 'taskItems', 'taskItem', 'taskItemUpdate', 'taskItemDraft',
  'reviewQueue', 'opsOverview', 'platformAi',
  'threadCreate', 'threads', 'thread', 'threadTurn',
  'escalations', 'escalationResolve',
  'agentSuggest', 'suggestions', 'suggestionAccept', 'suggestionReject',
  'executions', 'executionResult', 'executionClaim',
  'sendControl', 'sendControlUpdate', 'dnc', 'dncAdd', 'dncDelete',
  'masterMerge', 'masterUnmerge',
  'gatewayOverview', 'gatewayCatalog', 'gatewayClients', 'gatewayClientCreate',
  'gatewayClientUpdate', 'gatewayClientRotate', 'gatewayClientDelete',
  'gatewayCalls', 'auditLog',
  'aiOverview', 'aiRuns',
  'alibabaAccounts', 'alibabaAccountCreate', 'alibabaAccountUpdate', 'alibabaAccountDelete',
];
// 采集器只持 ingest 令牌，但需要读取登录态、上报心跳
const MACHINE_READ_ROUTES = new Set(['collectorAccounts', 'collectorCookiesGet', 'heartbeat']);
const ROLES = ['admin', 'operator', 'viewer'];
const STATUSES = ['active', 'disabled'];
// API 网关：令牌范围与客户端类型
const API_SCOPES = ['read', 'write', 'collector'];
const API_CLIENT_KINDS = ['extension', 'collector', 'external'];
// 对外 API 目录：页面展示与令牌范围说明使用
const API_CATALOG = [
  {
    group: '数据读取', scope: 'read', items: [
      { method: 'GET', path: '/api/dataset', desc: '按类型取当前态全量数据' },
      { method: 'GET', path: '/api/inquiries', desc: '询盘筛选与分页' },
      { method: 'GET', path: '/api/todos', desc: '云端计算待办' },
      { method: 'GET', path: '/api/customer-profile?uid=', desc: '客户档案 + 分层 + 缺口 + DNC' },
      { method: 'GET', path: '/api/metrics/overview', desc: '经营 KPI、漏斗与趋势' },
      { method: 'GET', path: '/api/data-assets?kind=', desc: '数据资产字段字典' },
      { method: 'GET', path: '/api/master-data', desc: '主数据档案与重复候选' },
      { method: 'GET', path: '/api/freshness', desc: '六类数据新鲜度' },
      { method: 'GET', path: '/changes?since=', desc: '增量变更游标' },
      { method: 'POST', path: '/api/send-check', desc: '发送前门禁校验（只读计算）' },
    ],
  },
  {
    group: '数据写入', scope: 'write', items: [
      { method: 'POST', path: '/imports', desc: '创建导入批次' },
      { method: 'PUT', path: '/imports/{id}/parts/{no}', desc: '上传批次分片' },
      { method: 'POST', path: '/imports/{id}/commit', desc: '提交批次' },
      { method: 'POST', path: '/api/heartbeat', desc: '采集器心跳与缺口上报' },
    ],
  },
  {
    group: '采集专用', scope: 'collector', items: [
      { method: 'GET', path: '/api/collector/accounts', desc: '列出已托管登录态的店铺账号' },
      { method: 'GET', path: '/api/collector/cookies', desc: '读取托管的平台登录态' },
    ],
  },
  {
    group: '管理端（仅员工管理员）', scope: 'admin', items: [
      { method: 'GET', path: '/api/gateway/clients', desc: 'API 令牌列表' },
      { method: 'GET', path: '/api/gateway/calls', desc: 'API 调用流水' },
      { method: 'GET', path: '/api/audit', desc: '关键操作审计' },
    ],
  },
];

function employeeScopes(role) {
  if (role === 'admin') return ['read', 'write', 'collector', 'admin'];
  if (role === 'operator') return ['read', 'write'];
  return ['read'];
}

function newApiToken() {
  const token = 'rk_' + newToken();
  return { token: token, prefix: token.slice(0, 12) };
}

function normalizeScopes(input) {
  if (!Array.isArray(input)) return null;
  const list = Array.from(new Set(input.map((item) => String(item).trim()).filter(Boolean)));
  if (!list.length || list.some((scope) => API_SCOPES.indexOf(scope) < 0)) return null;
  return list;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 只读工作台的静态资源白名单：不做目录映射，避免路径穿越
const STATIC = {
  'index.html': 'text/html; charset=utf-8',
  'data.html': 'text/html; charset=utf-8',
  'business.html': 'text/html; charset=utf-8',
  'quality.html': 'text/html; charset=utf-8',
  'assets.html': 'text/html; charset=utf-8',
  'master.html': 'text/html; charset=utf-8',
  'admin.html': 'text/html; charset=utf-8',
  'agents.html': 'text/html; charset=utf-8',
  'console.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'data-common.js': 'text/javascript; charset=utf-8',
  'data.js': 'text/javascript; charset=utf-8',
  'business.js': 'text/javascript; charset=utf-8',
  'quality.js': 'text/javascript; charset=utf-8',
  'assets.js': 'text/javascript; charset=utf-8',
  'master.js': 'text/javascript; charset=utf-8',
  'admin.js': 'text/javascript; charset=utf-8',
  'agents.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'shell.css': 'text/css; charset=utf-8',
  'shell.js': 'text/javascript; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readJson(req, limit) {
  const max = limit || 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new HttpError(413, 'payload_too_large', '请求体超过上限'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new HttpError(400, 'invalid_json', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseTime(v) {
  if (!v) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function todoId(todo) {
  return crypto.createHash('sha256').update(JSON.stringify([
    todo.tag || '', todo.key || '', todo.inquiryId || '', todo.title || '', todo.detail || '',
    todo.ai && todo.ai.interaction || '',
  ])).digest('hex');
}

// 数据中台：用各数据源最近一次成功同步时间作为 data_version
function latestSync(summary) {
  const times = ((summary && summary.sources) || [])
    .map((src) => src.last_success_at).filter(Boolean).sort();
  return times.length ? times[times.length - 1] : null;
}

// ---------------- 主数据：把人工合并记录叠加到身份归并结果 ----------------

// 合并时主档案保留自己的展示信息，被合并档案只补空缺并汇总关联记录
function mergeProfileInto(primary, merged) {
  ['customerIds', 'inquiryIds', 'chatSessions'].forEach((key) => {
    (merged[key] || []).forEach((value) => {
      if (primary[key].indexOf(value) < 0) primary[key].push(value);
    });
  });
  (merged.aliasList || []).forEach((value) => {
    if (primary.aliasList.indexOf(value) < 0) primary.aliasList.push(value);
  });
  (merged.aliases || new Set()).forEach((value) => primary.aliases.add(value));
  (merged.sources || new Set()).forEach((value) => primary.sources.add(value));
  primary.mineCount += merged.mineCount || 0;
  primary.publicCount += merged.publicCount || 0;
  primary.chatCount += merged.chatCount || 0;
  if (!primary.primaryCustomer && merged.primaryCustomer) primary.primaryCustomer = merged.primaryCustomer;
  if (!primary.company && merged.company) primary.company = merged.company;
  if (!primary.country && merged.country) primary.country = merged.country;
  if ((!primary.display || primary.display === '未命名客户') && merged.display) primary.display = merged.display;
  if (merged.lastChat && (!primary.lastChat || merged.lastChat > primary.lastChat)) primary.lastChat = merged.lastChat;
  return primary;
}

// 返回 { profiles, byUid, applied }；跳过已失效或成环的记录，保证页面仍可打开
function applyMasterMerges(profiles, merges) {
  const byUid = new Map(profiles.map((p) => [p.uid, p]));
  const applied = [];
  (merges || []).forEach((row) => {
    const primaryUid = String(row.primary_uid || '');
    const mergedUid = String(row.merged_uid || '');
    const primary = byUid.get(primaryUid);
    const merged = byUid.get(mergedUid);
    if (!primary || !merged || primary === merged) {
      applied.push(Object.assign({}, row, { status: 'skipped' }));
      return;
    }
    mergeProfileInto(primary, merged);
    byUid.delete(mergedUid);
    applied.push(Object.assign({}, row, { status: 'applied' }));
  });
  return { profiles: Array.from(byUid.values()), byUid, applied };
}

// 重复候选：公司名去掉法律后缀后相同，或联系人名相同，但身份层没有自动合并
function masterGroupKey(text, stripCompanySuffix) {
  let key = String(text === undefined || text === null ? '' : text).toLowerCase()
    .replace(/\s+/g, '').replace(/[.,，。()（）"'&·\-_/\\]/g, '');
  if (stripCompanySuffix) {
    // 循环剥离后缀，覆盖 "Co., Ltd" / "Company Limited" 这类组合写法
    let prev = '';
    while (key && key !== prev) {
      prev = key;
      key = key.replace(/(有限责任公司|有限公司|公司|coltd|ltd|limited|llc|incorporated|inc|corporation|corp|company|gmbh|bv|sa|co)$/, '');
    }
  }
  return key.length >= 3 ? key : '';
}

// 只输出 2 个成员以上的组，并去掉被更大组完全包含的小组
function buildDuplicateGroups(items) {
  const groups = new Map();
  const add = (key, label, item) => {
    const group = groups.get(key) || { key: key, label: label, members: [] };
    if (group.members.indexOf(item) < 0) group.members.push(item);
    groups.set(key, group);
  };
  items.forEach((item) => {
    const companyKey = masterGroupKey(item.company, true);
    if (companyKey) add('company:' + companyKey, item.company, item);
    const name = String(item.name || '').trim();
    if (name && name !== '未命名客户') {
      const nameKey = masterGroupKey(name, false);
      if (nameKey) add('name:' + nameKey, name, item);
    }
  });
  const list = Array.from(groups.values()).filter((group) => group.members.length > 1)
    .sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label));
  const kept = [];
  list.forEach((group) => {
    const uids = new Set(group.members.map((m) => m.uid));
    const contained = kept.some((big) => {
      if (big.members.length < group.members.length) return false;
      return Array.from(uids).every((uid) => big.members.some((m) => m.uid === uid));
    });
    if (!contained) kept.push(group);
  });
  return kept.slice(0, 50).map((group) => ({
    key: group.key, label: group.label,
    members: group.members.map((m) => ({
      uid: m.uid, name: m.name, company: m.company, country: m.country,
      customer_count: m.customer_ids.length, inquiry_count: m.inquiry_count,
      completeness: m.completeness.percent, dnc: m.dnc, merged_uids: m.merged_uids,
    })),
  }));
}

// 行规范化：必须有 platform_id；payload 原样保留；时间去非法值即置空
function normalizeRows(input) {
  if (!Array.isArray(input)) throw new HttpError(400, 'rows_required', 'rows 必须是数组');
  if (input.length > MAX_ROWS_PER_PART) throw new HttpError(413, 'too_many_rows', '单个分片最多 ' + MAX_ROWS_PER_PART + ' 行');
  const map = new Map();
  input.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'row_invalid', '第 ' + (i + 1) + ' 行不是对象');
    const platformId = String(raw.platform_id === undefined || raw.platform_id === null ? '' : raw.platform_id).trim();
    if (!platformId) throw new HttpError(400, 'platform_id_required', '第 ' + (i + 1) + ' 行缺少 platform_id');
    if (platformId.length > 200) throw new HttpError(400, 'platform_id_too_long', 'platform_id 超过 200 字符');
    const payload = raw.payload === undefined ? {} : raw.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'payload_invalid', '第 ' + (i + 1) + ' 行 payload 必须是对象');
    map.set(platformId, {
      platform_id: platformId,
      payload: payload,
      business_at: parseTime(raw.business_at),
      observed_at: parseTime(raw.observed_at) || new Date().toISOString(),
    });
  });
  return Array.from(map.values());
}

function route(method, pathname) {
  if (method === 'GET' && pathname === '/health') return { name: 'health' };
  // 扩展自动更新：只暴露 releases 目录下的固定文件，不做目录映射
  if (method === 'GET' && pathname === '/extension/version.json') return { name: 'extensionVersion' };
  if (method === 'GET' && pathname === '/extension/latest.zip') return { name: 'extensionPackage' };
  if (method === 'GET' && (pathname === '/' || pathname === '/dashboard')) return { name: 'static', file: 'data.html' };
  if (method === 'GET' && pathname === '/data-quality') return { name: 'static', file: 'quality.html' };
  if (method === 'GET' && pathname === '/business') return { name: 'static', file: 'business.html' };
  if (method === 'GET' && pathname === '/data-assets') return { name: 'static', file: 'assets.html' };
  if (method === 'GET' && pathname === '/master-data') return { name: 'static', file: 'master.html' };
  // 旧的业务工作台保留为 /workbench，仅作过渡，不再出现在导航
  if (method === 'GET' && pathname === '/workbench') return { name: 'static', file: 'index.html' };
  if (method === 'GET' && pathname === '/admin') return { name: 'static', file: 'admin.html' };
  if (method === 'GET' && pathname === '/agents') return { name: 'static', file: 'agents.html' };
  if (method === 'GET' && pathname === '/console') return { name: 'static', file: 'console.html' };
  if (method === 'GET' && pathname === '/assets/app.js') return { name: 'static', file: 'app.js' };
  if (method === 'GET' && pathname === '/assets/data-common.js') return { name: 'static', file: 'data-common.js' };
  if (method === 'GET' && pathname === '/assets/data.js') return { name: 'static', file: 'data.js' };
  if (method === 'GET' && pathname === '/assets/business.js') return { name: 'static', file: 'business.js' };
  if (method === 'GET' && pathname === '/assets/quality.js') return { name: 'static', file: 'quality.js' };
  if (method === 'GET' && pathname === '/assets/assets.js') return { name: 'static', file: 'assets.js' };
  if (method === 'GET' && pathname === '/assets/master.js') return { name: 'static', file: 'master.js' };
  if (method === 'GET' && pathname === '/assets/admin.js') return { name: 'static', file: 'admin.js' };
  if (method === 'GET' && pathname === '/assets/agents.js') return { name: 'static', file: 'agents.js' };
  if (method === 'GET' && pathname === '/assets/style.css') return { name: 'static', file: 'style.css' };
  if (method === 'GET' && pathname === '/assets/shell.css') return { name: 'static', file: 'shell.css' };
  if (method === 'GET' && pathname === '/assets/shell.js') return { name: 'static', file: 'shell.js' };
  if (method === 'GET' && pathname === '/api/employees') return { name: 'employees' };
  if (method === 'POST' && pathname === '/api/employees') return { name: 'employeeCreate' };
  if (method === 'GET' && pathname === '/api/alibaba-accounts') return { name: 'alibabaAccounts' };
  if (method === 'POST' && pathname === '/api/alibaba-accounts') return { name: 'alibabaAccountCreate' };
  const aliAccount = /^\/api\/alibaba-accounts\/([^/]+)$/.exec(pathname);
  if (aliAccount && method === 'PATCH') return { name: 'alibabaAccountUpdate', id: aliAccount[1] };
  if (aliAccount && method === 'DELETE') return { name: 'alibabaAccountDelete', id: aliAccount[1] };
  const emp = /^\/api\/employees\/([^/]+)$/.exec(pathname);
  if (emp && method === 'PATCH') return { name: 'employeeUpdate', id: emp[1] };
  if (emp && method === 'DELETE') return { name: 'employeeDelete', id: emp[1] };
  if (method === 'GET' && pathname === '/api/agents') return { name: 'agents' };
  if (method === 'POST' && pathname === '/api/agents') return { name: 'agentCreate' };
  const agentSub = /^\/api\/agents\/([^/]+)\/(assign|assignments|unassign)$/.exec(pathname);
  if (agentSub) {
    if (agentSub[2] === 'assign' && method === 'POST') return { name: 'agentAssign', id: agentSub[1] };
    if (agentSub[2] === 'assignments' && method === 'GET') return { name: 'agentAssignments', id: agentSub[1] };
    if (agentSub[2] === 'unassign' && method === 'POST') return { name: 'agentUnassign', id: agentSub[1] };
  }
  const agent = /^\/api\/agents\/([^/]+)$/.exec(pathname);
  if (agent && method === 'PATCH') return { name: 'agentUpdate', id: agent[1] };
  if (agent && method === 'DELETE') return { name: 'agentDelete', id: agent[1] };
  if (method === 'GET' && pathname === '/api/tasks') return { name: 'tasks' };
  if (method === 'POST' && pathname === '/api/tasks') return { name: 'taskCreate' };
  if (method === 'GET' && pathname === '/api/review-queue') return { name: 'reviewQueue' };
  if (method === 'GET' && pathname === '/api/ops/overview') return { name: 'opsOverview' };
  if (method === 'GET' && pathname === '/api/platform/ai') return { name: 'platformAi' };
  if (method === 'POST' && pathname === '/api/threads') return { name: 'threadCreate' };
  if (method === 'GET' && pathname === '/api/threads') return { name: 'threads' };
  const turnReq = /^\/api\/threads\/([^/]+)\/turn$/.exec(pathname);
  if (turnReq && method === 'POST') return { name: 'threadTurn', id: turnReq[1] };
  const threadReq = /^\/api\/threads\/([^/]+)$/.exec(pathname);
  if (threadReq && method === 'GET') return { name: 'thread', id: threadReq[1] };
  if (method === 'GET' && pathname === '/api/escalations') return { name: 'escalations' };
  const escResolve = /^\/api\/escalations\/([^/]+)\/resolve$/.exec(pathname);
  if (escResolve && method === 'POST') return { name: 'escalationResolve', id: escResolve[1] };
  const sugGen = /^\/api\/agents\/([^/]+)\/suggestions$/.exec(pathname);
  if (sugGen && method === 'POST') return { name: 'agentSuggest', id: sugGen[1] };
  if (method === 'GET' && pathname === '/api/suggestions') return { name: 'suggestions' };
  const sugDecide = /^\/api\/suggestions\/([^/]+)\/(accept|reject)$/.exec(pathname);
  if (sugDecide && method === 'POST') {
    return { name: sugDecide[2] === 'accept' ? 'suggestionAccept' : 'suggestionReject', id: sugDecide[1] };
  }
  if (method === 'GET' && pathname === '/api/executions') return { name: 'executions' };
  if (method === 'GET' && pathname === '/api/send-control') return { name: 'sendControl' };
  if (method === 'PUT' && pathname === '/api/send-control') return { name: 'sendControlUpdate' };
  if (method === 'GET' && pathname === '/api/dnc') return { name: 'dnc' };
  if (method === 'POST' && pathname === '/api/dnc') return { name: 'dncAdd' };
  if (method === 'DELETE' && pathname === '/api/dnc') return { name: 'dncDelete' };
  if (method === 'GET' && pathname === '/api/dataset') return { name: 'dataset' };
  if (method === 'POST' && pathname === '/api/heartbeat') return { name: 'heartbeat' };
  if (method === 'GET' && pathname === '/api/freshness') return { name: 'freshness' };
  if (pathname === '/api/collector/cookies' && method === 'POST') return { name: 'collectorCookiesSave' };
  if (pathname === '/api/collector/cookies' && method === 'GET') return { name: 'collectorCookiesGet' };
  if (method === 'GET' && pathname === '/api/collector/accounts') return { name: 'collectorAccounts' };
  const execResult = /^\/api\/executions\/([^/]+)\/result$/.exec(pathname);
  if (execResult && method === 'POST') return { name: 'executionResult', id: execResult[1] };
  const execClaim = /^\/api\/executions\/([^/]+)\/claim$/.exec(pathname);
  if (execClaim && method === 'POST') return { name: 'executionClaim', id: execClaim[1] };
  const taskItems = /^\/api\/tasks\/([^/]+)\/items$/.exec(pathname);
  if (taskItems && method === 'GET') return { name: 'taskItems', id: taskItems[1] };
  const itemDraft = /^\/api\/task-items\/([^/]+)\/draft$/.exec(pathname);
  if (itemDraft && method === 'POST') return { name: 'taskItemDraft', id: itemDraft[1] };
  const item = /^\/api\/task-items\/([^/]+)$/.exec(pathname);
  if (item && method === 'GET') return { name: 'taskItem', id: item[1] };
  if (item && method === 'PATCH') return { name: 'taskItemUpdate', id: item[1] };
  if (method === 'GET' && pathname === '/dashboard/summary') return { name: 'summary' };
  if (method === 'GET' && pathname === '/api/overview') return { name: 'overview' };
  if (method === 'PATCH' && pathname === '/api/todo-decisions') return { name: 'todoDecision' };
  if (method === 'GET' && pathname === '/api/inquiries') return { name: 'inquiries' };
  // 数据中台 P0：待办、客户档案、经营指标、发送前门禁
  if (method === 'GET' && pathname === '/api/todos') return { name: 'todos' };
  if (method === 'GET' && pathname === '/api/customer-profile') return { name: 'customerProfile' };
  if (method === 'GET' && pathname === '/api/metrics/overview') return { name: 'metricsOverview' };
  if (method === 'POST' && pathname === '/api/send-check') return { name: 'sendCheck' };
  // 数据中台 P1：数据资产字典与主数据合并
  if (method === 'GET' && pathname === '/api/data-assets') return { name: 'dataAssets' };
  if (method === 'GET' && pathname === '/api/master-data') return { name: 'masterData' };
  if (method === 'POST' && pathname === '/api/master-data/merge') return { name: 'masterMerge' };
  if (method === 'POST' && pathname === '/api/master-data/unmerge') return { name: 'masterUnmerge' };
  // 数据中台 P2：API 网关与权限审计
  if (method === 'GET' && pathname === '/api/gateway/overview') return { name: 'gatewayOverview' };
  if (method === 'GET' && pathname === '/api/gateway/catalog') return { name: 'gatewayCatalog' };
  if (method === 'GET' && pathname === '/api/gateway/clients') return { name: 'gatewayClients' };
  if (method === 'POST' && pathname === '/api/gateway/clients') return { name: 'gatewayClientCreate' };
  const gwClient = /^\/api\/gateway\/clients\/([^/]+)$/.exec(pathname);
  if (gwClient && method === 'PATCH') return { name: 'gatewayClientUpdate', id: gwClient[1] };
  if (gwClient && method === 'DELETE') return { name: 'gatewayClientDelete', id: gwClient[1] };
  const gwRotate = /^\/api\/gateway\/clients\/([^/]+)\/rotate$/.exec(pathname);
  if (gwRotate && method === 'POST') return { name: 'gatewayClientRotate', id: gwRotate[1] };
  if (method === 'GET' && pathname === '/api/gateway/calls') return { name: 'gatewayCalls' };
  if (method === 'GET' && pathname === '/api/audit') return { name: 'auditLog' };
  // 数据中台 P3：AI 智能体总览与运行审计
  if (method === 'GET' && pathname === '/api/ai/overview') return { name: 'aiOverview' };
  if (method === 'GET' && pathname === '/api/ai/runs') return { name: 'aiRuns' };
  // 经营总览：指标 + 身份 + 新鲜度 + AI 运营状态
  if (method === 'GET' && pathname === '/api/business/overview') return { name: 'businessOverview' };
  if (method === 'GET' && pathname === '/sync/status') return { name: 'status' };
  if (method === 'GET' && pathname === '/changes') return { name: 'changes' };
  if (method === 'POST' && pathname === '/imports') return { name: 'create' };
  if (method === 'POST' && pathname === '/auth/login') return { name: 'login' };
  if (method === 'GET' && pathname === '/auth/me') return { name: 'me' };
  if (method === 'POST' && pathname === '/auth/logout') return { name: 'logout' };
  const part = /^\/imports\/([^/]+)\/parts\/(\d+)$/.exec(pathname);
  if (method === 'PUT' && part) return { name: 'part', importId: part[1], partNo: Number(part[2]) };
  const commit = /^\/imports\/([^/]+)\/commit$/.exec(pathname);
  if (method === 'POST' && commit) return { name: 'commit', importId: commit[1] };
  return null;
}

async function serveStatic(res, file) {
  const type = STATIC[file];
  if (!type) return send(res, 404, { error: 'not_found', message: '页面不存在' });
  try {
    const buf = await fs.readFile(path.join(__dirname, '..', 'public', file));
    res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-cache' });
    res.end(buf);
  } catch (e) {
    send(res, 404, { error: 'not_found', message: '页面不存在' });
  }
}

// 扩展自动更新：从 releases 目录读取固定文件（可用 RELEASE_DIR 或容器卷覆盖）
const RELEASE_DIR = process.env.RELEASE_DIR || path.join(__dirname, '..', 'releases');
const RELEASE_FILES = {
  'version.json': { file: 'version.json', type: 'application/json; charset=utf-8' },
  'latest.zip': { file: 'latest.zip', type: 'application/zip' },
};
async function serveRelease(res, key) {
  const meta = RELEASE_FILES[key];
  if (!meta) return send(res, 404, { error: 'not_found', message: '发布文件不存在' });
  try {
    const buf = await fs.readFile(path.join(RELEASE_DIR, meta.file));
    res.writeHead(200, {
      'content-type': meta.type,
      'content-length': buf.length,
      'cache-control': 'no-store',
      'content-disposition': key === 'latest.zip' ? 'attachment; filename="tradepilot_extension_latest.zip"' : 'inline',
    });
    res.end(buf);
  } catch (e) {
    send(res, 404, { error: 'not_found', message: '发布文件不存在' });
  }
}

// API 令牌限流：单进程固定窗口，够用且不引入外部依赖
function createRateLimiter() {
  const hits = new Map();
  return function check(client) {
    const limit = Math.max(1, Number(client && client.rate_limit) || 120);
    const now = Date.now();
    const windowKey = Math.floor(now / 60000);
    let row = hits.get(client.id);
    if (!row || row.windowKey !== windowKey) {
      row = { windowKey: windowKey, count: 0 };
      hits.set(client.id, row);
    }
    row.count += 1;
    if (hits.size > 2000) {
      for (const [key, value] of hits.entries()) {
        if (value.windowKey < windowKey - 2) hits.delete(key);
      }
    }
    return {
      ok: row.count <= limit,
      limit: limit,
      remaining: Math.max(0, limit - row.count),
      retryAfter: row.count <= limit ? 0 : Math.max(1, 60 - Math.floor((now % 60000) / 1000)),
    };
  };
}

function createHandler(options) {
  const store = options.store;
  // 兼容：只给 token 时读写同权（本地测试/单令牌过渡）；生产建议分别给 ingest/read
  const tokens = {
    ingest: String(options.ingestToken || options.token || ''),
    read: String(options.readToken || options.token || ''),
  };
  const sellerId = options.sellerId || '';
  // 多店铺部署：SELLER_IDS 白名单；未配置时退化为 SELLER_ID 单店铺限制
  const allowedSellerIds = (Array.isArray(options.sellerIds) ? options.sellerIds : [])
    .map((item) => String(item || '').trim()).filter(Boolean);
  const tenantId = options.tenantId || 'default';
  const SESSION_DAYS = 30;
  const checkRate = createRateLimiter();

  function sellerAllowed(sid, ctx) {
    const target = String(sid || '').trim();
    if (!target) return false;
    // 员工自己的绑定店铺始终允许，避免白名单改动把现有账号锁死
    if (ctx && ctx.sellerId && target === ctx.sellerId) return true;
    if (allowedSellerIds.length) return allowedSellerIds.indexOf(target) >= 0;
    if (sellerId) return target === sellerId;
    return true;
  }

  function assertSellerAllowed(sid, ctx) {
    if (!sellerAllowed(sid, ctx)) {
      throw new HttpError(403, 'seller_not_allowed', '店铺 ' + sid + ' 不在当前部署的允许范围内');
    }
  }

  // 单店铺部署保持旧的 400 seller_locked 语义，多店铺部署按白名单校验
  function assertSellerAssignable(sid, ctx, message) {
    if (!allowedSellerIds.length && sellerId && sid !== sellerId) {
      throw new HttpError(400, 'seller_locked', message
        || ('当前部署固定店铺 ' + sellerId + '，店铺只能设为 ' + sellerId));
    }
    assertSellerAllowed(sid, ctx);
  }

  // 机器令牌（采集/只读）、API 令牌与员工会话都走这里，返回统一的权限上下文
  async function resolveAuth(given) {
    if (!given) return null;
    // 单令牌过渡期：两个令牌相同则读写同权，避免老部署升级后立刻不可用
    const sameToken = Boolean(tokens.ingest && tokens.read && tokens.ingest === tokens.read);
    if (tokens.ingest && safeEqual(given, tokens.ingest)) {
      return {
        kind: 'machine', role: sameToken ? 'machine' : 'ingest',
        canRead: sameToken, canWrite: true, canCollector: true,
        scopes: sameToken ? ['read', 'write', 'collector'] : ['write', 'collector'],
        sellerId: '', tenantId: tenantId,
      };
    }
    if (tokens.read && safeEqual(given, tokens.read)) {
      return {
        kind: 'machine', role: 'read', canRead: true, canWrite: false, canCollector: false,
        scopes: ['read'], sellerId: '', tenantId: tenantId,
      };
    }
    const hash = tokenHash(given);
    if (store.getApiClientByTokenHash) {
      const client = await store.getApiClientByTokenHash(hash);
      if (client && client.status === 'active') {
        const scopes = Array.isArray(client.scopes) ? client.scopes.map(String) : [];
        if (store.touchApiClient) store.touchApiClient(client.id).catch(() => {});
        return {
          kind: 'api', role: 'api',
          canRead: scopes.indexOf('read') >= 0,
          canWrite: scopes.indexOf('write') >= 0,
          canCollector: scopes.indexOf('collector') >= 0,
          scopes: scopes,
          client: {
            id: client.id, name: client.name, kind: client.kind,
            rate_limit: client.rate_limit, seller_id: client.seller_id,
          },
          sellerId: client.seller_id || '',
          tenantId: client.tenant_id || tenantId,
        };
      }
    }
    const s = await store.resolveSession(hash);
    if (!s) return null;
    return {
      kind: 'employee',
      role: s.role,
      canRead: true,
      canWrite: s.role !== 'viewer',
      canCollector: s.role === 'admin',
      scopes: employeeScopes(s.role),
      sellerId: s.seller_id || '',
      tenantId: s.tenant_id || tenantId,
      employee: { id: s.employee_id, name: s.name, email: s.email },
    };
  }

  // 会话/机器令牌/API 令牌可访问的店铺：显式 shop_id > 身份绑定 > 服务端默认，且不允许越界
  // 员工只能访问自己绑定的店铺；管理员与机器令牌可在白名单内跨店（用于采集器多账号与统一管理）
  function sellerOf(ctx, url) {
    const want = String(url.searchParams.get('seller_id') || '').trim();
    const own = ctx.sellerId || '';
    const sid = want || own || sellerId || '';
    if (!sid) throw new HttpError(400, 'seller_required', '缺少 seller_id');
    if (own && sid !== own && ctx.role !== 'admin') {
      throw new HttpError(403, 'seller_mismatch', '只允许访问当前账号绑定的店铺');
    }
    assertSellerAllowed(sid, ctx);
    return sid;
  }

  // 主数据：加载身份档案并叠加人工合并记录，供列表与合并校验共用
  async function loadMasterProfiles(tenant, sid) {
    const domain = require('./domain').loadDomain();
    const kinds = ['inquiry', 'customer', 'public_customer', 'chat', 'order'];
    const data = await store.rowsByKind(sid, kinds);
    kinds.forEach((kind) => { if (!Array.isArray(data[kind])) data[kind] = []; });
    const idx = domain.identity.build(data);
    const merges = await store.listMasterMerges(tenant, sid);
    const applied = applyMasterMerges(idx.profiles, merges);
    return {
      domain: domain, data: data, idx: idx, merges: merges,
      profiles: applied.profiles, byUid: applied.byUid, applied: applied.applied,
    };
  }

  // 主数据列表项：展示信息 + 完整度 + 关联计数 + 合并/DNC 标记
  function serializeMasterProfile(domain, profile, dncKeys, mergedUids) {
    const val = domain.analyze.val;
    const primary = profile.primaryCustomer || {};
    const display = profile.display === '未命名客户' ? '' : profile.display;
    const level = val(primary, '买家等级') || val(primary, '买家等级(字母)');
    const owner = val(primary, '负责人') || val(primary, '销售名');
    const email = val(primary, '邮箱') || val(primary, '电子邮件');
    const phone = val(primary, '手机') || val(primary, '电话') || val(primary, '联系电话');
    const fields = [
      ['公司名称', profile.company],
      ['国家/地区', profile.country],
      ['联系人', display],
      ['买家等级', level],
      ['负责人', owner],
      ['邮箱', email],
      ['电话', phone],
    ];
    const missing = fields.filter(([, value]) => !String(value || '').trim()).map(([label]) => label);
    const filled = fields.length - missing.length;
    // 主数据口径的“资料待补”：缺公司/联系人或没有任何联系方式，直接影响跟进与发送
    const incomplete = !String(profile.company || '').trim() || !display
      || (!String(email || '').trim() && !String(phone || '').trim());
    const dnc = (profile.customerIds || []).some((id) => dncKeys.has(String(id)))
      || (profile.inquiryIds || []).some((id) => dncKeys.has('inquiry:' + id) || dncKeys.has(String(id)));
    return {
      uid: profile.uid, name: profile.display, company: profile.company, country: profile.country,
      level: level, owner: owner,
      customer_ids: profile.customerIds || [], inquiry_count: (profile.inquiryIds || []).length,
      chat_count: profile.chatCount, chat_sessions: profile.chatSessions || [],
      sources: Array.from(profile.sources || []), aliases: profile.aliasList || [],
      mine: profile.mineCount, public: profile.publicCount,
      completeness: {
        total: fields.length, filled: filled,
        percent: Math.round((filled / fields.length) * 100), missing: missing,
      },
      incomplete: incomplete,
      dnc: dnc, merged_uids: mergedUids,
    };
  }

  return async function handler(req, res) {
    const started = Date.now();
    const requestId = String(req.headers['x-request-id'] || crypto.randomUUID());
    res.setHeader('x-request-id', requestId);
    const pathname = String(req.url || '/').split('?')[0];
    let callCtx = null;
    let shouldLogCall = false;
    // 关键操作审计：失败不影响主流程，避免审计库异常拖垮接口
    function recordAudit(ctx, action, target, detail) {
      if (!store.addAudit) return;
      const actor = ctx || {};
      store.addAudit({
        tenantId: actor.tenantId || tenantId,
        actorType: actor.kind || 'anonymous',
        actorId: actor.employee ? actor.employee.id : (actor.client ? actor.client.id : ''),
        actorName: actor.employee ? (actor.employee.email || actor.employee.name)
          : (actor.client ? actor.client.name : (actor.role || '')),
        action: action,
        target: String(target || '').slice(0, 300),
        detail: detail || {},
        ip: req.socket && req.socket.remoteAddress,
        requestId: requestId,
      }).catch(() => {});
    }
    res.on('finish', () => {
      log.info('http', {
        request_id: requestId,
        method: req.method,
        path: pathname,
        status: res.statusCode,
        ms: Date.now() - started,
        ip: req.socket && req.socket.remoteAddress,
      });
      // API 调用流水：只记数据接口，静态页与健康检查不进入网关统计
      if (shouldLogCall && store.logApiCall) {
        store.logApiCall({
          tenantId: (callCtx && callCtx.tenantId) || tenantId,
          clientId: callCtx ? callCtx.clientId : null,
          clientName: callCtx ? callCtx.clientName : '',
          actorType: callCtx ? callCtx.actorType : 'anonymous',
          method: req.method,
          path: pathname,
          status: res.statusCode,
          ms: Date.now() - started,
          ip: req.socket && req.socket.remoteAddress,
          requestId: requestId,
        }).catch(() => {});
      }
    });

    const url = new URL(req.url, 'http://localhost');
    const hit = route(req.method, url.pathname);
    if (!hit) return send(res, 404, { error: 'not_found', message: '接口不存在' });
    shouldLogCall = ['static', 'health', 'extensionVersion', 'extensionPackage'].indexOf(hit.name) < 0;
    if (hit.name === 'health') {
      const body = await healthPayload(store);
      return send(res, body.ok ? 200 : 503, body);
    }
    if (hit.name === 'static') return serveStatic(res, hit.file);
    if (hit.name === 'extensionVersion') return serveRelease(res, 'version.json');
    if (hit.name === 'extensionPackage') return serveRelease(res, 'latest.zip');

    const auth = String(req.headers.authorization || '');
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    try {
      // 登录：换 30 天会话令牌，扩展拿到后自动写入云端配置
      if (hit.name === 'login') {
        const body = await readJson(req, 64 * 1024);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (!email || !password) throw new HttpError(400, 'credentials_required', '缺少邮箱或密码');
        const emp = await store.findEmployeeByEmail(tenantId, email);
        if (!emp || emp.status !== 'active' || !verifyPassword(password, emp.password_hash)) {
          log.warn('login_failed', { request_id: requestId, email: email });
          recordAudit(null, 'auth.login_failed', email, {});
          throw new HttpError(401, 'invalid_credentials', '邮箱或密码不正确');
        }
        const member = await store.primaryMembership(emp.id);
        // 优先使用员工绑定的店铺；SELLER_ID 只作为没有成员关系时的兜底
        const seller = (member && member.seller_id) || sellerId || '';
        const token = newToken();
        const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
        await store.createSession({
          tokenHash: tokenHash(token), employeeId: emp.id, tenantId: tenantId,
          sellerId: seller, role: emp.role, expiresAt: expiresAt,
        });
        log.info('login_ok', { request_id: requestId, employee: emp.id, seller: seller });
        recordAudit({
          kind: 'employee', tenantId: tenantId,
          employee: { id: emp.id, email: emp.email, name: emp.name },
        }, 'auth.login', email, { role: emp.role, seller_id: seller });
        return send(res, 200, {
          token: token,
          expires_at: expiresAt,
          tenant_id: tenantId,
          seller_id: seller,
          employee: { id: emp.id, name: emp.name, email: emp.email, role: emp.role },
        });
      }

      const ctx = await resolveAuth(given);
      if (!ctx) {
        log.warn('auth_failed', { request_id: requestId, path: pathname, role: INGEST_ROUTES.has(hit.name) ? 'ingest' : 'read' });
        return send(res, 401, { error: 'unauthorized', message: '缺少或错误的令牌' });
      }
      callCtx = {
        tenantId: ctx.tenantId || tenantId,
        clientId: ctx.client ? ctx.client.id : null,
        clientName: ctx.client ? ctx.client.name
          : (ctx.employee ? (ctx.employee.email || ctx.employee.name) : (ctx.role || '')),
        actorType: ctx.kind,
      };
      // API 令牌：限流 + 禁止访问管理端
      if (ctx.kind === 'api') {
        const rl = checkRate(ctx.client || {});
        res.setHeader('x-ratelimit-limit', String(rl.limit));
        res.setHeader('x-ratelimit-remaining', String(rl.remaining));
        if (!rl.ok) {
          res.setHeader('retry-after', String(rl.retryAfter));
          return send(res, 429, {
            error: 'rate_limited', message: '调用频率超过限制，请稍后重试',
            retry_after: rl.retryAfter,
          });
        }
        if (ADMIN_ROUTES.indexOf(hit.name) >= 0) {
          return send(res, 403, { error: 'api_admin_forbidden', message: 'API 令牌不能访问管理接口' });
        }
      }
      if (INGEST_ROUTES.has(hit.name) && !ctx.canWrite) {
        return send(res, 403, { error: 'forbidden', message: '该身份没有写入权限' });
      }
      if (!INGEST_ROUTES.has(hit.name) && !ctx.canRead) {
        if (!(MACHINE_READ_ROUTES.has(hit.name) && (ctx.role === 'ingest' || ctx.canCollector))) {
          return send(res, 401, { error: 'unauthorized', message: '缺少或错误的令牌' });
        }
      }
      // 只读工作台可继续用令牌；会话可主动退出
      if (hit.name === 'me') {
        return send(res, 200, {
          employee: ctx.employee || null,
          role: ctx.role,
          kind: ctx.kind,
          scopes: ctx.scopes || [],
          client: ctx.client || null,
          tenant_id: ctx.tenantId,
          seller_id: ctx.sellerId || sellerId,
        });
      }
      if (hit.name === 'logout') {
        if (ctx.kind === 'employee') await store.deleteSession(tokenHash(given));
        return send(res, 200, { ok: true });
      }

      // ---------------- 员工账号管理（仅管理员） ----------------
      if (ADMIN_ROUTES.indexOf(hit.name) >= 0 && ctx.role !== 'admin') {
        throw new HttpError(403, 'admin_required', '仅管理员可访问管理接口');
      }
      if (hit.name === 'employees') {
        const rows = await store.listEmployees(ctx.tenantId || tenantId);
        return send(res, 200, { items: rows });
      }
      // ---------------- 阿里国际站账号注册表（仅管理员） ----------------
      if (hit.name === 'alibabaAccounts') {
        return send(res, 200, { items: await store.listAlibabaAccounts(ctx.tenantId || tenantId) });
      }
      if (hit.name === 'alibabaAccountCreate') {
        const tenant = ctx.tenantId || tenantId;
        const body = await readJson(req, 16 * 1024);
        const loginName = String(body.login_name || '').trim();
        if (!loginName) throw new HttpError(400, 'login_name_required', '请填写阿里登录名');
        if (loginName.length > 120) throw new HttpError(400, 'login_name_too_long', '阿里登录名最多 120 字');
        const accountType = String(body.account_type || 'sub').trim();
        if (['main', 'sub'].indexOf(accountType) < 0) {
          throw new HttpError(400, 'account_type_invalid', '账号类型只能是 main / sub');
        }
        const seller = String(body.seller_id || ctx.sellerId || sellerId || 'seller-main').trim();
        assertSellerAssignable(seller, ctx, '当前部署固定店铺 ' + sellerId + '，阿里账号店铺只能设为 ' + sellerId);
        if (await store.findAlibabaAccountByLogin(tenant, loginName)) {
          throw new HttpError(409, 'login_exists', '该阿里登录名已存在');
        }
        const account = await store.createAlibabaAccount({
          tenantId: tenant, sellerId: seller, loginName: loginName, accountType: accountType,
          ownerName: String(body.owner_name || '').trim(),
          displayName: String(body.display_name || '').trim(),
          note: String(body.note || '').slice(0, 300),
        });
        recordAudit(ctx, 'alibaba_account.create', loginName, {
          account_type: accountType, seller_id: seller, owner_name: account.owner_name,
        });
        return send(res, 201, { account: account });
      }
      if (hit.name === 'alibabaAccountUpdate') {
        if (!UUID_RE.test(String(hit.id))) throw new HttpError(404, 'account_not_found', '阿里账号不存在');
        const tenant = ctx.tenantId || tenantId;
        const body = await readJson(req, 16 * 1024);
        const patch = {};
        if (body.login_name !== undefined) {
          const loginName = String(body.login_name || '').trim();
          if (!loginName) throw new HttpError(400, 'login_name_required', '阿里登录名不能为空');
          if (loginName.length > 120) throw new HttpError(400, 'login_name_too_long', '阿里登录名最多 120 字');
          const exists = await store.findAlibabaAccountByLogin(tenant, loginName);
          if (exists && exists.id !== hit.id) throw new HttpError(409, 'login_exists', '该阿里登录名已存在');
          patch.loginName = loginName;
        }
        if (body.seller_id !== undefined) {
          const seller = String(body.seller_id || '').trim();
          if (!seller) throw new HttpError(400, 'seller_required', '店铺 ID 不能为空');
          assertSellerAssignable(seller, ctx, '当前部署固定店铺 ' + sellerId + '，阿里账号店铺只能设为 ' + sellerId);
          patch.sellerId = seller;
        }
        if (body.account_type !== undefined) {
          const accountType = String(body.account_type).trim();
          if (['main', 'sub'].indexOf(accountType) < 0) {
            throw new HttpError(400, 'account_type_invalid', '账号类型只能是 main / sub');
          }
          patch.accountType = accountType;
        }
        if (body.owner_name !== undefined) patch.ownerName = String(body.owner_name || '').trim();
        if (body.display_name !== undefined) patch.displayName = String(body.display_name || '').trim();
        if (body.note !== undefined) patch.note = String(body.note || '').slice(0, 300);
        if (body.status !== undefined) {
          const status = String(body.status);
          if (['active', 'disabled'].indexOf(status) < 0) {
            throw new HttpError(400, 'status_invalid', '状态只能是 active / disabled');
          }
          patch.status = status;
        }
        if (!Object.keys(patch).length) throw new HttpError(400, 'patch_required', '没有需要修改的字段');
        const account = await store.updateAlibabaAccount(Object.assign({
          tenantId: tenant, id: hit.id,
        }, patch));
        if (!account) throw new HttpError(404, 'account_not_found', '阿里账号不存在');
        recordAudit(ctx, 'alibaba_account.update', account.login_name, patch);
        return send(res, 200, { account: account });
      }
      if (hit.name === 'alibabaAccountDelete') {
        if (!UUID_RE.test(String(hit.id))) throw new HttpError(404, 'account_not_found', '阿里账号不存在');
        const removed = await store.deleteAlibabaAccount(ctx.tenantId || tenantId, hit.id);
        if (!removed) throw new HttpError(404, 'account_not_found', '阿里账号不存在');
        recordAudit(ctx, 'alibaba_account.delete', removed.login_name, {});
        return send(res, 200, { ok: true, login_name: removed.login_name });
      }
      if (hit.name === 'employeeCreate') {
        const body = await readJson(req, 64 * 1024);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const role = String(body.role || 'operator').trim();
        const name = String(body.name || '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'email_invalid', '邮箱格式不正确');
        if (password.length < 8) throw new HttpError(400, 'password_too_short', '密码至少 8 位');
        if (ROLES.indexOf(role) < 0) throw new HttpError(400, 'role_invalid', '角色只能是 admin / operator / viewer');
        if (await store.findEmployeeByEmail(tenantId, email)) throw new HttpError(409, 'email_exists', '该邮箱已存在');
        const rawAccountId = String(body.alibaba_account_id || '').trim();
        let account = null;
        if (rawAccountId) {
          if (!UUID_RE.test(rawAccountId)) throw new HttpError(400, 'alibaba_account_invalid', '阿里账号 ID 不合法');
          account = await store.getAlibabaAccount(ctx.tenantId || tenantId, rawAccountId);
          if (!account) throw new HttpError(404, 'alibaba_account_not_found', '阿里账号不存在');
        }
        const empSeller = account ? account.seller_id : String(body.seller_id || sellerId || 'seller-main').trim();
        assertSellerAssignable(empSeller, ctx, '当前部署固定店铺 ' + sellerId + '，员工店铺只能设为 ' + sellerId);
        const created = await store.createEmployee({
          tenantId: ctx.tenantId || tenantId, email: email, name: name,
          passwordHash: hashPassword(password), role: role,
        });
        await store.bindMembership({
          employeeId: created.id, tenantId: ctx.tenantId || tenantId,
          sellerId: empSeller, canIngest: body.can_ingest !== false,
        });
        if (account) await store.setEmployeeAlibabaAccount(ctx.tenantId || tenantId, created.id, account.id);
        created.alibaba_account_id = account ? account.id : null;
        log.info('employee_created', { request_id: requestId, email: email, role: role });
        recordAudit(ctx, 'employee.create', email, {
          role: role, seller_id: empSeller,
          alibaba_account_id: account ? account.id : null,
        });
        return send(res, 201, { employee: created });
      }
      if (hit.name === 'employeeUpdate') {
        const body = await readJson(req, 64 * 1024);
        const target = await store.getEmployee(tenantId, hit.id);
        if (!target) throw new HttpError(404, 'employee_not_found', '员工不存在');
        if (ctx.employee && ctx.employee.id === hit.id && String(body.status || '') === 'disabled') {
          throw new HttpError(400, 'cannot_disable_self', '不能停用当前登录的账号');
        }
        const password = String(body.password || '');
        if (password && password.length < 8) throw new HttpError(400, 'password_too_short', '密码至少 8 位');
        const role = body.role ? String(body.role).trim() : null;
        if (role && ROLES.indexOf(role) < 0) throw new HttpError(400, 'role_invalid', '角色不合法');
        const status = body.status ? String(body.status).trim() : null;
        if (status && STATUSES.indexOf(status) < 0) throw new HttpError(400, 'status_invalid', '状态只能是 active / disabled');

        let email;
        if (body.email !== undefined) {
          email = String(body.email || '').trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            throw new HttpError(400, 'email_invalid', '邮箱格式不正确');
          }
          if (email !== target.email) {
            const exists = await store.findEmployeeByEmail(tenantId, email);
            if (exists && exists.id !== target.id) throw new HttpError(409, 'email_exists', '该邮箱已被其他员工使用');
          }
        }
        let seller = null;
        if (body.seller_id !== undefined) {
          seller = String(body.seller_id || '').trim();
          if (!seller) throw new HttpError(400, 'seller_required', '店铺 ID 不能为空');
          if (seller.length > 120) throw new HttpError(400, 'seller_too_long', '店铺 ID 超过 120 字符');
          assertSellerAssignable(seller, ctx, '当前部署固定店铺 ' + sellerId + '，员工店铺只能设为 ' + sellerId);
        }
        let accountTouched = false;
        let accountId = null;
        if (body.alibaba_account_id !== undefined) {
          accountTouched = true;
          const rawAccountId = String(body.alibaba_account_id || '').trim();
          if (rawAccountId) {
            if (!UUID_RE.test(rawAccountId)) throw new HttpError(400, 'alibaba_account_invalid', '阿里账号 ID 不合法');
            const account = await store.getAlibabaAccount(tenantId, rawAccountId);
            if (!account) throw new HttpError(404, 'alibaba_account_not_found', '阿里账号不存在');
            assertSellerAssignable(account.seller_id, ctx, '当前部署固定店铺 ' + sellerId + '，阿里账号不属于当前店铺');
            if (seller !== null && seller !== account.seller_id) {
              throw new HttpError(400, 'seller_mismatch', '员工店铺与阿里账号店铺不一致');
            }
            seller = account.seller_id;
            accountId = account.id;
          }
        }
        // 不能把最后一个启用的管理员降级或停用
        if (target.role === 'admin' && ((role && role !== 'admin') || status === 'disabled')) {
          const all = await store.listEmployees(tenantId);
          const others = all.filter((e) => e.id !== target.id && e.role === 'admin' && e.status === 'active');
          if (!others.length) throw new HttpError(400, 'last_admin', '至少保留一个启用的管理员');
        }

        const updated = await store.updateEmployee({
          tenantId: tenantId, id: hit.id,
          name: body.name === undefined ? undefined : String(body.name).trim(),
          email: email,
          role: role, status: status,
          passwordHash: password ? hashPassword(password) : null,
        });
        if (!updated) throw new HttpError(404, 'employee_not_found', '员工不存在');
        if (updated.conflict) throw new HttpError(409, 'email_exists', '该邮箱已被其他员工使用');
        if (seller !== null) {
          if (store.setPrimaryMembership) {
            await store.setPrimaryMembership({ employeeId: hit.id, tenantId: tenantId, sellerId: seller });
          } else {
            await store.bindMembership({ employeeId: hit.id, tenantId: tenantId, sellerId: seller, canIngest: true });
          }
          updated.seller_id = seller;
        }
        if (accountTouched) {
          await store.setEmployeeAlibabaAccount(tenantId, hit.id, accountId);
          updated.alibaba_account_id = accountId;
        } else {
          updated.alibaba_account_id = target.alibaba_account_id || null;
        }
        // 角色/状态/密码/店铺/阿里账号变化后，旧会话立即失效，避免沿用旧权限或旧范围
        if ((role || status || password || seller !== null || accountTouched) && store.deleteSessionsByEmployee) {
          await store.deleteSessionsByEmployee(hit.id);
        }
        log.info('employee_updated', { request_id: requestId, employee: hit.id, role: role || '', status: status || '' });
        recordAudit(ctx, 'employee.update', target.email, {
          role: role || null, status: status || null, seller_id: seller,
          alibaba_account_id: accountTouched ? accountId : (target.alibaba_account_id || null),
          password_reset: Boolean(password),
        });
        return send(res, 200, { employee: updated });
      }
      if (hit.name === 'employeeDelete') {
        if (ctx.employee && ctx.employee.id === hit.id) throw new HttpError(400, 'cannot_delete_self', '不能删除当前登录的账号');
        const target = await store.getEmployee(tenantId, hit.id);
        if (!target) throw new HttpError(404, 'employee_not_found', '员工不存在');
        if (target.role === 'admin') {
          const all = await store.listEmployees(tenantId);
          const admins = all.filter((e) => e.role === 'admin' && e.status === 'active');
          if (admins.length <= 1) throw new HttpError(400, 'last_admin', '至少保留一个启用的管理员');
        }
        await store.deleteEmployee(tenantId, hit.id);
        log.info('employee_deleted', { request_id: requestId, email: target.email });
        recordAudit(ctx, 'employee.delete', target.email, { role: target.role });
        return send(res, 200, { ok: true, email: target.email });
      }

      // ---------------- 智能业务员 / 任务 / 草稿 ----------------
      if (hit.name === 'agents') {
        return send(res, 200, { items: await store.listAgents(sellerOf(ctx, url)) });
      }
      if (hit.name === 'agentCreate') {
        const body = await readJson(req, 64 * 1024);
        const name = String(body.name || '').trim();
        if (!name) throw new HttpError(400, 'name_required', '缺少业务员名称');
        const agentSeller = String(body.seller_id || ctx.sellerId || sellerId || 'seller-main').trim();
        assertSellerAllowed(agentSeller, ctx);
        const agent = await store.createAgent({
          tenantId: ctx.tenantId || tenantId,
          sellerId: agentSeller,
          name: name,
          persona: String(body.persona || ''),
          language: String(body.language || 'en'),
          dailyLimit: Number(body.daily_limit) || 20,
          cooldownHours: body.cooldown_hours === undefined ? 24 : Number(body.cooldown_hours),
          quietStart: String(body.quiet_start || '23:00'),
          quietEnd: String(body.quiet_end || '07:00'),
          tzOffsetMinutes: body.tz_offset_minutes === undefined ? 480 : Number(body.tz_offset_minutes),
          difyBaseUrl: '',
          difyAppKey: '',
          model: String(body.model || ''),
        });
        log.info('agent_created', { request_id: requestId, agent: agent.id });
        recordAudit(ctx, 'ai_agent.create', name, {
          daily_limit: agent.daily_limit, language: agent.language || 'en',
        });
        return send(res, 201, { agent: agent });
      }
      if (hit.name === 'agentUpdate') {
        const body = await readJson(req, 64 * 1024);
        const patch = {};
        if (body.name !== undefined) patch.name = String(body.name);
        if (body.persona !== undefined) patch.persona = String(body.persona);
        if (body.daily_limit !== undefined) patch.dailyLimit = Number(body.daily_limit) || 20;
        if (body.cooldown_hours !== undefined) patch.cooldownHours = Number(body.cooldown_hours);
        if (body.quiet_start !== undefined) patch.quietStart = String(body.quiet_start);
        if (body.quiet_end !== undefined) patch.quietEnd = String(body.quiet_end);
        if (body.tz_offset_minutes !== undefined) patch.tzOffsetMinutes = Number(body.tz_offset_minutes);
        if (body.language !== undefined) patch.language = String(body.language || 'en').slice(0, 20);
        if (body.model !== undefined) patch.model = String(body.model || '').slice(0, 120);
        if (body.status) patch.status = String(body.status);
        const agent = await store.updateAgent({ tenantId: tenantId, id: hit.id, patch: patch });
        if (!agent) throw new HttpError(404, 'agent_not_found', '业务员不存在');
        recordAudit(ctx, 'ai_agent.update', agent.name, patch);
        return send(res, 200, { agent: agent });
      }
      if (hit.name === 'agentDelete') {
        const removed = await store.deleteAgent(tenantId, hit.id);
        if (!removed) throw new HttpError(404, 'agent_not_found', '业务员不存在');
        recordAudit(ctx, 'ai_agent.delete', removed.name, {});
        return send(res, 200, { ok: true, name: removed.name });
      }
      if (hit.name === 'agentAssign') {
        const body = await readJson(req, 64 * 1024);
        const assigned = await store.assignCustomers({
          tenantId: ctx.tenantId || tenantId,
          sellerId: sellerOf(ctx, url),
          agentId: hit.id,
          filter: { country: body.country, source: body.source, replied: body.replied, grade: body.grade },
          limit: body.limit,
        });
        return send(res, 200, { assigned: assigned });
      }
      if (hit.name === 'agentAssignments') {
        return send(res, 200, { items: await store.listAssignments(hit.id, url.searchParams.get('limit')) });
      }
      if (hit.name === 'agentUnassign') {
        return send(res, 200, { removed: await store.unassignAll(hit.id) });
      }
      if (hit.name === 'tasks') {
        return send(res, 200, { items: await store.listTasks(sellerOf(ctx, url)) });
      }
      if (hit.name === 'taskCreate') {
        const body = await readJson(req, 64 * 1024);
        const sid = sellerOf(ctx, url);
        const agentId = String(body.agent_id || '');
        if (!agentId) throw new HttpError(400, 'agent_required', '缺少 agent_id');
        const agent = await store.getAgent(ctx.tenantId || tenantId, sid, agentId);
        if (!agent) throw new HttpError(404, 'agent_not_found', '业务员不存在');
        const task = await store.createTask({
          tenantId: ctx.tenantId || tenantId, sellerId: sid, agentId: agentId,
          playbookId: body.playbook_id || null,
          name: String(body.name || '首响任务'),
          dailyLimit: Number(body.daily_limit) || agent.daily_limit,
        });
        const items = await store.generateTaskItems({
          taskId: task.id, tenantId: ctx.tenantId || tenantId, sellerId: sid,
          agentId: agentId, playbookVersion: Number(body.playbook_version) || 1,
        });
        return send(res, 201, { task: task, items: items });
      }
      if (hit.name === 'taskItems') {
        return send(res, 200, { items: await store.listTaskItems(hit.id, url.searchParams.get('limit')) });
      }
      if (hit.name === 'taskItem') {
        const item = await store.getTaskItem(hit.id);
        if (!item) throw new HttpError(404, 'item_not_found', '任务项不存在');
        return send(res, 200, { item: item, runs: await store.listRunsByItem(hit.id, 5) });
      }
      if (hit.name === 'taskItemUpdate') {
        const body = await readJson(req, 64 * 1024);
        const state = body.state ? String(body.state) : null;
        if (state && ['pending', 'drafted', 'review_required', 'approved', 'cancelled', 'sent', 'failed'].indexOf(state) < 0) {
          throw new HttpError(400, 'state_invalid', '状态不合法');
        }
        const item = await store.updateTaskItem(hit.id, {
          state: state,
          draftText: body.draft_text === undefined ? undefined : String(body.draft_text),
        });
        if (!item) throw new HttpError(404, 'item_not_found', '任务项不存在');
        return send(res, 200, { item: item });
      }
      if (hit.name === 'taskItemDraft') {
        const item = await store.getTaskItem(hit.id);
        if (!item) throw new HttpError(404, 'item_not_found', '任务项不存在');
        const agent = await store.getAgent(ctx.tenantId || tenantId, item.seller_id, item.agent_id);
        if (!agent) throw new HttpError(404, 'agent_not_found', '业务员不存在');
        try {
          const out = await generateDraft({
            store: store, agent: agent, item: item, payload: item.payload || {},
            tenantId: ctx.tenantId || tenantId, sellerId: item.seller_id,
          });
          recordAudit(ctx, 'ai.draft', item.id, {
            guard: out.guard, citations: (out.citations || []).length, model: out.model || '',
          });
          return send(res, 200, out);
        } catch (e) {
          throw new HttpError(502, 'draft_failed', String((e && e.message) || e));
        }
      }

      // ---------------- 运营台：平台 AI 状态 / 总览 / 待人工 ----------------
      if (hit.name === 'platformAi') {
        const cfg = difyConfig();
        return send(res, 200, {
          dify: { configured: Boolean(cfg.apiKey), base_url: cfg.baseUrl, scope: 'platform-shared' },
          guard_rules: GUARD_RULES.map((r) => ({ code: r.code, label: r.label, level: r.level })),
        });
      }
      if (hit.name === 'opsOverview') {
        const sid = sellerOf(ctx, url);
        return send(res, 200, {
          seller_id: sid,
          generated_at: new Date().toISOString(),
          counts: await store.opsCounts(sid),
        });
      }
      if (hit.name === 'reviewQueue') {
        const sid = sellerOf(ctx, url);
        return send(res, 200, {
          seller_id: sid,
          items: await store.reviewQueue(sid, url.searchParams.get('limit')),
        });
      }

      // ---------------- 会话运行时 / 升级单 / 分配建议 ----------------
      if (hit.name === 'threadCreate') {
        const body = await readJson(req, 64 * 1024);
        const sid = sellerOf(ctx, url);
        const agentId = String(body.agent_id || '');
        const customerKey = String(body.customer_key || '').trim();
        if (!agentId || !customerKey) throw new HttpError(400, 'params_required', '需要 agent_id 与 customer_key');
        const agent = await store.getAgent(ctx.tenantId || tenantId, sid, agentId);
        if (!agent) throw new HttpError(404, 'agent_not_found', '业务员不存在');
        const thread = await store.getOrCreateThread({
          tenantId: ctx.tenantId || tenantId, sellerId: sid, agentId: agentId,
          customerKey: customerKey, channel: body.channel || 'inquiry', subject: String(body.subject || ''),
        });
        return send(res, 201, { thread: thread });
      }
      if (hit.name === 'threads') {
        return send(res, 200, {
          items: await store.listThreads(sellerOf(ctx, url), url.searchParams.get('status') || '', url.searchParams.get('limit')),
        });
      }
      if (hit.name === 'thread') {
        const thread = await store.getThread(hit.id);
        if (!thread) throw new HttpError(404, 'thread_not_found', '会话不存在');
        return send(res, 200, { thread: thread, messages: await store.listMessages(hit.id, url.searchParams.get('limit')) });
      }
      if (hit.name === 'threadTurn') {
        const body = await readJson(req, 64 * 1024);
        const thread = await store.getThread(hit.id);
        if (!thread) throw new HttpError(404, 'thread_not_found', '会话不存在');
        const agent = await store.getAgent(ctx.tenantId || tenantId, thread.seller_id, thread.agent_id);
        if (!agent) throw new HttpError(404, 'agent_not_found', '业务员不存在');
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        const emit = (event, data) => {
          res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
        };
        res.write(': connected\n\n');
        try {
          const out = await runTurn({
            store: store, agent: agent, thread: thread,
            text: body.text ? String(body.text) : null, trigger: 'message', emit: emit,
            customer: thread.customer || {},
          });
          emit('guard', { level: out.guard.level, risks: out.guard.risks });
          emit('done', {
            run_id: out.run_id, escalation: out.escalation, citations: out.citations,
            model: out.model, latency_ms: out.latency_ms,
            state: out.escalation ? 'waiting_human' : 'open',
          });
        } catch (e) {
          emit('error', { message: String((e && e.message) || e) });
        }
        return res.end();
      }
      if (hit.name === 'escalations') {
        return send(res, 200, {
          items: await store.listEscalations(sellerOf(ctx, url), url.searchParams.get('status') || '', url.searchParams.get('limit')),
        });
      }
      if (hit.name === 'escalationResolve') {
        const body = await readJson(req, 64 * 1024);
        const resolution = String(body.resolution || '').trim();
        if (!resolution) throw new HttpError(400, 'resolution_required', '请填写人工结论');
        const esc = await store.getEscalation(hit.id);
        if (!esc) throw new HttpError(404, 'escalation_not_found', '升级单不存在');
        if (esc.status !== 'open') throw new HttpError(409, 'escalation_closed', '该升级单已处理');
        try {
          const out = await resumeAfterEscalation({
            store: store, escalation: esc, resolution: resolution,
            resolvedBy: ctx.employee ? ctx.employee.id : null,
          });
          recordAudit(ctx, 'ai.escalation_resolve', esc.id, { guard: out.guard });
          return send(res, 200, { ok: true, draft: out.draft, guard: out.guard, escalation: out.escalation });
        } catch (e) {
          throw new HttpError(502, 'resume_failed', String((e && e.message) || e));
        }
      }
      if (hit.name === 'agentSuggest') {
        const sid = sellerOf(ctx, url);
        const agent = await store.getAgent(ctx.tenantId || tenantId, sid, hit.id);
        if (!agent) throw new HttpError(404, 'agent_not_found', '业务员不存在');
        let body = {};
        try { body = await readJson(req, 64 * 1024); } catch (e) { body = {}; }
        return send(res, 200, await suggestForAgent({ store: store, agent: agent, limit: body.limit }));
      }
      if (hit.name === 'suggestions') {
        return send(res, 200, {
          items: await store.listSuggestions(sellerOf(ctx, url), url.searchParams.get('status') || 'pending', url.searchParams.get('limit')),
        });
      }
      if (hit.name === 'suggestionAccept') {
        const row = await store.acceptSuggestion(hit.id);
        if (!row) throw new HttpError(404, 'suggestion_not_found', '建议不存在或已处理');
        recordAudit(ctx, 'ai.suggestion_accept', row.customer_key, {});
        return send(res, 200, { ok: true, customer_key: row.customer_key });
      }
      if (hit.name === 'suggestionReject') {
        const row = await store.rejectSuggestion(hit.id);
        if (!row) throw new HttpError(404, 'suggestion_not_found', '建议不存在或已处理');
        recordAudit(ctx, 'ai.suggestion_reject', row.customer_key, {});
        return send(res, 200, { ok: true });
      }

      if (hit.name === 'collectorAccounts') {
        if (ctx.role !== 'ingest' && ctx.role !== 'admin' && !ctx.canCollector) {
          throw new HttpError(403, 'forbidden', '仅采集令牌、管理员或具备 collector 范围的 API 令牌可读取账号列表');
        }
        const tenant = ctx.tenantId || tenantId;
        const states = await store.listCollectorStates(tenant);
        const accounts = await store.listAlibabaAccounts(tenant);
        const bySeller = {};
        accounts.forEach((account) => {
          if (account.seller_id && !bySeller[account.seller_id]) bySeller[account.seller_id] = account;
        });
        const items = states
          .filter((row) => sellerAllowed(row.seller_id, ctx))
          .map((row) => {
            const account = bySeller[row.seller_id] || {};
            return {
              seller_id: row.seller_id,
              updated_at: row.updated_at,
              login_name: account.login_name || '',
              account_type: account.account_type || '',
              owner_name: account.owner_name || '',
              display_name: account.display_name || '',
            };
          });
        return send(res, 200, { items: items });
      }

      if (hit.name === 'collectorCookiesSave') {
        const body = await readJson(req, 4 * 1024 * 1024);
        const cookies = Array.isArray(body.cookies) ? body.cookies : [];
        if (!cookies.length) throw new HttpError(400, 'cookies_required', '缺少 cookies');
        await store.saveCollectorState({
          tenantId: ctx.tenantId || tenantId,
          sellerId: sellerOf(ctx, url),
          cookies: seal(JSON.stringify(cookies)),
        });
        log.info('collector_state_saved', { request_id: requestId, count: cookies.length });
        return send(res, 200, { ok: true, count: cookies.length });
      }
      if (hit.name === 'collectorCookiesGet') {
        if (ctx.role !== 'ingest' && ctx.role !== 'admin' && !ctx.canCollector) {
          throw new HttpError(403, 'forbidden', '仅采集令牌、管理员或具备 collector 范围的 API 令牌可读取登录态');
        }
        const sid = sellerOf(ctx, url);
        const row = await store.getCollectorState(ctx.tenantId || tenantId, sid);
        if (!row) throw new HttpError(404, 'collector_state_missing', '还没有导入登录态');
        let cookies = [];
        try { cookies = JSON.parse(openSecret(row.cookies)); } catch (e) {
          throw new HttpError(500, 'collector_state_broken', '登录态解密失败');
        }
        return send(res, 200, { cookies: cookies, updated_at: row.updated_at });
      }

      if (hit.name === 'heartbeat') {
        const body = await readJson(req, 64 * 1024);
        const sid = sellerOf(ctx, url);
        await store.upsertHeartbeat({
          tenantId: ctx.tenantId || tenantId,
          sellerId: sid,
          clientId: String(body.client_id || 'default').slice(0, 64),
          version: String(body.version || ''),
          queueRows: Number(body.queue_rows) || 0,
          counts: body.counts || {},
          lastUploadAt: body.last_upload_at || null,
        });
        return send(res, 200, { ok: true, server_time: new Date().toISOString(), fresh_minutes: 30, delayed_minutes: 120 });
      }
      if (hit.name === 'freshness') {
        const sid = sellerOf(ctx, url);
        const [sources, cloudCounts, clients] = await Promise.all([
          store.syncStatus(sid), store.countsByKind(sid), store.listHeartbeats(sid),
        ]);
        const now = Date.now();
        const kinds = sources.map((s) => {
          const age = s.last_success_at ? Math.max(0, Math.round((now - Date.parse(s.last_success_at)) / 60000)) : null;
          const tier = !s.rows ? 'empty' : age === null ? 'unknown' : age <= 30 ? 'fresh' : age <= 120 ? 'delayed' : 'stale';
          return {
            kind: s.kind, rows: s.rows, last_success_at: s.last_success_at,
            last_business_at: s.last_business_at, age_minutes: age, tier: tier,
          };
        });
        const list = clients.map((c) => {
          const local = c.counts || {};
          const missing = {};
          Object.keys(local).forEach((k) => {
            const diff = Number(local[k] || 0) - Number(cloudCounts[k] || 0);
            if (diff > 0) missing[k] = diff;
          });
          return {
            client_id: c.client_id, version: c.version, queue_rows: c.queue_rows,
            last_seen_at: c.updated_at, last_upload_at: c.last_upload_at,
            local_counts: local, missing: missing,
          };
        });
        return send(res, 200, {
          seller_id: sid, generated_at: new Date().toISOString(),
          thresholds: { fresh_minutes: 30, delayed_minutes: 120 },
          cloud_counts: cloudCounts, kinds: kinds, clients: list,
        });
      }
      if (hit.name === 'dataset') {
        const sid = sellerOf(ctx, url);
        const kinds = String(url.searchParams.get('kinds') || '')
          .split(',').map((s) => s.trim()).filter((k) => KINDS.has(k));
        if (!kinds.length) throw new HttpError(400, 'kinds_required', '需要 kinds 参数');
        const rows = await store.rowsByKindAll(sid, kinds, url.searchParams.get('limit'));
        const datasets = {};
        kinds.forEach((k) => { datasets[k] = []; });
        rows.forEach((r) => {
          if (!datasets[r.kind]) return;
          datasets[r.kind].push(Object.assign({}, r.payload, {
            __file__: '云端', __mtime__: r.updated_at,
          }));
        });
        return send(res, 200, { seller_id: sid, source: 'cloud', datasets: datasets });
      }
      if (hit.name === 'sendControl') {
        const sid = sellerOf(ctx, url);
        const control = await store.getSellerControl(ctx.tenantId || tenantId, sid);
        return send(res, 200, { seller_id: sid, control: control });
      }
      if (hit.name === 'sendControlUpdate') {
        const body = await readJson(req, 8 * 1024);
        if (typeof body.paused !== 'boolean') {
          throw new HttpError(400, 'paused_required', 'paused 必须是 true 或 false');
        }
        const sid = sellerOf(ctx, url);
        const control = await store.setSellerControl({
          tenantId: ctx.tenantId || tenantId, sellerId: sid,
          paused: body.paused, reason: body.reason,
          actorId: ctx.employee ? ctx.employee.email : '',
        });
        log.info('send_control_updated', { request_id: requestId, seller: sid, paused: body.paused });
        recordAudit(ctx, 'send_control.update', sid, { paused: !!body.paused, reason: body.reason || '' });
        return send(res, 200, { seller_id: sid, control: control });
      }
      if (hit.name === 'dnc') {
        const sid = sellerOf(ctx, url);
        const items = await store.listDnc(ctx.tenantId || tenantId, sid, {
          activeOnly: String(url.searchParams.get('active') || '1') !== '0',
          limit: url.searchParams.get('limit'),
        });
        return send(res, 200, { seller_id: sid, items: items });
      }
      if (hit.name === 'dncAdd') {
        const body = await readJson(req, 8 * 1024);
        const customerKey = String(body.customer_key || '').trim();
        if (!customerKey) throw new HttpError(400, 'customer_key_required', '缺少 customer_key');
        if (customerKey.length > 200) throw new HttpError(400, 'customer_key_too_long', 'customer_key 超过 200 字符');
        const until = body.until ? parseTime(body.until) : null;
        if (body.until && !until) throw new HttpError(400, 'until_invalid', 'until 不是合法时间');
        const sid = sellerOf(ctx, url);
        const item = await store.upsertDnc({
          tenantId: ctx.tenantId || tenantId, sellerId: sid,
          customerKey: customerKey, reason: body.reason, until: until,
        });
        log.info('dnc_added', { request_id: requestId, seller: sid, key: customerKey });
        recordAudit(ctx, 'dnc.add', customerKey, { until: until || null, reason: body.reason || '' });
        return send(res, 201, { seller_id: sid, item: item });
      }
      if (hit.name === 'dncDelete') {
        const sid = sellerOf(ctx, url);
        const customerKey = String(url.searchParams.get('customer_key') || '').trim();
        if (!customerKey) throw new HttpError(400, 'customer_key_required', '缺少 customer_key');
        const removed = await store.deleteDnc(ctx.tenantId || tenantId, sid, customerKey);
        log.info('dnc_removed', { request_id: requestId, seller: sid, key: customerKey, removed: removed });
        recordAudit(ctx, 'dnc.remove', customerKey, { removed: removed });
        return send(res, 200, { seller_id: sid, removed: removed });
      }
      if (hit.name === 'executions') {
        const sid = sellerOf(ctx, url);
        const items = await store.listExecutions(sid, url.searchParams.get('limit'));
        const control = await store.getSellerControl(ctx.tenantId || tenantId, sid);
        const now = Date.now();
        // 各业务员可能配置不同时区，统计窗口按最早的当天起点取，方向偏严格（宁可少发）
        const since = items.reduce((min, it) => {
          const start = startOfLocalDay(now, it.tz_offset_minutes);
          return min === null ? start : Math.min(min, start);
        }, null);
        const stats = items.length && store.executionStats
          ? await store.executionStats(sid, new Date(since || now).toISOString())
          : { byAgent: {}, byCustomer: {} };
        const list = items.map((it) => {
          const gate = evaluate({
            agent: {
              daily_limit: it.daily_limit, cooldown_hours: it.cooldown_hours,
              quiet_start: it.quiet_start, quiet_end: it.quiet_end,
              status: it.agent_status, tz_offset_minutes: it.tz_offset_minutes,
            },
            sentToday: stats.byAgent[it.agent_id] || 0,
            lastSentAt: stats.byCustomer[it.customer_key] || null,
            nowMs: now,
            dnc: { active: !!it.dnc_active, reason: it.dnc_reason },
            storePaused: !!control.send_paused,
            storePauseReason: control.pause_reason,
          });
          return {
            id: it.id, customer_key: it.customer_key, draft_text: it.draft_text,
            customer_name: it.customer_name, country: it.country, subject: it.subject,
            inquiry_id: it.inquiry_id, agent_id: it.agent_id, agent_name: it.agent_name,
            attempts: it.attempts, updated_at: it.updated_at, gate: gate,
          };
        });
        return send(res, 200, {
          items: list,
          allowed_count: list.filter((x) => x.gate.allowed).length,
          blocked_count: list.filter((x) => !x.gate.allowed).length,
          store_paused: !!control.send_paused,
          store_pause_reason: control.pause_reason || '',
          server_time: new Date(now).toISOString(),
        });
      }
      if (hit.name === 'executionClaim') {
        // 领取前再算一次闸门：排队期间可能已经触顶、进入静默时段或该客户仍在冷却
        const raw = await store.getTaskItem(hit.id);
        if (!raw) throw new HttpError(404, 'execution_not_found', '执行项不存在');
        const sid = String(raw.seller_id || sellerOf(ctx, url));
        if (raw.state === 'sent') throw new HttpError(409, 'already_sent', '这一条已经发送成功');
        // sending 状态交给存储层判断租约：过期可抢占，未过期返回 claimed_by_other
        if (String(raw.state) !== 'approved' && String(raw.state) !== 'sending') {
          throw new HttpError(409, 'not_claimable', '当前状态不可发送：' + raw.state);
        }
        const agentRow = store.getAgent ? await store.getAgent(raw.tenant_id, sid, raw.agent_id) : null;
        const now = Date.now();
        const tenant = raw.tenant_id || ctx.tenantId || tenantId;
        const control = await store.getSellerControl(tenant, sid);
        const dncRow = await store.getDnc(tenant, sid, raw.customer_key);
        // 强制复核：无论业务员配置是否完整，停机与 DNC 都必须在领取前拦住
        const safety = evaluate({
          agent: agentRow || {},
          sentToday: 0, lastSentAt: null, nowMs: now,
          dnc: { active: !!dncRow, reason: dncRow && dncRow.reason },
          storePaused: !!control.send_paused,
          storePauseReason: control.pause_reason,
        });
        const safetyReasons = safety.reasons.filter((r) => r.code === 'dnc' || r.code === 'store_paused');
        if (safetyReasons.length) {
          return send(res, 409, {
            error: 'gate_blocked', message: safetyReasons.map((r) => r.label).join('；'),
            reasons: safetyReasons, gate: safety,
          });
        }
        let gate = null;
        if (agentRow && store.executionStats && String(raw.state) === 'approved') {
          const since = startOfLocalDay(now, agentRow.tz_offset_minutes);
          const stats = await store.executionStats(sid, new Date(since).toISOString());
          gate = evaluate({
            agent: agentRow,
            sentToday: stats.byAgent[raw.agent_id] || 0,
            lastSentAt: stats.byCustomer[raw.customer_key] || null,
            nowMs: now,
            dnc: { active: !!dncRow, reason: dncRow && dncRow.reason },
            storePaused: !!control.send_paused,
            storePauseReason: control.pause_reason,
          });
          if (!gate.allowed) {
            return send(res, 409, {
              error: 'gate_blocked', message: gate.reasons.map((r) => r.label).join('；'),
              reasons: gate.reasons, gate: gate,
            });
          }
        }
        const body = await readJson(req, 8 * 1024);
        const claimed = await store.claimExecution(hit.id, {
          clientId: body.client_id || '', leaseSeconds: body.lease_seconds,
        });
        if (!claimed.ok) {
          const code = claimed.code || 'not_claimable';
          const status = code === 'execution_not_found' ? 404 : 409;
          const messages = {
            already_sent: '这一条已经发送成功',
            claimed_by_other: '另一个客户端正在发送，请稍后重试',
            store_paused: '店铺发送已停机，云端拒绝领取',
            dnc_blocked: '客户在不联系名单，云端拒绝领取',
          };
          throw new HttpError(status, code, messages[code] || '当前状态不可领取');
        }
        log.info('execution_claimed', { request_id: requestId, item: hit.id, client: body.client_id || '' });
        return send(res, 200, {
          ok: true, id: claimed.item.id, claim_token: claimed.claim_token,
          expires_at: claimed.expires_at, customer_key: claimed.item.customer_key,
          draft_text: claimed.item.draft_text, gate: gate,
        });
      }
      if (hit.name === 'executionResult') {
        const body = await readJson(req, 64 * 1024);
        const status = String(body.status || 'sent');
        if (status !== 'sent' && status !== 'failed' && status !== 'uncertain') {
          throw new HttpError(400, 'status_invalid', '状态只能是 sent / failed / uncertain');
        }
        const row = await store.markExecution(hit.id, {
          status: status, note: body.note, platformMsgId: body.platform_msg_id,
        });
        if (!row) throw new HttpError(404, 'execution_not_found', '执行项不存在');
        if (row.conflict) {
          throw new HttpError(409, 'status_conflict', '当前状态为 ' + row.current + '，未改动');
        }
        log.info('execution_result', { request_id: requestId, item: row.id, status: status, idempotent: !!row.idempotent });
        return send(res, 200, { ok: true, id: row.id, state: status, idempotent: !!row.idempotent });
      }

      if (hit.name === 'create') {
        const body = await readJson(req);
        const kind = String(body.kind || '').trim();
        if (!KINDS.has(kind)) throw new HttpError(400, 'unsupported_kind', '不支持的数据类型：' + (kind || '(空)'));
        const restricted = ctx.sellerId || '';
        const sid = String(body.seller_id || restricted || sellerId || '').trim();
        if (!sid) throw new HttpError(400, 'seller_required', '缺少 seller_id');
        if (restricted && sid !== restricted && ctx.role !== 'admin') {
          throw new HttpError(403, 'seller_mismatch', '只允许写入当前账号绑定的店铺');
        }
        // 单店铺部署保持旧错误码，便于既有扩展与测试识别
        if (!allowedSellerIds.length && sellerId && sid !== sellerId) {
          throw new HttpError(403, 'seller_mismatch', '只允许写入已配置的店铺');
        }
        assertSellerAllowed(sid, ctx);
        const batch = await store.createBatch({ tenantId: ctx.tenantId || tenantId, sellerId: sid, kind, meta: body.meta || {} });
        return send(res, 201, { import_id: batch.id, status: batch.status, created_at: batch.created_at });
      }

      if (hit.name === 'part') {
        if (!Number.isInteger(hit.partNo) || hit.partNo < 1) throw new HttpError(400, 'part_no_invalid', '分片号必须是从 1 开始的整数');
        const body = await readJson(req);
        const rows = normalizeRows(body.rows);
        if (!rows.length) throw new HttpError(400, 'rows_required', '分片不能为空');
        // 校验和基于客户端原始 rows 计算，重传同一份内容时可识别为重复
        const checksum = String(body.checksum || crypto.createHash('sha256').update(JSON.stringify(body.rows)).digest('hex'));
        const r = await store.putPart({ batchId: hit.importId, partNo: hit.partNo, checksum, rows });
        return send(res, 200, { part_no: hit.partNo, row_count: r.row_count, duplicate: r.duplicate });
      }

      if (hit.name === 'commit') {
        const result = await store.commit(hit.importId);
        return send(res, 200, Object.assign({ import_id: hit.importId, status: 'committed' }, result));
      }

      if (hit.name === 'overview') {
        const sid = sellerOf(ctx, url);
        const summary = await store.summary(sid);
        const rows = await store.rowsByKind(sid, ['inquiry', 'customer', 'public_customer', 'chat'], { sinceDays: 90 });
        let home = null;
        try {
          home = require('./domain').loadDomain().analyze.home(rows);
        } catch (e) {
          home = null;
        }
        const rawTodos = home ? home.todos.map((todo) => ({ ...todo, id: todoId(todo) })) : [];
        const decisions = home ? await store.listTodoDecisions(ctx.tenantId || tenantId, sid, rawTodos.map((todo) => todo.id)) : [];
        const decided = new Set(decisions.map((row) => row.todo_id));
        const visibleTodos = rawTodos.filter((todo) => !decided.has(todo.id));
        return send(res, 200, {
          seller_id: sid,
          generated_at: new Date().toISOString(),
          summary: { totals: summary.totals, sources: summary.sources, gaps: summary.gaps },
          home: home ? {
            as_of: home.asOf,
            headline: home.headline,
            kpi: home.kpi.map((item) => item[0] === 'P0 待办'
              ? [item[0], visibleTodos.filter((todo) => todo.level === 'P0').length, item[2]] : item),
            identity: home.identity,
            todo_count: visibleTodos.length,
            todos: visibleTodos.slice(0, 10),
            resolved_count: decisions.length,
            resolved: decisions,
          } : null,
          domain_unavailable: !home,
        });
      }

      if (hit.name === 'todoDecision') {
        if (ctx.kind !== 'employee' || !ctx.canWrite) throw new HttpError(403, 'employee_write_required', '仅员工可处理待办');
        const sid = sellerOf(ctx, url);
        const body = await readJson(req, 8 * 1024);
        const id = String(body.id || '').trim();
        const state = String(body.state || '').trim();
        const note = String(body.note || '').trim();
        if (!/^[0-9a-f]{64}$/.test(id)) throw new HttpError(400, 'todo_id_invalid', '待办 ID 不合法');
        if (!['done', 'dismissed', 'open'].includes(state)) throw new HttpError(400, 'state_invalid', '状态只能是 done / dismissed / open');
        if (note.length > 500) throw new HttpError(400, 'note_too_long', '备注最多 500 字');
        let title = '';
        if (state !== 'open') {
          const rows = await store.rowsByKind(sid, ['inquiry', 'customer', 'public_customer', 'chat'], { sinceDays: 90 });
          const home = require('./domain').loadDomain().analyze.home(rows);
          const matched = home.todos.find((todo) => todoId(todo) === id && todo.key !== 'none');
          if (!matched) throw new HttpError(404, 'todo_not_found', '待办已变化，请刷新后重试');
          title = matched.title;
        }
        await store.setTodoDecision({ tenantId: ctx.tenantId || tenantId, sellerId: sid,
          todoId: id, state, note, title, actorId: ctx.employee.id });
        recordAudit(ctx, 'todo.decision', id, { state: state });
        return send(res, 200, { ok: true, id, state });
      }

      if (hit.name === 'inquiries') {
        const sid = sellerOf(ctx, url);
        const result = await store.listInquiries({
          sellerId: sid,
          page: url.searchParams.get('page'),
          pageSize: url.searchParams.get('pageSize'),
          q: url.searchParams.get('q') || '',
          country: url.searchParams.get('country') || '',
          source: url.searchParams.get('source') || '',
          added: url.searchParams.get('added') || '',
          grade: url.searchParams.get('grade') || '',
        });
        const items = result.rows.map((row) => {
          const p = row.payload || {};
          return {
            id: row.platform_id,
            business_at: row.business_at,
            updated_at: row.updated_at,
            name: p['客户名称'] || '',
            company: p['公司名称'] || '',
            country: p['国家'] || '',
            source: p['来源'] || '',
            grade: p['买家等级'] || p['买家等级(字母)'] || '',
            added: p['是否已加为客户'] || '',
            subject: p['询盘主题'] || '',
            created_at: p['创建时间'] || '',
            replied: p['回复状态'] || '',
          };
        });
        return send(res, 200, { seller_id: sid, total: result.total, page: result.page, pageSize: result.pageSize, items: items });
      }

      if (hit.name === 'summary') {
        const sid = sellerOf(ctx, url);
        const summary = await store.summary(sid);
        return send(res, 200, summary);
      }

      // ---------- 数据中台 P0：待办 / 客户档案 / 经营指标 / 发送门禁 ----------
      if (hit.name === 'todos') {
        const sid = sellerOf(ctx, url);
        const rows = await store.rowsByKind(sid, ['inquiry', 'customer', 'public_customer', 'chat'], { sinceDays: 90 });
        const home = require('./domain').loadDomain().analyze.home(rows);
        const raw = (home.todos || []).filter((todo) => todo.key !== 'none')
          .map((todo) => ({ ...todo, id: todoId(todo) }));
        const decisions = await store.listTodoDecisions(ctx.tenantId || tenantId, sid, raw.map((todo) => todo.id));
        const decisionMap = new Map(decisions.map((row) => [row.todo_id, row]));
        const employee = String(url.searchParams.get('employee') || '').trim();
        const status = String(url.searchParams.get('status') || 'open');
        let items = raw.map((todo) => {
          const decided = decisionMap.get(todo.id);
          return { ...todo, status: decided ? decided.state : 'open',
            decided_at: decided ? decided.updated_at : null, note: decided ? decided.note : '' };
        });
        if (employee) {
          const want = employee.toLowerCase();
          items = items.filter((todo) => !todo.owner || String(todo.owner).toLowerCase().includes(want));
        }
        if (status === 'open') items = items.filter((todo) => todo.status === 'open');
        else if (status === 'done' || status === 'dismissed') items = items.filter((todo) => todo.status === status);
        const summary = await store.summary(sid);
        return send(res, 200, {
          ok: true, seller_id: sid, employee, status,
          counts: {
            total: raw.length,
            open: raw.length - decisions.length,
            done: decisions.filter((row) => row.state === 'done').length,
            dismissed: decisions.filter((row) => row.state === 'dismissed').length,
          },
          todos: items,
          data_version: latestSync(summary),
          generated_at: new Date().toISOString(),
          freshness: summary.sources,
        });
      }

      if (hit.name === 'customerProfile') {
        const sid = sellerOf(ctx, url);
        const uid = String(url.searchParams.get('uid') || '').trim();
        if (!uid) throw new HttpError(400, 'uid_required', '需要 uid 参数');
        const domain = require('./domain').loadDomain();
        const data = await store.rowsByKind(sid, ['inquiry', 'customer', 'public_customer', 'chat', 'order']);
        ['inquiry', 'customer', 'public_customer', 'chat', 'order'].forEach((kind) => {
          if (!Array.isArray(data[kind])) data[kind] = [];
        });
        const idx = domain.identity.build(data);
        const merges = await store.listMasterMerges(ctx.tenantId || tenantId, sid);
        const applied = applyMasterMerges(idx.profiles, merges);
        let targetUid = uid;
        let profile = applied.byUid.get(targetUid);
        if (!profile) {
          const row = merges.find((merge) => String(merge.merged_uid) === uid);
          if (row) {
            targetUid = String(row.primary_uid);
            profile = applied.byUid.get(targetUid);
          }
        }
        if (!profile) throw new HttpError(404, 'profile_not_found', '客户档案不存在');
        const uidSet = new Set([targetUid]);
        merges.forEach((merge) => {
          if (String(merge.primary_uid) === targetUid) uidSet.add(String(merge.merged_uid));
        });
        const val = domain.analyze.val;
        const primary = profile.primaryCustomer || {};
        const norm = (v) => String(v === undefined || v === null ? '' : v).toLowerCase()
          .replace(/\s+/g, '').replace(/[.,，。()（）"'&·-]/g, '');
        const aliases = new Set([profile.display, profile.company].concat(profile.aliasList || [])
          .map(norm).filter(Boolean));
        const inquiryRows = data.inquiry
          .filter((row) => uidSet.has(idx.uidOfInquiry(row)))
          .sort((a, b) => String(val(b, '创建时间') || '').localeCompare(String(val(a, '创建时间') || '')));
        const inquiries = inquiryRows.slice(0, 10).map((row) => ({
          id: val(row, '询盘ID'), subject: val(row, '询盘主题'), product: val(row, '咨询产品'),
          created_at: val(row, '创建时间'), country: val(row, '国家'), source: val(row, '来源'),
          grade: val(row, '买家等级'), replied: val(row, '回复状态'), owner: val(row, '负责人'),
        }));
        const orders = data.order.filter((row) => {
          const keys = [val(row, '客户名称'), val(row, '公司名称')].map(norm).filter(Boolean);
          return keys.some((key) => aliases.has(key));
        }).sort((a, b) => String(val(b, '下单时间') || val(b, '创建时间') || '')
          .localeCompare(String(val(a, '下单时间') || val(a, '创建时间') || '')));
        const level = val(primary, '买家等级') || (inquiries[0] && inquiries[0].grade) || '';
        const owner = val(primary, '负责人') || val(primary, '销售名') || (inquiries[0] && inquiries[0].owner) || '';
        const fields = [
          ['公司名称', profile.company],
          ['国家/地区', profile.country],
          ['联系人', profile.display],
          ['买家等级', level],
          ['负责人', owner],
          ['邮箱', val(primary, '邮箱') || val(primary, '电子邮件')],
          ['电话', val(primary, '手机') || val(primary, '电话') || val(primary, '联系电话')],
        ];
        const missing = fields.filter(([, value]) => !String(value || '').trim()).map(([label]) => label);
        const filled = fields.length - missing.length;
        let dnc = null;
        const dncKeys = [];
        if (profile.customerIds[0]) dncKeys.push(String(profile.customerIds[0]));
        if (profile.inquiryIds[0]) dncKeys.push('inquiry:' + String(profile.inquiryIds[0]));
        for (const key of dncKeys) {
          try {
            const row = await store.getDnc(ctx.tenantId || tenantId, sid, key);
            if (row && dncActive(row, Date.now())) {
              dnc = { key, reason: row.reason || '', until: row.until || '' };
              break;
            }
          } catch (e) { /* 没有 DNC 记录 */ }
        }
        const summary = await store.summary(sid);
        return send(res, 200, {
          ok: true, seller_id: sid,
          profile: {
            uid: targetUid, name: profile.display, company: profile.company, country: profile.country,
            level, owner,
            sources: Array.from(profile.sources || []),
            aliases: profile.aliasList || [],
            customer_ids: profile.customerIds || [],
            inquiry_count: profile.inquiryIds.length,
            chat_sessions: profile.chatSessions || [],
            chat_count: profile.chatCount,
            last_chat: profile.lastChat || '',
            merged_uids: Array.from(uidSet).filter((item) => item !== targetUid),
            completeness: { total: fields.length, filled, percent: Math.round((filled / fields.length) * 100), missing },
            fields: fields.map(([label, value]) => ({ label, value: value || '' })),
            dnc,
          },
          inquiries,
          orders: orders.slice(0, 10).map((row) => ({
            id: val(row, '订单ID'), amount: val(row, '成交金额'), currency: val(row, '币种'),
            status: val(row, '订单状态'), at: val(row, '下单时间') || val(row, '创建时间'), match: 'name',
          })),
          order_count: orders.length,
          data_version: latestSync(summary),
          generated_at: new Date().toISOString(),
          freshness: summary.sources,
        });
      }

      if (hit.name === 'metricsOverview') {
        const sid = sellerOf(ctx, url);
        const owner = String(url.searchParams.get('owner') || '').trim();
        const domain = require('./domain').loadDomain();
        const data = await store.rowsByKind(sid, ['inquiry', 'customer', 'public_customer', 'order', 'visitor']);
        ['inquiry', 'customer', 'public_customer', 'order', 'visitor'].forEach((kind) => {
          if (!Array.isArray(data[kind])) data[kind] = [];
        });
        if (owner) {
          const want = owner.toLowerCase();
          const match = (value) => String(value || '').toLowerCase().includes(want);
          data.inquiry = data.inquiry.filter((row) => match(domain.analyze.val(row, '负责人')));
          data.customer = data.customer.filter((row) => match(domain.analyze.val(row, '负责人'))
            || match(domain.analyze.val(row, '销售名')));
          data.public_customer = data.public_customer.filter((row) => match(domain.analyze.val(row, '负责人'))
            || match(domain.analyze.val(row, '销售名')));
        }
        const overview = domain.analyze.storeOverview(data);
        const summary = await store.summary(sid);
        return send(res, 200, {
          ok: true, seller_id: sid, owner: owner || '全部',
          ...overview,
          data_version: latestSync(summary),
          generated_at: new Date().toISOString(),
          freshness: summary.sources,
        });
      }

      if (hit.name === 'sendCheck') {
        const sid = sellerOf(ctx, url);
        const body = await readJson(req, 16 * 1024);
        const customerKey = String(body.customer_key || '').trim();
        if (!customerKey) throw new HttpError(400, 'customer_key_required', '需要 customer_key');
        const now = Date.now();
        const tenant = ctx.tenantId || tenantId;
        const control = await store.getSellerControl(tenant, sid);
        const dncRow = await store.getDnc(tenant, sid, customerKey);
        let agentRow = null;
        if (body.agent_id && store.getAgent) agentRow = await store.getAgent(tenant, sid, String(body.agent_id));
        let sentToday = 0;
        let lastSentAt = null;
        if (agentRow && agentRow.id && store.executionStats) {
          const since = startOfLocalDay(now, agentRow.tz_offset_minutes);
          const stats = await store.executionStats(sid, new Date(since).toISOString());
          sentToday = stats.byAgent[agentRow.id] || 0;
          lastSentAt = stats.byCustomer[customerKey] || null;
        }
        const gate = evaluate({
          agent: agentRow || {}, sentToday, lastSentAt, nowMs: now,
          dnc: { active: dncActive(dncRow, now), reason: dncRow && dncRow.reason },
          storePaused: !!control.send_paused, storePauseReason: control.pause_reason,
        });
        const summary = await store.summary(sid);
        return send(res, 200, {
          ok: true, seller_id: sid, customer_key: customerKey,
          allowed: gate.allowed, reasons: gate.reasons, gate,
          data_version: latestSync(summary), generated_at: new Date().toISOString(),
        });
      }

      // ---------- 数据中台 P1：数据资产字典 / 主数据 ----------
      if (hit.name === 'dataAssets') {
        const sid = sellerOf(ctx, url);
        const kind = String(url.searchParams.get('kind') || 'inquiry').trim();
        if (!KINDS.has(kind)) throw new HttpError(400, 'kind_invalid', 'kind 不在数据源范围内');
        const sampleSize = Math.min(Math.max(Number(url.searchParams.get('sample')) || 500, 1), 5000);
        const rowLimit = Math.min(Math.max(Number(url.searchParams.get('rows')) || 20, 1), 100);
        const data = await store.rowsByKind(sid, [kind]);
        const all = Array.isArray(data[kind]) ? data[kind] : [];
        // 等距抽样：避免只看到最早写入的一批数据
        const step = all.length > sampleSize ? all.length / sampleSize : 1;
        const sample = [];
        for (let i = 0; i < all.length && sample.length < sampleSize; i += step) {
          sample.push(all[Math.floor(i)]);
        }
        const stat = new Map();
        sample.forEach((row) => {
          Object.keys(row || {}).forEach((key) => {
            // 双下划线是采集器附带的内部元数据，不作为业务字段展示
            if (key.indexOf('__') === 0) return;
            const cur = stat.get(key) || { key: key, filled: 0, example: '' };
            const raw = row[key];
            let textValue = '';
            if (raw !== undefined && raw !== null) {
              textValue = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
            }
            const text = textValue.trim();
            if (text && text !== '-') {
              cur.filled += 1;
              if (!cur.example) cur.example = text.length > 80 ? text.slice(0, 80) + '…' : text;
            }
            stat.set(key, cur);
          });
        });
        const fields = Array.from(stat.values()).map((f) => ({
          key: f.key, filled: f.filled,
          ratio: sample.length ? Math.round((f.filled / sample.length) * 1000) / 10 : 0,
          example: f.example,
        })).sort((a, b) => b.ratio - a.ratio || a.key.localeCompare(b.key));
        const sources = await store.syncStatus(sid);
        const summary = await store.summary(sid);
        const fresh = sources.find((src) => src.kind === kind)
          || { kind: kind, rows: 0, batches: 0, last_success_at: null, last_business_at: null };
        return send(res, 200, {
          ok: true, seller_id: sid, kind: kind,
          total: all.length, sample_size: sample.length,
          fields: fields, rows: sample.slice(0, rowLimit),
          kinds: sources.map((src) => ({
            kind: src.kind, rows: src.rows, batches: src.batches,
            last_success_at: src.last_success_at, last_business_at: src.last_business_at,
          })),
          freshness: fresh,
          data_version: latestSync(summary),
          generated_at: new Date().toISOString(),
        });
      }

      if (hit.name === 'masterData') {
        const sid = sellerOf(ctx, url);
        const tenant = ctx.tenantId || tenantId;
        const filter = String(url.searchParams.get('filter') || 'all');
        if (['all', 'duplicates', 'incomplete'].indexOf(filter) < 0) {
          throw new HttpError(400, 'filter_invalid', 'filter 只能是 all / duplicates / incomplete');
        }
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
        const pack = await loadMasterProfiles(tenant, sid);
        const dncItems = await store.listDnc(tenant, sid, { activeOnly: true, limit: 500 });
        const dncKeys = new Set(dncItems.map((row) => String(row.customer_key)));
        const mergedByPrimary = new Map();
        pack.applied.filter((row) => row.status === 'applied').forEach((row) => {
          const key = String(row.primary_uid);
          const list = mergedByPrimary.get(key) || [];
          list.push(String(row.merged_uid));
          mergedByPrimary.set(key, list);
        });
        const nameOf = new Map(pack.idx.profiles.map((profile) => [profile.uid, profile.display]));
        const items = pack.profiles.map((profile) => serializeMasterProfile(
          pack.domain, profile, dncKeys, mergedByPrimary.get(profile.uid) || [],
        ));
        const incomplete = items.filter((item) => item.incomplete).length;
        const groups = buildDuplicateGroups(items);
        const groupUids = new Set();
        groups.forEach((group) => group.members.forEach((member) => groupUids.add(member.uid)));
        let list = filter === 'duplicates' ? items.filter((item) => groupUids.has(item.uid))
          : filter === 'incomplete' ? items.filter((item) => item.incomplete)
            : items;
        if (q) {
          list = list.filter((item) => [item.name, item.company, item.country]
            .concat(item.aliases || [])
            .some((value) => String(value || '').toLowerCase().indexOf(q) >= 0));
        }
        const sorted = list.slice().sort((a, b) => b.merged_uids.length - a.merged_uids.length
          || (filter === 'incomplete' ? a.completeness.percent - b.completeness.percent : 0)
          || b.inquiry_count - a.inquiry_count
          || String(a.name).localeCompare(String(b.name)));
        const summary = await store.summary(sid);
        return send(res, 200, {
          ok: true, seller_id: sid, filter: filter, q: q,
          summary: {
            profiles: items.length,
            identity_profiles: pack.idx.stats.profiles,
            duplicate_groups: groups.length,
            unlinked_chats: pack.idx.chatOnly.length,
            incomplete: incomplete,
            merges: pack.merges.length,
          },
          total: sorted.length,
          profiles: sorted.slice(0, limit),
          duplicate_groups: groups,
          merges: pack.applied.map((row) => ({
            primary_uid: row.primary_uid, merged_uid: row.merged_uid,
            primary_name: nameOf.get(String(row.primary_uid)) || '',
            merged_name: nameOf.get(String(row.merged_uid)) || '',
            note: row.note || '', actor_id: row.actor_id || '',
            created_at: row.created_at, status: row.status,
          })),
          data_version: latestSync(summary),
          generated_at: new Date().toISOString(),
        });
      }

      if (hit.name === 'masterMerge') {
        const sid = sellerOf(ctx, url);
        const body = await readJson(req, 8 * 1024);
        const primaryUid = String(body.primary_uid || '').trim();
        const mergedUid = String(body.merged_uid || '').trim();
        if (!primaryUid || !mergedUid) throw new HttpError(400, 'uid_required', '需要 primary_uid 与 merged_uid');
        if (primaryUid === mergedUid) throw new HttpError(400, 'same_uid', '主档案与被合并档案不能相同');
        if (primaryUid.length > 300 || mergedUid.length > 300) throw new HttpError(400, 'uid_too_long', 'uid 超过 300 字符');
        const tenant = ctx.tenantId || tenantId;
        const pack = await loadMasterProfiles(tenant, sid);
        if (!pack.idx.byUid.has(primaryUid)) throw new HttpError(404, 'primary_not_found', '主档案不存在');
        if (!pack.idx.byUid.has(mergedUid)) throw new HttpError(404, 'merged_not_found', '被合并档案不存在');
        const mergedSet = new Set(pack.merges.map((row) => String(row.merged_uid)));
        const primarySet = new Set(pack.merges.map((row) => String(row.primary_uid)));
        if (mergedSet.has(primaryUid)) throw new HttpError(409, 'primary_merged', '该档案已并入其他档案，请选择主档案');
        if (primarySet.has(mergedUid) || mergedSet.has(mergedUid)) {
          throw new HttpError(409, 'merge_conflict', '该档案已有合并关系，请先取消合并');
        }
        const row = await store.upsertMasterMerge({
          tenantId: tenant, sellerId: sid, primaryUid: primaryUid, mergedUid: mergedUid,
          note: String(body.note || '').slice(0, 200),
          actorId: ctx.employee ? ctx.employee.email : ctx.role,
        });
        log.info('master_merge_saved', { request_id: requestId, seller: sid, primary: primaryUid, merged: mergedUid });
        recordAudit(ctx, 'master.merge', primaryUid + ' <= ' + mergedUid, { note: row.note || '' });
        return send(res, 201, { ok: true, merge: row });
      }

      if (hit.name === 'masterUnmerge') {
        const sid = sellerOf(ctx, url);
        const body = await readJson(req, 8 * 1024);
        const mergedUid = String(body.merged_uid || '').trim();
        if (!mergedUid) throw new HttpError(400, 'merged_uid_required', '需要 merged_uid');
        const removed = await store.deleteMasterMerge(ctx.tenantId || tenantId, sid, mergedUid);
        if (!removed) throw new HttpError(404, 'merge_not_found', '没有找到该合并记录');
        log.info('master_merge_removed', { request_id: requestId, seller: sid, merged: mergedUid });
        recordAudit(ctx, 'master.unmerge', mergedUid, {});
        return send(res, 200, { ok: true, merge: removed });
      }

      // ---------- 数据中台 P2：API 网关与权限审计 ----------
      if (hit.name === 'gatewayOverview') {
        const tenant = ctx.tenantId || tenantId;
        const callsSince = new Date(Date.now() - 24 * 3600000).toISOString();
        const auditSince = new Date(Date.now() - 7 * 86400000).toISOString();
        const [clients, calls, auditTotal] = await Promise.all([
          store.listApiClients(tenant),
          store.apiCallStats(tenant, callsSince),
          store.countAudit(tenant, auditSince),
        ]);
        const byKind = {};
        clients.forEach((client) => {
          byKind[client.kind] = (byKind[client.kind] || 0) + 1;
        });
        return send(res, 200, {
          ok: true, generated_at: new Date().toISOString(),
          clients: {
            total: clients.length,
            active: clients.filter((client) => client.status === 'active').length,
            by_kind: byKind,
          },
          calls: Object.assign({ window_hours: 24 }, calls),
          audit: { window_days: 7, total: auditTotal },
          legacy: {
            ingest_configured: Boolean(tokens.ingest),
            read_configured: Boolean(tokens.read),
            shared: Boolean(tokens.ingest && tokens.read && tokens.ingest === tokens.read),
          },
        });
      }

      if (hit.name === 'gatewayCatalog') {
        return send(res, 200, { ok: true, scopes: API_SCOPES, kinds: API_CLIENT_KINDS, groups: API_CATALOG });
      }

      if (hit.name === 'gatewayClients') {
        return send(res, 200, { items: await store.listApiClients(ctx.tenantId || tenantId) });
      }

      if (hit.name === 'gatewayClientCreate') {
        const body = await readJson(req, 8 * 1024);
        const name = String(body.name || '').trim();
        if (!name) throw new HttpError(400, 'name_required', '请填写令牌名称');
        if (name.length > 80) throw new HttpError(400, 'name_too_long', '令牌名称最多 80 字');
        const kind = String(body.kind || 'external').trim();
        if (API_CLIENT_KINDS.indexOf(kind) < 0) throw new HttpError(400, 'kind_invalid', '令牌类型不合法');
        const scopes = normalizeScopes(body.scopes === undefined ? ['read'] : body.scopes);
        if (!scopes) throw new HttpError(400, 'scopes_invalid', '调用范围只能是 read / write / collector');
        const rateLimit = Math.min(Math.max(Number(body.rate_limit) || 120, 1), 6000);
        const seller = String(body.seller_id || ctx.sellerId || sellerId || 'seller-main').trim();
        assertSellerAllowed(seller, ctx);
        const generated = newApiToken();
        const client = await store.createApiClient({
          tenantId: ctx.tenantId || tenantId, sellerId: seller, name: name, kind: kind,
          scopes: scopes, rateLimit: rateLimit,
          tokenHash: tokenHash(generated.token), tokenPrefix: generated.prefix,
          createdBy: ctx.employee ? ctx.employee.email : ctx.role,
        });
        log.info('api_client_created', { request_id: requestId, name: name, kind: kind, scopes: scopes });
        recordAudit(ctx, 'api_token.create', name, { kind: kind, scopes: scopes, rate_limit: rateLimit, seller_id: seller });
        return send(res, 201, { ok: true, client: client, token: generated.token });
      }

      if (hit.name === 'gatewayClientUpdate') {
        if (!UUID_RE.test(String(hit.id))) throw new HttpError(404, 'client_not_found', 'API 令牌不存在');
        const body = await readJson(req, 8 * 1024);
        const patch = {};
        if (body.name !== undefined) {
          const name = String(body.name || '').trim();
          if (!name) throw new HttpError(400, 'name_required', '令牌名称不能为空');
          if (name.length > 80) throw new HttpError(400, 'name_too_long', '令牌名称最多 80 字');
          patch.name = name;
        }
        if (body.scopes !== undefined) {
          const scopes = normalizeScopes(body.scopes);
          if (!scopes) throw new HttpError(400, 'scopes_invalid', '调用范围只能是 read / write / collector');
          patch.scopes = scopes;
        }
        if (body.rate_limit !== undefined) {
          patch.rateLimit = Math.min(Math.max(Number(body.rate_limit) || 120, 1), 6000);
        }
        if (body.status !== undefined) {
          const status = String(body.status);
          if (['active', 'disabled'].indexOf(status) < 0) {
            throw new HttpError(400, 'status_invalid', '状态只能是 active / disabled');
          }
          patch.status = status;
        }
        if (!Object.keys(patch).length) throw new HttpError(400, 'patch_required', '没有需要修改的字段');
        const client = await store.updateApiClient(Object.assign({
          tenantId: ctx.tenantId || tenantId, id: hit.id,
        }, patch));
        if (!client) throw new HttpError(404, 'client_not_found', 'API 令牌不存在');
        recordAudit(ctx, 'api_token.update', client.name, patch);
        return send(res, 200, { ok: true, client: client });
      }

      if (hit.name === 'gatewayClientRotate') {
        if (!UUID_RE.test(String(hit.id))) throw new HttpError(404, 'client_not_found', 'API 令牌不存在');
        const generated = newApiToken();
        const client = await store.updateApiClient({
          tenantId: ctx.tenantId || tenantId, id: hit.id,
          tokenHash: tokenHash(generated.token), tokenPrefix: generated.prefix,
        });
        if (!client) throw new HttpError(404, 'client_not_found', 'API 令牌不存在');
        log.info('api_client_rotated', { request_id: requestId, name: client.name });
        recordAudit(ctx, 'api_token.rotate', client.name, {});
        return send(res, 200, { ok: true, client: client, token: generated.token });
      }

      if (hit.name === 'gatewayClientDelete') {
        if (!UUID_RE.test(String(hit.id))) throw new HttpError(404, 'client_not_found', 'API 令牌不存在');
        const removed = await store.deleteApiClient(ctx.tenantId || tenantId, hit.id);
        if (!removed) throw new HttpError(404, 'client_not_found', 'API 令牌不存在');
        log.info('api_client_deleted', { request_id: requestId, name: removed.name });
        recordAudit(ctx, 'api_token.delete', removed.name, {});
        return send(res, 200, { ok: true, name: removed.name });
      }

      if (hit.name === 'gatewayCalls') {
        const items = await store.listApiCalls(ctx.tenantId || tenantId, {
          minStatus: Number(url.searchParams.get('min_status')) || 0,
          limit: url.searchParams.get('limit'),
        });
        return send(res, 200, { items: items });
      }

      if (hit.name === 'auditLog') {
        const items = await store.listAudit(ctx.tenantId || tenantId, {
          action: url.searchParams.get('action') || '',
          actor: url.searchParams.get('actor') || '',
          limit: url.searchParams.get('limit'),
        });
        return send(res, 200, { items: items });
      }

      // ---------- 经营总览：指标 + 身份 + 新鲜度 + AI ----------
      if (hit.name === 'businessOverview') {
        const sid = sellerOf(ctx, url);
        const owner = String(url.searchParams.get('owner') || '').trim();
        const domain = require('./domain').loadDomain();
        const kinds = ['inquiry', 'customer', 'public_customer', 'order', 'visitor', 'chat'];
        const data = await store.rowsByKind(sid, kinds);
        kinds.forEach((kind) => { if (!Array.isArray(data[kind])) data[kind] = []; });
        if (owner) {
          const want = owner.toLowerCase();
          const match = (value) => String(value || '').toLowerCase().includes(want);
          data.inquiry = data.inquiry.filter((row) => match(domain.analyze.val(row, '负责人')));
          data.customer = data.customer.filter((row) => match(domain.analyze.val(row, '负责人'))
            || match(domain.analyze.val(row, '销售名')));
          data.public_customer = data.public_customer.filter((row) => match(domain.analyze.val(row, '负责人'))
            || match(domain.analyze.val(row, '销售名')));
        }
        const overview = domain.analyze.storeOverview(data);
        const val = domain.analyze.val;
        const core = domain.dataCore;
        const text = (value) => String(value === undefined || value === null ? '' : value).trim();
        const parseDay = (value) => {
          const t = Date.parse(text(value).replace(/\//g, '-'));
          return Number.isFinite(t) ? t : null;
        };
        const nowMs = Date.now();
        const within30 = (value) => {
          const t = parseDay(value);
          return t !== null && t <= nowMs && t >= nowMs - 30 * 86400000;
        };
        const moneyText = (list) => (list && list.length
          ? list.map((item) => (item.currency === '未标注币种' ? '' : item.currency + ' ')
            + Number(item.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })).join(' / ')
          : '0');
        const amountRows = (rows) => {
          const map = new Map();
          rows.forEach((row) => {
            const amount = core.amount(val(row, '成交金额'));
            if (amount === null) return;
            const currency = text(val(row, '币种')) || '未标注币种';
            map.set(currency, (map.get(currency) || 0) + amount);
          });
          return Array.from(map, ([currency, amount]) => ({
            currency, amount: Math.round(amount * 100) / 100,
          })).sort((a, b) => b.amount - a.amount);
        };
        const isReplied = (row) => {
          const status = text(val(row, '回复状态'));
          if (!status) return Boolean(text(val(row, '最新回复时间')));
          return status.indexOf('已回复') >= 0 || status === '1';
        };
        const isAdded = (row) => text(val(row, '是否已加为客户')) === '是';
        const hasNo = (row, key) => !text(val(row, key));
        // 买家等级有数字或字母任一即可，避免把只有字母等级的询盘误判为缺失
        const noGrade = (row) => hasNo(row, '买家等级') && hasNo(row, '买家等级(字母)');

        const inv = data.inquiry;
        const orders = data.order;
        const wonOrders = orders.filter(core.wonOrder);
        const inv30 = inv.filter((row) => within30(val(row, '创建时间')));
        const invHistory = inv.filter((row) => !within30(val(row, '创建时间')));
        const orders30 = orders.filter((row) => within30(val(row, '下单时间') || val(row, '创建时间')));
        const ordersHistory = orders.filter((row) => !within30(val(row, '下单时间') || val(row, '创建时间')));
        const won30 = orders30.filter(core.wonOrder);
        const replied30 = inv30.filter(isReplied).length;
        const repliedAll = inv.filter(isReplied).length;
        const rate30 = inv30.length ? Math.round((replied30 / inv30.length) * 1000) / 10 : null;
        const rateAll = inv.length ? Math.round((repliedAll / inv.length) * 1000) / 10 : null;
        const added30 = inv30.filter(isAdded).length;
        const addedAll = inv.filter(isAdded).length;
        const gmv30 = amountRows(won30);
        const gmvAll = Array.isArray(overview.gmv) ? overview.gmv : [];
        const baseKpi = new Map((overview.kpis || []).map((item) => [item[0], { value: item[1], hint: item[2] }]));
        const pickKpi = (label) => baseKpi.get(label) || { value: '—', hint: '' };
        const kpis = [
          ['近30天询盘', inv30.length, '创建时间在近30天；累计 ' + inv.length + ' 条'],
          ['近30天回复率', rate30 === null ? '暂无' : rate30 + '%', '近30天已回复 ' + replied30 + '/' + inv30.length],
          ['近30天订单', won30.length, '下单时间在近30天且已付款/完成'],
          ['近30天成交额', moneyText(gmv30), '按币种分开累计'],
          ['累计回复率', rateAll === null ? '暂无' : rateAll + '%', '累计已回复 ' + repliedAll + '/' + inv.length],
          ['累计已加客户', addedAll, '占累计询盘 ' + (inv.length ? Math.round((addedAll / inv.length) * 1000) / 10 + '%' : '—')],
          ['累计订单', wonOrders.length, '全部订单 ' + orders.length + ' 笔'],
          ['累计成交额', moneyText(gmvAll), '按币种分开累计'],
          ['平均响应', pickKpi('平均响应').value, pickKpi('平均响应').hint],
          ['我的客户', pickKpi('我的客户').value, pickKpi('我的客户').hint],
          ['待跟进', pickKpi('待跟进').value, pickKpi('待跟进').hint],
          ['访客数', pickKpi('访客数').value, pickKpi('访客数').hint],
        ];

        // 没有询盘来源的已确认订单单列为“直接成交”，不再当作数据错误
        const directOrders = wonOrders.filter((row) => !text(val(row, '询盘ID')));
        const directMap = new Map();
        directOrders.forEach((row) => {
          const company = text(val(row, '公司名称'));
          const customer = text(val(row, '客户名称'));
          const key = company || customer || '未命名客户';
          const item = directMap.get(key) || {
            name: key, customer: customer, company: company, orders: 0, amounts: new Map(),
          };
          item.orders += 1;
          const amount = core.amount(val(row, '成交金额'));
          if (amount !== null) {
            const currency = text(val(row, '币种')) || '未标注币种';
            item.amounts.set(currency, (item.amounts.get(currency) || 0) + amount);
          }
          directMap.set(key, item);
        });
        const directDeals = Array.from(directMap.values()).map((item) => ({
          name: item.name, customer: item.customer, company: item.company, orders: item.orders,
          amounts: Array.from(item.amounts, ([currency, amount]) => ({
            currency, amount: Math.round(amount * 100) / 100,
          })),
        }));
        const directSummary = { orders: directOrders.length, amounts: amountRows(directOrders) };

        const gap = (id, label, recentCount, recentTotal, historyCount, historyTotal, level, hint) => ({
          id: id, label: label, count: recentCount + historyCount, total: recentTotal + historyTotal,
          recent_count: recentCount, recent_total: recentTotal,
          history_count: historyCount, history_total: historyTotal,
          level: level, hint: hint,
        });
        const orderLinkHint = '影响成交归因、投流回收与客户 LTV 判断'
          + (directOrders.length ? '；其中 ' + directOrders.length + ' 笔已按直接成交单列' : '');
        const qualityAll = [
          gap('name', '询盘缺客户名',
            inv30.filter((row) => hasNo(row, '客户名称')).length, inv30.length,
            invHistory.filter((row) => hasNo(row, '客户名称')).length, invHistory.length,
            'high', '无法在聊天与订单中稳定匹配客户，影响身份聚合'),
          gap('order-link', '订单未关联询盘',
            orders30.filter((row) => hasNo(row, '询盘ID')).length, orders30.length,
            ordersHistory.filter((row) => hasNo(row, '询盘ID')).length, ordersHistory.length,
            'high', orderLinkHint),
          gap('grade', '买家等级缺失',
            inv30.filter(noGrade).length, inv30.length,
            invHistory.filter(noGrade).length, invHistory.length,
            'mid', '影响高价值询盘识别与跟进优先级'),
          gap('company', '公司名缺失',
            inv30.filter((row) => hasNo(row, '公司名称')).length, inv30.length,
            invHistory.filter((row) => hasNo(row, '公司名称')).length, invHistory.length,
            'low', '影响客户去重与背景核实'),
        ];
        const visitorGap = (overview.quality || []).find((row) => row.id === 'visitor-terms');
        if (visitorGap) {
          qualityAll.push(Object.assign({}, visitorGap, {
            recent_count: 0, recent_total: 0,
            history_count: visitorGap.count || 0, history_total: visitorGap.total || 0,
            snapshot: true,
          }));
        }
        const qualityRecent = qualityAll.filter((row) => row.recent_count > 0);
        const qualityHistory = qualityAll.filter((row) => row.history_count > 0);
        const countBy = (items, key) => {
          const map = new Map();
          items.forEach((item) => {
            const name = item[key] || '未标注';
            map.set(name, (map.get(name) || 0) + 1);
          });
          return Array.from(map, ([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count);
        };
        // 待补等级清单：APP 端详情页商机优先，其次 Sub Account，方便运营直接跟进
        const gradePriority = (row) => (row.source === 'APP端详情页商机' ? 0
          : row.owner === 'Sub Account' ? 1 : 2);
        const gradeMissing = inv30.filter(noGrade).map((row) => ({
          inquiry_id: text(val(row, '询盘ID')),
          customer: text(val(row, '客户名称')),
          company: text(val(row, '公司名称')),
          country: text(val(row, '国家')),
          source: text(val(row, '来源')),
          owner: text(val(row, '负责人')),
          subject: text(val(row, '询盘主题')),
          created_at: text(val(row, '创建时间')),
          replied: text(val(row, '回复状态')),
        })).sort((a, b) => gradePriority(a) - gradePriority(b)
          || String(b.created_at).localeCompare(String(a.created_at)));
        const gradeMissingSummary = {
          total: gradeMissing.length,
          sources: countBy(gradeMissing, 'source'),
          owners: countBy(gradeMissing, 'owner'),
        };
        const topRecent = qualityRecent.filter((row) => row.level !== 'low').slice(0, 2)
          .map((row) => row.label + ' ' + row.recent_count);
        const headlineParts = [
          '近30天新增询盘 ' + inv30.length + ' 条',
          '近30天回复率 ' + (rate30 === null ? '暂无' : rate30 + '%'),
          '近30天加客 ' + added30 + ' 条',
          '近30天成交 ' + won30.length + ' 笔' + (gmv30.length ? ' / ' + moneyText(gmv30) : ''),
          '累计成交 ' + wonOrders.length + ' 笔' + (gmvAll.length ? ' / ' + moneyText(gmvAll) : ''),
        ];
        headlineParts.push(topRecent.length ? '近30天优先补 ' + topRecent.join('、') : '近30天主要资料缺口暂不明显');
        const headline = headlineParts.join('；') + '。';

        const identity = domain.identity.build({
          inquiry: data.inquiry, customer: data.customer, public_customer: data.public_customer,
          chat: data.chat, order: data.order,
        });
        const summary = await store.summary(sid);
        const since = new Date(Date.now() - 24 * 3600000).toISOString();
        const ai = await store.aiOverview(ctx.tenantId || tenantId, sid, since);
        const accounts = await store.listAlibabaAccounts(ctx.tenantId || tenantId);
        const ownerLabels = {};
        accounts.forEach((account) => {
          if (account.owner_name && account.display_name) ownerLabels[account.owner_name] = account.display_name;
        });
        return send(res, 200, Object.assign({}, overview, {
          ok: true, seller_id: sid, owner: owner || '全部',
          generated_at: new Date().toISOString(),
          identity: identity.stats,
          freshness: summary.sources,
          ai: ai,
          data_version: latestSync(summary),
          headline: headline,
          kpis: kpis,
          quality: qualityAll,
          quality_recent: qualityRecent,
          quality_history: qualityHistory,
          grade_missing: gradeMissing,
          grade_missing_summary: gradeMissingSummary,
          owner_labels: ownerLabels,
          direct_deals: directDeals,
          direct_summary: directSummary,
          windows: { recent_days: 30 },
        }));
      }

      // ---------- 数据中台 P3：AI 智能体总览与运行审计 ----------
      if (hit.name === 'aiOverview') {
        const sid = sellerOf(ctx, url);
        const tenant = ctx.tenantId || tenantId;
        const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 24, 1), 168);
        const since = new Date(Date.now() - hours * 3600000).toISOString();
        const [overview, recent] = await Promise.all([
          store.aiOverview(tenant, sid, since),
          store.listAiRuns({ tenantId: tenant, sellerId: sid, limit: 5 }),
        ]);
        const cfg = difyConfig();
        return send(res, 200, Object.assign({
          ok: true, seller_id: sid, window_hours: hours,
          generated_at: new Date().toISOString(),
          dify: { configured: Boolean(cfg.apiKey), base_url: cfg.baseUrl, scope: 'platform-shared' },
          guard_rules: GUARD_RULES.map((rule) => ({ code: rule.code, label: rule.label, level: rule.level })),
          recent_runs: recent,
        }, overview));
      }

      if (hit.name === 'aiRuns') {
        const sid = sellerOf(ctx, url);
        const kind = String(url.searchParams.get('kind') || '').trim();
        if (kind && ['draft', 'chat'].indexOf(kind) < 0) {
          throw new HttpError(400, 'kind_invalid', 'kind 只能是 draft / chat');
        }
        const items = await store.listAiRuns({
          tenantId: ctx.tenantId || tenantId, sellerId: sid,
          kind: kind,
          state: String(url.searchParams.get('state') || '').trim(),
          agentId: String(url.searchParams.get('agent_id') || '').trim(),
          limit: url.searchParams.get('limit'),
        });
        return send(res, 200, { ok: true, seller_id: sid, items: items });
      }

      if (hit.name === 'status') {
        const sid = sellerOf(ctx, url);
        const sources = await store.syncStatus(sid);
        return send(res, 200, { seller_id: sid, sources: sources });
      }

      if (hit.name === 'changes') {
        const sid = sellerOf(ctx, url);
        const since = parseTime(url.searchParams.get('since')) || '1970-01-01T00:00:00.000Z';
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 1000);
        const records = await store.changes({ sellerId: sid, since, limit });
        return send(res, 200, { seller_id: sid, cursor: new Date().toISOString(), records: records });
      }

      return send(res, 404, { error: 'not_found', message: '接口不存在' });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
      const status = Number(e.status) || 500;
      const code = e.code || 'internal_error';
      if (status >= 500) log.error('request_failed', { request_id: requestId, path: pathname, error: String((e && e.message) || e), stack: e && e.stack });
      return send(res, status, { error: code, message: status >= 500 ? '服务内部错误' : String(e.message || code) });
    }
  };
}

module.exports = { createHandler, KINDS, HttpError, normalizeRows };
