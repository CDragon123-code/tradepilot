'use strict';

// 草稿生成（平台共用 Dify 知识库）：询盘上下文 + 业务员人设 → Dify → 守门 → 写回任务项
const { loadDomain } = require('./domain');
const { chatOnce } = require('./dify-client');
const { inspect } = require('./guard');
const log = require('./log');

const PROMPT_VERSION = 'v1';

function payloadToItem(payload) {
  const p = payload || {};
  return {
    lastBuyerText: '',
    subject: p['询盘主题'] || '',
    product: p['咨询产品'] || '',
    country: p['国家'] || '',
    level: p['买家等级'] || '',
    createdAt: p['创建时间'] || '',
    transcript: [],
    demand: null,
  };
}

function difyConfig() {
  return {
    baseUrl: String(process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1').trim(),
    apiKey: String(process.env.DIFY_API_KEY || '').trim(),
  };
}

async function generateDraft(options) {
  const { store, agent, item, payload, tenantId, sellerId } = options;
  const domain = loadDomain();
  if (!domain.dify || !domain.dify.buildDifyQuery) throw new Error('Dify 提示词模块未加载');
  const cfg = difyConfig();
  if (!cfg.apiKey) throw new Error('平台还没配置 DIFY_API_KEY（在 .env 里填平台共用的 Dify 应用 Key）');

  // 复用扩展里已验证的硬规则提示词，只额外前置业务员人设
  const base = domain.dify.buildDifyQuery(payloadToItem(payload), { companyFacts: '' });
  const query = agent.persona ? ('【业务员人设】' + agent.persona + '\n' + base) : base;
  const started = Date.now();
  try {
    const out = await chatOnce({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      query: query,
      user: 'agent:' + agent.id,
    });
    const latency = Date.now() - started;
    // 守门：命中价格/交期/认证/站外联系方式等，直接转人工
    const guard = inspect(out.answer);
    const state = guard.level === 'block' ? 'review_required' : 'drafted';
    const riskNote = guard.risks.length
      ? ('守门命中：' + guard.risks.map((r) => r.label).join('、'))
      : undefined;
    await store.saveAiRun({
      tenantId: tenantId, sellerId: sellerId, agentId: agent.id, taskItemId: item.id,
      promptVersion: PROMPT_VERSION, model: out.model, latencyMs: latency,
      citations: out.citations, risk: guard.risks, output: out.answer, state: 'ok',
    });
    await store.updateTaskItem(item.id, { state: state, draftText: out.answer, lastError: riskNote });
    log.info('draft_ok', {
      agent: agent.id, item: item.id, citations: out.citations.length,
      latency_ms: latency, guard: guard.level, risks: guard.risks.map((r) => r.code),
    });
    return {
      draft: out.answer, citations: out.citations, model: out.model,
      latency_ms: latency, risk: guard.risks, guard: guard.level, state: state,
    };
  } catch (e) {
    const message = String((e && e.message) || e);
    await store.saveAiRun({
      tenantId: tenantId, sellerId: sellerId, agentId: agent.id, taskItemId: item.id,
      promptVersion: PROMPT_VERSION, latencyMs: Date.now() - started,
      citations: [], risk: [], output: '', state: 'error', error: message.slice(0, 500),
    });
    await store.updateTaskItem(item.id, { lastError: message.slice(0, 300) });
    log.error('draft_failed', { agent: agent.id, item: item.id, error: message });
    throw e;
  }
}

module.exports = { generateDraft, difyConfig, PROMPT_VERSION };
