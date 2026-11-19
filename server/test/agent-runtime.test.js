'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runTurn, resumeAfterEscalation } = require('../src/agent-runtime');

function fakeStore() {
  const state = {
    thread: {
      id: 't1', tenant_id: 'default', seller_id: 's1', agent_id: 'a1',
      subject: 'Inquiry from TM', status: 'open',
      customer: { 国家: 'US', 询盘主题: 'Inquiry from TM', 买家等级: 'L2' },
    },
    messages: [], runs: [], escalations: [],
  };
  return {
    state: state,
    async appendMessage(m) {
      state.messages.push(Object.assign({ id: state.messages.length + 1, created_at: new Date().toISOString() }, m));
    },
    async listMessages() { return state.messages.slice(); },
    async createAgentRun(r) {
      const row = { id: state.runs.length + 1 };
      state.runs.push(Object.assign({}, r, row));
      return row;
    },
    async finishAgentRun(id, patch) {
      const row = state.runs.filter((r) => r.id === id)[0];
      Object.assign(row, patch);
    },
    async createEscalation(e) {
      const row = Object.assign({ id: 'esc1', status: 'open' }, e);
      state.escalations.push(row);
      return row;
    },
    async updateThread(id, patch) { Object.assign(state.thread, patch); },
    async getThread() { return state.thread; },
    async getAgent() { return { id: 'a1', persona: '', tenant_id: 'default', seller_id: 's1' }; },
    async resolveEscalation(id, patch) {
      const row = state.escalations.filter((e) => e.id === id)[0];
      Object.assign(row, { status: 'resolved' }, patch);
      return row;
    },
  };
}

test('守门命中：草稿被拦截并生成升级单，会话转 waiting_human', async () => {
  const store = fakeStore();
  const chat = async () => ({ answer: 'Our best price is USD 12 and lead time is 15 days.', citations: [], model: 'test' });
  const out = await runTurn({
    store: store, agent: { id: 'a1', persona: '' }, thread: store.state.thread,
    text: 'How much?', trigger: 'message', chat: chat, customer: store.state.thread.customer,
  });
  assert.equal(out.guard.level, 'block');
  assert.equal(out.escalation.id, 'esc1');
  assert.equal(store.state.thread.status, 'waiting_human');
  assert.equal(store.state.messages.filter((m) => m.role === 'agent')[0].state, 'blocked');
  assert.equal(store.state.runs[0].state, 'blocked');
});

test('人工结论续跑：升级单关闭，智能体继续输出合规回复', async () => {
  const store = fakeStore();
  const blocked = await runTurn({
    store: store, agent: { id: 'a1', persona: '' }, thread: store.state.thread,
    text: 'How much?', trigger: 'message',
    chat: async () => ({ answer: 'Price is USD 12.', citations: [], model: 'test' }),
    customer: store.state.thread.customer,
  });
  assert.equal(blocked.escalation.status, 'open');

  const resumed = await resumeAfterEscalation({
    store: store,
    escalation: blocked.escalation,
    resolution: '价格 12 美金可以报，交期 15 天。',
    resolvedBy: 'e1',
    chat: async () => ({ answer: 'Thanks for your patience. Our team confirmed the details and will follow up shortly.', citations: [], model: 'test' }),
  });
  assert.equal(resumed.guard.level, 'ok');
  assert.equal(store.state.escalations[0].status, 'resolved');
  assert.equal(store.state.thread.status, 'open');
  const human = store.state.messages.filter((m) => m.role === 'human');
  assert.equal(human.length, 1);
  assert.ok(human[0].content.indexOf('12') >= 0);
  const agentOk = store.state.messages.filter((m) => m.role === 'agent' && m.state === 'ok');
  assert.equal(agentOk.length, 1);
});

test('普通对话不触发升级单', async () => {
  const store = fakeStore();
  const out = await runTurn({
    store: store, agent: { id: 'a1', persona: '' }, thread: store.state.thread,
    text: 'What products do you have?', trigger: 'message',
    chat: async () => ({ answer: 'We focus on dental 3D printing resins. Which application are you working on?', citations: [], model: 'test' }),
    customer: store.state.thread.customer,
  });
  assert.equal(out.guard.level, 'ok');
  assert.equal(out.escalation, null);
  assert.equal(store.state.thread.status, 'open');
  assert.equal(store.state.messages.filter((m) => m.role === 'agent')[0].state, 'ok');
});
