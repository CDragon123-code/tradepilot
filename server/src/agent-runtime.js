'use strict';

// 智能体运行时：一个回合 = 组装上下文 → 流式生成 → 守门 → 落消息/回合/升级单
// chat 可注入，便于测试；生产使用 dify-client.chatStream
const { loadDomain } = require('./domain');
const { chatStream } = require('./dify-client');
const { inspect } = require('./guard');
const log = require('./log');

function difyEnv() {
  return {
    baseUrl: String(process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1').trim(),
    apiKey: String(process.env.DIFY_API_KEY || '').trim(),
  };
}

function buildPrompt(input) {
  const { agent, thread, messages, customer } = input;
  const domain = loadDomain();
  if (!domain.dify || !domain.dify.buildDifyQuery) throw new Error('Dify 提示词模块未加载');
  const list = messages || [];
  const transcript = list.slice(-12).map((m) => ({
    at: '',
    mine: m.role !== 'customer',
    text: String(m.content || '').slice(0, 500),
  }));
  const lastCustomer = list.slice().reverse().find((m) => m.role === 'customer');
  const p = customer || {};
  const item = {
    lastBuyerText: lastCustomer ? String(lastCustomer.content) : '',
    subject: (thread && thread.subject) || p['询盘主题'] || '',
    product: p['咨询产品'] || '',
    country: p['国家'] || '',
    level: p['买家等级'] || '',
    createdAt: p['创建时间'] || '',
    transcript: transcript,
    demand: null,
  };
  const base = domain.dify.buildDifyQuery(item, { companyFacts: '' });
  return (agent.persona ? ('【业务员人设】' + agent.persona + '\n') : '') + base;
}

/**
 * 执行一个回合
 * @returns {Promise<{run_id, draft, guard, escalation, citations, model, latency_ms}>}
 */
async function runTurn(options) {
  const { store, agent, thread, text, trigger, emit, chat, customer } = options;
  const t0 = Date.now();
  if (text) {
    await store.appendMessage({
      threadId: thread.id,
      role: trigger === 'resume' ? 'human' : 'customer',
      content: String(text),
      state: 'ok',
      meta: {},
    });
  }
  const messages = await store.listMessages(thread.id, 40);
  const run = await store.createAgentRun({
    threadId: thread.id,
    agentId: agent.id,
    trigger: trigger || 'message',
    input: { text: text || '', messages: messages.length },
  });
  const prompt = buildPrompt({ agent: agent, thread: thread, messages: messages, customer: customer || thread.customer || {} });
  try {
    const cfg = difyEnv();
    const call = chat || ((opts) => chatStream(Object.assign({}, opts, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey })));
    const out = await call({
      query: prompt,
      user: 'agent:' + agent.id,
      onDelta: (delta) => { if (emit) emit('delta', { text: delta }); },
    });
    const guard = inspect(out.answer);
    let escalation = null;
    if (guard.level === 'block') {
      escalation = await store.createEscalation({
        tenantId: thread.tenant_id,
        sellerId: thread.seller_id,
        threadId: thread.id,
        runId: run.id,
        reasonCode: 'guard',
        reason: guard.risks.map((r) => r.label).join('、'),
        question: { draft: out.answer, risks: guard.risks },
      });
      await store.appendMessage({
        threadId: thread.id, role: 'agent', content: out.answer, state: 'blocked', meta: { risks: guard.risks },
      });
      await store.updateThread(thread.id, { status: 'waiting_human' });
    } else {
      await store.appendMessage({
        threadId: thread.id, role: 'agent', content: out.answer, state: 'ok', meta: { citations: out.citations },
      });
      await store.updateThread(thread.id, { status: 'open' });
    }
    const latency = Date.now() - t0;
    await store.finishAgentRun(run.id, {
      state: guard.level === 'block' ? 'blocked' : 'ok',
      output: out.answer,
      model: out.model || '',
      latencyMs: latency,
      guard: guard.risks,
      escalationId: escalation && escalation.id,
    });
    log.info('turn_done', {
      thread: thread.id, run: run.id, guard: guard.level,
      escalation: escalation && escalation.id, latency_ms: latency,
    });
    return {
      run_id: run.id, draft: out.answer, guard: guard, escalation: escalation,
      citations: out.citations, model: out.model || '', latency_ms: latency,
    };
  } catch (e) {
    await store.finishAgentRun(run.id, {
      state: 'failed', error: String((e && e.message) || e).slice(0, 300), latencyMs: Date.now() - t0,
    });
    log.error('turn_failed', { thread: thread.id, error: String((e && e.message) || e) });
    throw e;
  }
}

// 人工结论落库后，带着结论续跑一个回合
async function resumeAfterEscalation(options) {
  const { store, escalation, resolution, resolvedBy, chat, emit } = options;
  await store.appendMessage({
    threadId: escalation.thread_id, role: 'human', content: String(resolution), state: 'ok',
    meta: { escalation_id: escalation.id },
  });
  await store.resolveEscalation(escalation.id, { resolution: String(resolution), resolvedBy: resolvedBy || null });
  const thread = await store.getThread(escalation.thread_id);
  const agent = await store.getAgent(thread.tenant_id, thread.seller_id, thread.agent_id);
  await store.updateThread(thread.id, { status: 'open' });
  return runTurn({
    store: store, agent: agent, thread: thread, text: null, trigger: 'resume', chat: chat, emit: emit,
    customer: thread.customer || {},
  });
}

// 智能体给客户分配建议：确定性打分，理由可解释
function scoreCandidate(row, now) {
  const p = row.payload || {};
  let score = 30;
  const reasons = [];
  if (String(p['回复状态'] || '') !== '已回复') { score += 25; reasons.push('待回复'); }
  const at = row.business_at ? Date.parse(row.business_at) : NaN;
  if (Number.isFinite(at)) {
    const age = (now - at) / 3600000;
    if (age <= 24) { score += 20; reasons.push('24 小时内新询盘'); }
    else if (age <= 72) { score += 10; reasons.push('72 小时内'); }
  }
  const grade = String(p['买家等级'] || '').toUpperCase();
  if (grade === 'L3' || grade === 'L4') { score += 15; reasons.push('高等级买家 ' + grade); }
  else if (grade === 'L2') { score += 8; reasons.push('L2 买家'); }
  if (p['公司名称']) { score += 5; reasons.push('有公司信息'); }
  if (p['国家']) { score += 2; reasons.push('国家已知'); }
  return { score: Math.min(100, score), reason: reasons.join(' + ') || '基础匹配' };
}

async function suggestForAgent(options) {
  const { store, agent, limit } = options;
  const now = Date.now();
  const rows = await store.unassignedInquiries(agent.seller_id, Math.min(200, Number(limit) || 50));
  const list = (rows || []).map((row) => {
    const s = scoreCandidate(row, now);
    return { customerKey: row.platform_id, score: s.score, reason: s.reason };
  }).sort((a, b) => b.score - a.score);
  if (!list.length) return { created: 0, items: [] };
  const created = await store.upsertSuggestions({
    tenantId: agent.tenant_id, sellerId: agent.seller_id, agentId: agent.id,
    items: list, createdBy: 'agent',
  });
  log.info('suggestions_created', { agent: agent.id, count: created });
  return { created: created, items: list.slice(0, 20) };
}

module.exports = { runTurn, resumeAfterEscalation, suggestForAgent, buildPrompt, scoreCandidate };
