'use strict';

// AI 智能体：配置、任务草稿、人工队列与运行审计
(() => {
  const { api, fmtTime, fmtRows, el, mount } = window.CloudData;
  const $ = (id) => document.getElementById(id);
  const TABS = [
    ['overview', '概览'],
    ['agents', '智能体'],
    ['tasks', '任务与草稿'],
    ['human', '人工队列'],
    ['runs', '运行审计'],
  ];
  const state = {
    me: null, admin: false, tab: 'overview', editingAgentId: '',
    overview: null, agents: [], tasks: [], currentTaskId: '', items: [],
    escalations: [], review: [], suggestions: [], runs: [],
  };

  function say(id, text, ok) {
    const node = $(id);
    node.textContent = text || '';
    node.className = 'status-line' + (ok === true ? ' ok' : ok === false ? ' err' : '');
  }

  function pill(text, cls) {
    return el('span', 'pill ' + (cls || 'empty'), text);
  }

  function emptyRow(tbody, colspan, text) {
    tbody.textContent = '';
    const tr = el('tr');
    const td = el('td', 'muted', text);
    td.colSpan = colspan;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function safeGet(path) {
    return api(path).catch(() => ({ items: [] }));
  }

  function statePill(value) {
    const map = {
      ok: ['正常', 'ok'], running: ['进行中', 'empty'], error: ['失败', 'stale'],
      failed: ['失败', 'stale'], blocked: ['已拦截', 'stale'], pending: ['待处理', 'empty'],
      drafted: ['已出草稿', 'ok'], review_required: ['待人工', 'stale'],
      approved: ['已通过', 'ok'], sent: ['已发送', 'ok'], cancelled: ['已取消', 'empty'],
      active: ['启用', 'ok'], disabled: ['停用', 'empty'], open: ['待处理', 'stale'],
      resolved: ['已处理', 'ok'],
    };
    const item = map[value] || [value || '—', 'empty'];
    return pill(item[0], item[1]);
  }

  function renderBriefing() {
    const overview = state.overview || {};
    const agents = overview.agents || {};
    const items = overview.items || {};
    const runs = overview.runs || {};
    const draft = runs.draft || {};
    const chat = runs.chat || {};
    const errors = (draft.errors || 0) + (chat.errors || 0);
    $('briefing-text').textContent = '智能体 ' + (agents.total || 0) + ' 个（启用 '
      + (agents.active || 0) + '），任务项待处理 ' + ((items.pending || 0) + (items.drafted || 0)
        + (items.review_required || 0)) + ' 个，待人工 ' + ((items.review_required || 0)
        + ((overview.escalations || {}).open || 0)) + ' 条；近 24 小时 AI 运行 '
      + ((draft.total || 0) + (chat.total || 0)) + ' 次、失败 ' + errors + ' 次；Dify '
      + ((overview.dify || {}).configured ? '已配置' : '未配置') + '。';
    const badge = $('ai-badge');
    badge.className = 'quality-badge' + (errors ? ' warn' : '');
    badge.textContent = errors ? errors + ' 次 AI 运行失败待排查' : 'AI 服务运行正常';
  }

  function renderKpis() {
    const box = $('kpis');
    box.textContent = '';
    const overview = state.overview || {};
    const agents = overview.agents || {};
    const items = overview.items || {};
    const runs = overview.runs || {};
    const draft = runs.draft || {};
    const chat = runs.chat || {};
    const values = [
      ['智能体', (agents.active || 0) + ' / ' + (agents.total || 0), '启用 / 总数'],
      ['任务项待处理', fmtRows((items.pending || 0) + (items.drafted || 0) + (items.review_required || 0)), '未发送、未取消'],
      ['待人工', fmtRows((items.review_required || 0) + ((overview.escalations || {}).open || 0)), '草稿 + 升级单'],
      ['24h AI 运行', fmtRows((draft.total || 0) + (chat.total || 0)), '草稿 ' + (draft.total || 0) + ' · 会话 ' + (chat.total || 0)],
      ['24h 失败', fmtRows((draft.errors || 0) + (chat.errors || 0)), '可到运行审计查看'],
    ];
    values.forEach(([label, value, hint]) => {
      const card = el('div', 'kpi');
      card.appendChild(el('div', 'k', label));
      card.appendChild(el('div', 'v', String(value)));
      card.appendChild(el('div', 'h', hint));
      box.appendChild(card);
    });
  }

  function showPanel(key) {
    TABS.forEach(([name]) => $('panel-' + name).classList.toggle('hidden', name !== key));
  }

  function renderTabs() {
    const box = $('ai-tabs');
    box.textContent = '';
    TABS.forEach(([key, label]) => {
      const button = el('button', 'tab' + (state.tab === key ? ' active' : ''), label);
      button.type = 'button';
      button.onclick = () => {
        state.tab = key;
        renderTabs();
      };
      box.appendChild(button);
    });
    showPanel(state.tab);
  }

  function renderAiMeta() {
    const box = $('ai-meta');
    box.textContent = '';
    const overview = state.overview || {};
    const dify = overview.dify || {};
    const runs = overview.runs || {};
    const draft = runs.draft || {};
    const chat = runs.chat || {};
    const items = overview.items || {};
    const rows = [
      ['Dify 状态', dify.configured ? '已配置' : '未配置'],
      ['Dify 地址', dify.base_url || '—'],
      ['知识库范围', dify.scope || '—'],
      ['守门规则', (overview.guard_rules || []).length + ' 条'],
      ['草稿运行', (draft.total || 0) + ' 次 · 平均 ' + (draft.avg_ms || 0) + ' ms'],
      ['草稿 Tokens', fmtRows(draft.tokens)],
      ['会话运行', (chat.total || 0) + ' 次 · 平均 ' + (chat.avg_ms || 0) + ' ms'],
      ['任务项', '总数 ' + (items.total || 0) + ' · 已通过 ' + (items.approved || 0)],
    ];
    rows.forEach(([label, value]) => {
      const item = el('div', 'meta-item');
      item.appendChild(el('span', 'meta-k', label));
      item.appendChild(el('span', 'meta-v', String(value)));
      box.appendChild(item);
    });
  }

  function renderGuardRules() {
    const body = $('guard-rules').querySelector('tbody');
    body.textContent = '';
    const rules = (state.overview && state.overview.guard_rules) || [];
    if (!rules.length) { emptyRow(body, 3, '没有守门规则。'); return; }
    rules.forEach((rule) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, rule.label));
      tr.appendChild(el('td', 'mono', rule.code));
      const level = el('td');
      level.appendChild(pill(rule.level === 'block' ? '阻断' : '提醒', rule.level === 'block' ? 'stale' : 'empty'));
      tr.appendChild(level);
      body.appendChild(tr);
    });
  }

  function renderRunRows(tbody, rows, colspan) {
    tbody.textContent = '';
    if (!rows.length) { emptyRow(tbody, colspan, '还没有 AI 运行记录。'); return; }
    rows.forEach((row) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'muted', fmtTime(row.created_at)));
      tr.appendChild(el('td', null, row.kind === 'chat' ? '会话回合' : '草稿生成'));
      tr.appendChild(el('td', null, row.agent_name || '—'));
      const status = el('td');
      status.appendChild(statePill(row.state));
      tr.appendChild(status);
      tr.appendChild(el('td', 'muted', row.model || '—'));
      tr.appendChild(el('td', null, fmtRows(row.latency_ms) + ' ms'));
      if (colspan > 6) {
        tr.appendChild(el('td', null, fmtRows(row.tokens)));
        tr.appendChild(el('td', 'muted', row.error ? String(row.error).slice(0, 60) : '—'));
      }
      tbody.appendChild(tr);
    });
  }

  function renderRecentRuns() {
    renderRunRows($('recent-runs').querySelector('tbody'),
      (state.overview && state.overview.recent_runs) || [], 6);
  }

  function renderAgentOptions() {
    ['assign-agent', 'task-agent'].forEach((id) => {
      const select = $(id);
      const current = select.value;
      select.textContent = '';
      if (!state.agents.length) {
        const option = el('option', null, '还没有智能体');
        option.value = '';
        select.appendChild(option);
        return;
      }
      state.agents.forEach((agent) => {
        const option = el('option', null, agent.name + (agent.status === 'active' ? '' : '（停用）'));
        option.value = agent.id;
        select.appendChild(option);
      });
      if (current && state.agents.some((agent) => agent.id === current)) select.value = current;
    });
  }

  function renderAgents() {
    const body = $('agent-rows').querySelector('tbody');
    body.textContent = '';
    if (!state.agents.length) {
      emptyRow(body, 5, '还没有智能体，先在上方创建一个。');
      return;
    }
    state.agents.forEach((agent) => {
      const tr = el('tr');
      tr.dataset.id = agent.id;
      tr.dataset.status = agent.status;
      const name = el('td');
      name.appendChild(el('div', 'member-name', agent.name));
      name.appendChild(el('div', 'muted', (agent.persona || '未填写人设').slice(0, 60) || '未填写人设'));
      tr.appendChild(name);
      tr.appendChild(el('td', null, agent.language === 'zh' ? '中文' : '英文'));
      const rhythm = el('td');
      rhythm.appendChild(el('div', null, '每日 ' + fmtRows(agent.daily_limit) + ' · 冷却 '
        + (agent.cooldown_hours == null ? 24 : agent.cooldown_hours) + 'h'));
      rhythm.appendChild(el('div', 'muted', '静默 ' + (agent.quiet_start || '23:00') + '–'
        + (agent.quiet_end || '07:00') + ' · TZ ' + (agent.tz_offset_minutes == null ? 480 : agent.tz_offset_minutes) + ' 分'));
      tr.appendChild(rhythm);
      const status = el('td');
      status.appendChild(statePill(agent.status));
      tr.appendChild(status);
      const actions = el('td');
      const box = el('div', 'table-actions');
      const edit = el('button', 'mini secondary js-edit', '编辑');
      edit.type = 'button';
      const toggle = el('button', 'mini js-toggle', agent.status === 'active' ? '停用' : '启用');
      toggle.type = 'button';
      const remove = el('button', 'mini danger js-del', '删除');
      remove.type = 'button';
      box.appendChild(edit); box.appendChild(toggle); box.appendChild(remove);
      actions.appendChild(box);
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }

  function fillAgentForm(agent) {
    state.editingAgentId = agent.id;
    $('agent-form-title').textContent = '编辑智能体 · ' + agent.name;
    $('ag-name').value = agent.name || '';
    $('ag-language').value = agent.language || 'en';
    $('ag-model').value = agent.model || '';
    $('ag-limit').value = agent.daily_limit == null ? 20 : agent.daily_limit;
    $('ag-cooldown').value = agent.cooldown_hours == null ? 24 : agent.cooldown_hours;
    $('ag-quiet-start').value = agent.quiet_start || '23:00';
    $('ag-quiet-end').value = agent.quiet_end || '07:00';
    $('ag-tz').value = agent.tz_offset_minutes == null ? 480 : agent.tz_offset_minutes;
    $('ag-persona').value = agent.persona || '';
    $('ag-save').textContent = '保存修改';
    $('ag-cancel').classList.remove('hidden');
    say('ag-status', '正在编辑「' + agent.name + '」');
  }

  function resetAgentForm() {
    state.editingAgentId = '';
    $('agent-form-title').textContent = '新建智能体';
    $('ag-name').value = '';
    $('ag-language').value = 'en';
    $('ag-model').value = '';
    $('ag-limit').value = '20';
    $('ag-cooldown').value = '24';
    $('ag-quiet-start').value = '23:00';
    $('ag-quiet-end').value = '07:00';
    $('ag-tz').value = '480';
    $('ag-persona').value = '';
    $('ag-save').textContent = '创建智能体';
    $('ag-cancel').classList.add('hidden');
    say('ag-status', '');
  }

  async function saveAgent() {
    const body = {
      name: $('ag-name').value.trim(),
      language: $('ag-language').value,
      model: $('ag-model').value.trim(),
      persona: $('ag-persona').value.trim(),
      daily_limit: Number($('ag-limit').value) || 20,
      cooldown_hours: Number($('ag-cooldown').value) || 0,
      quiet_start: $('ag-quiet-start').value.trim() || '23:00',
      quiet_end: $('ag-quiet-end').value.trim() || '07:00',
      tz_offset_minutes: Number($('ag-tz').value) || 480,
    };
    if (!body.name) { say('ag-status', '请填写智能体名称', false); return; }
    say('ag-status', '正在保存…');
    try {
      if (state.editingAgentId) {
        await api('/api/agents/' + state.editingAgentId, { method: 'PATCH', body: body });
        say('ag-status', '已保存「' + body.name + '」', true);
      } else {
        await api('/api/agents', { method: 'POST', body: body });
        say('ag-status', '已创建「' + body.name + '」', true);
      }
      resetAgentForm();
      await refreshAgents();
      await refreshOverview();
    } catch (error) {
      say('ag-status', '保存失败：' + error.message, false);
    }
  }

  async function toggleAgent(id, status) {
    try {
      await api('/api/agents/' + id, {
        method: 'PATCH', body: { status: status === 'active' ? 'disabled' : 'active' },
      });
      await refreshAgents();
      await refreshOverview();
      say('ag-status', status === 'active' ? '已停用智能体' : '已启用智能体', true);
    } catch (error) {
      say('ag-status', '操作失败：' + error.message, false);
    }
  }

  async function deleteAgent(id, name) {
    if (!window.confirm('删除智能体「' + name + '」及其客户分配？该操作不可恢复。')) return;
    try {
      await api('/api/agents/' + id, { method: 'DELETE' });
      await refreshAgents();
      await refreshOverview();
      say('ag-status', '已删除「' + name + '」', true);
    } catch (error) {
      say('ag-status', '删除失败：' + error.message, false);
    }
  }

  function renderAssignments(items) {
    const box = $('as-result');
    box.textContent = '';
    if (!items.length) {
      box.appendChild(el('p', 'muted', '该智能体还没有分配客户。'));
      return;
    }
    const wrap = el('div', 'table-scroll');
    const table = el('table');
    const head = el('tr');
    ['客户', '国家', '主题', '回复状态'].forEach((label) => head.appendChild(el('th', null, label)));
    const thead = el('thead');
    thead.appendChild(head);
    table.appendChild(thead);
    const tbody = el('tbody');
    items.forEach((item) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, item.customer_name || item.customer_key));
      tr.appendChild(el('td', null, item.country || '—'));
      tr.appendChild(el('td', null, item.subject || '—'));
      tr.appendChild(el('td', null, item.replied || '—'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    box.appendChild(wrap);
  }

  async function assignCustomers() {
    const agentId = $('assign-agent').value;
    if (!agentId) { say('as-status', '先选择智能体', false); return; }
    try {
      const data = await api('/api/agents/' + agentId + '/assign', {
        method: 'POST',
        body: {
          country: $('as-country').value.trim(),
          grade: $('as-grade').value.trim(),
          replied: $('as-replied').value.trim(),
          limit: Number($('as-limit').value) || 50,
        },
      });
      say('as-status', '已分配 ' + (data.assigned || 0) + ' 个客户', true);
    } catch (error) {
      say('as-status', '分配失败：' + error.message, false);
    }
  }

  async function listAssignments() {
    const agentId = $('assign-agent').value;
    if (!agentId) { say('as-status', '先选择智能体', false); return; }
    try {
      const data = await api('/api/agents/' + agentId + '/assignments?limit=50');
      renderAssignments(data.items || []);
      say('as-status', '已分配 ' + (data.items || []).length + ' 个客户', true);
    } catch (error) {
      say('as-status', '读取失败：' + error.message, false);
    }
  }

  async function clearAssignments() {
    const agentId = $('assign-agent').value;
    if (!agentId) { say('as-status', '先选择智能体', false); return; }
    if (!window.confirm('清空该智能体的全部客户分配？')) return;
    try {
      const data = await api('/api/agents/' + agentId + '/unassign', { method: 'POST', body: {} });
      say('as-status', '已移除 ' + (data.removed || 0) + ' 个分配', true);
      $('as-result').textContent = '';
    } catch (error) {
      say('as-status', '清空失败：' + error.message, false);
    }
  }

  function renderTaskSelect() {
    const select = $('task-select');
    select.textContent = '';
    if (!state.tasks.length) {
      const option = el('option', null, '还没有任务');
      option.value = '';
      select.appendChild(option);
      state.currentTaskId = '';
      return;
    }
    state.tasks.forEach((task) => {
      const option = el('option', null, task.name + ' · ' + task.agent_name + '（' + task.items + ' 项）');
      option.value = task.id;
      select.appendChild(option);
    });
    if (state.currentTaskId && state.tasks.some((task) => task.id === state.currentTaskId)) {
      select.value = state.currentTaskId;
    } else {
      state.currentTaskId = state.tasks[0].id;
      select.value = state.currentTaskId;
    }
  }

  function renderItems() {
    const body = $('task-items').querySelector('tbody');
    body.textContent = '';
    if (!state.items.length) {
      emptyRow(body, 6, state.currentTaskId ? '该任务下没有客户，先给智能体分配客户再建任务。' : '先选择或创建一个任务。');
      return;
    }
    state.items.forEach((item) => {
      const tr = el('tr');
      tr.dataset.id = item.id;
      tr.dataset.draft = item.draft_text || '';
      tr.appendChild(el('td', null, item.customer_name || item.customer_key));
      tr.appendChild(el('td', null, item.country || '—'));
      tr.appendChild(el('td', null, item.subject || '—'));
      const status = el('td');
      status.appendChild(statePill(item.state));
      tr.appendChild(status);
      const draft = el('td', 'muted', item.draft_text ? String(item.draft_text).slice(0, 60) + '…' : '—');
      tr.appendChild(draft);
      const actions = el('td');
      const box = el('div', 'table-actions');
      const gen = el('button', 'mini secondary js-draft', '生成草稿');
      gen.type = 'button';
      const approve = el('button', 'mini js-approve', '通过');
      approve.type = 'button';
      const cancel = el('button', 'mini js-cancel', '取消');
      cancel.type = 'button';
      const view = el('button', 'mini js-view', '查看');
      view.type = 'button';
      box.appendChild(gen); box.appendChild(approve); box.appendChild(cancel); box.appendChild(view);
      actions.appendChild(box);
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }

  async function refreshTasks() {
    const data = await safeGet('/api/tasks');
    state.tasks = data.items || [];
    renderTaskSelect();
  }

  async function loadTaskItems(taskId) {
    if (!taskId) { state.items = []; renderItems(); return; }
    state.currentTaskId = taskId;
    const data = await api('/api/tasks/' + taskId + '/items?limit=100');
    state.items = data.items || [];
    renderItems();
    say('task-status', '共 ' + state.items.length + ' 个任务项');
  }

  async function createTask() {
    const agentId = $('task-agent').value;
    if (!agentId) { say('task-status', '先选择智能体', false); return; }
    const name = window.prompt('任务名称（例如：11-18 首响）', '首响任务');
    if (!name) return;
    try {
      const data = await api('/api/tasks', {
        method: 'POST', body: { agent_id: agentId, name: name },
      });
      say('task-status', '任务已创建，包含 ' + (data.items || 0) + ' 个客户', true);
      await refreshTasks();
      state.currentTaskId = data.task.id;
      renderTaskSelect();
      await loadTaskItems(data.task.id);
    } catch (error) {
      say('task-status', '创建失败：' + error.message, false);
    }
  }

  function renderItemDetail(item, runs) {
    const box = $('item-detail');
    box.textContent = '';
    box.classList.remove('hidden');
    const head = el('div', 'section-head');
    const title = el('div');
    title.appendChild(el('span', 'eyebrow', '任务项详情'));
    title.appendChild(el('h2', null, item.customer_name || item.customer_key || '客户'));
    head.appendChild(title);
    const status = el('div');
    status.appendChild(statePill(item.state));
    head.appendChild(status);
    box.appendChild(head);
    if (item.last_error) {
      box.appendChild(el('p', 'error-text', '最近提示：' + item.last_error));
    }
    box.appendChild(el('div', 'draft-box', item.draft_text || '还没有生成草稿。'));
    if (runs && runs.length) {
      box.appendChild(el('h3', 'detail-subtitle', '生成历史'));
      runs.forEach((run) => {
        const row = el('div', 'run-line');
        row.appendChild(el('span', 'run-time', fmtTime(run.created_at)));
        row.appendChild(el('span', null, (run.model || '默认模型') + ' · '
          + fmtRows(run.latency_ms) + ' ms · ' + (run.state || 'ok')));
        if (run.risk && run.risk.length) {
          row.appendChild(el('span', 'muted', '风险：' + run.risk.map((risk) => risk.label || risk.code).join('、')));
        }
        box.appendChild(row);
        if (run.citations && run.citations.length) {
          const list = el('ul', 'cite');
          run.citations.forEach((citation) => {
            list.appendChild(el('li', null, (citation.document || citation.dataset || '知识')
              + '：' + String(citation.content || '').slice(0, 120)));
          });
          box.appendChild(list);
        }
      });
    }
  }

  async function viewItem(id) {
    try {
      const data = await api('/api/task-items/' + id);
      renderItemDetail(data.item || {}, data.runs || []);
      state.tab = 'tasks';
      renderTabs();
    } catch (error) {
      say('task-status', '读取详情失败：' + error.message, false);
    }
  }

  async function draftItem(id) {
    say('task-status', '正在调用 Dify 生成草稿…');
    try {
      const out = await api('/api/task-items/' + id + '/draft', { method: 'POST', body: {} });
      say('task-status', '已生成（引用 ' + ((out.citations || []).length) + ' 条知识）', true);
      renderItemDetail({ state: out.state, draft_text: out.draft, last_error: '' }, [out]);
      await loadTaskItems(state.currentTaskId);
      await refreshOverview();
      await refreshReview();
    } catch (error) {
      say('task-status', '生成失败：' + error.message, false);
    }
  }

  async function patchItem(id, stateValue) {
    try {
      await api('/api/task-items/' + id, { method: 'PATCH', body: { state: stateValue } });
      say('task-status', stateValue === 'approved' ? '已通过，可交给扩展发送' : '已取消', true);
      await loadTaskItems(state.currentTaskId);
      await refreshOverview();
      await refreshReview();
    } catch (error) {
      say('task-status', '操作失败：' + error.message, false);
    }
  }

  function renderEscalations() {
    const body = $('escalations').querySelector('tbody');
    body.textContent = '';
    if (!state.escalations.length) { emptyRow(body, 6, '没有待处理的升级单。'); return; }
    state.escalations.forEach((row) => {
      const tr = el('tr');
      tr.dataset.id = row.id;
      tr.dataset.name = row.customer_name || row.customer_key || '';
      tr.appendChild(el('td', null, row.customer_name || row.customer_key || '—'));
      tr.appendChild(el('td', null, row.subject || '—'));
      tr.appendChild(el('td', null, row.agent_name || '—'));
      tr.appendChild(el('td', 'muted', row.reason || '—'));
      tr.appendChild(el('td', 'muted', fmtTime(row.created_at)));
      const actions = el('td');
      const button = el('button', 'mini js-resolve', '处理');
      button.type = 'button';
      actions.appendChild(button);
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }

  async function resolveEscalation(id, name) {
    const resolution = window.prompt('给「' + name + '」填写人工结论，AI 会据此继续生成回复');
    if (!resolution) return;
    try {
      await api('/api/escalations/' + id + '/resolve', { method: 'POST', body: { resolution: resolution } });
      say('escalation-status', '已处理「' + name + '」', true);
      await refreshEscalations();
      await refreshOverview();
    } catch (error) {
      say('escalation-status', '处理失败：' + error.message, false);
    }
  }

  function renderReview() {
    const body = $('review-rows').querySelector('tbody');
    body.textContent = '';
    if (!state.review.length) { emptyRow(body, 5, '没有待审核草稿。'); return; }
    state.review.forEach((row) => {
      const tr = el('tr');
      tr.dataset.id = row.id;
      tr.appendChild(el('td', null, row.customer_name || row.customer_key || '—'));
      tr.appendChild(el('td', null, row.subject || '—'));
      const risk = el('td');
      if (row.risk && row.risk.length) {
        risk.appendChild(pill(row.risk.map((item) => item.label || item.code).join('、'), 'stale'));
      } else {
        risk.appendChild(el('span', 'muted', '—'));
      }
      tr.appendChild(risk);
      tr.appendChild(el('td', 'muted', String(row.draft_text || '').slice(0, 80) || '—'));
      const actions = el('td');
      const box = el('div', 'table-actions');
      const approve = el('button', 'mini js-approve', '通过');
      approve.type = 'button';
      const cancel = el('button', 'mini danger js-reject', '驳回');
      cancel.type = 'button';
      box.appendChild(approve); box.appendChild(cancel);
      actions.appendChild(box);
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }

  function renderSuggestions() {
    const body = $('suggestion-rows').querySelector('tbody');
    body.textContent = '';
    if (!state.suggestions.length) { emptyRow(body, 5, '没有待确认的分配建议。'); return; }
    state.suggestions.forEach((row) => {
      const tr = el('tr');
      tr.dataset.id = row.id;
      tr.appendChild(el('td', null, row.customer_name || row.customer_key || '—'));
      tr.appendChild(el('td', null, row.agent_name || '—'));
      tr.appendChild(el('td', null, row.score == null ? '—' : String(row.score)));
      tr.appendChild(el('td', 'muted', row.reason || '—'));
      const actions = el('td');
      const box = el('div', 'table-actions');
      const accept = el('button', 'mini js-accept', '接受');
      accept.type = 'button';
      const reject = el('button', 'mini danger js-reject', '拒绝');
      reject.type = 'button';
      box.appendChild(accept); box.appendChild(reject);
      actions.appendChild(box);
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }

  function renderRuns() {
    renderRunRows($('run-rows').querySelector('tbody'), state.runs, 8);
  }

  async function refreshOverview() {
    state.overview = await api('/api/ai/overview');
    renderBriefing();
    renderKpis();
    renderAiMeta();
    renderGuardRules();
    renderRecentRuns();
  }

  async function refreshAgents() {
    const data = await api('/api/agents');
    state.agents = data.items || [];
    renderAgents();
    renderAgentOptions();
  }

  async function refreshReview() {
    const data = await safeGet('/api/review-queue?limit=30');
    state.review = data.items || [];
    renderReview();
  }

  async function refreshEscalations() {
    const data = await safeGet('/api/escalations?status=open&limit=30');
    state.escalations = data.items || [];
    renderEscalations();
  }

  async function refreshSuggestions() {
    const data = await safeGet('/api/suggestions?status=pending&limit=50');
    state.suggestions = data.items || [];
    renderSuggestions();
  }

  async function refreshRuns() {
    const kind = $('runs-kind').value;
    const status = $('runs-state').value;
    const data = await api('/api/ai/runs?limit=100&kind=' + encodeURIComponent(kind)
      + '&state=' + encodeURIComponent(status));
    state.runs = data.items || [];
    renderRuns();
  }

  function renderDenied() {
    state.admin = false;
    $('kpis').classList.add('hidden');
    $('ai-tabs').classList.add('hidden');
    TABS.forEach(([name]) => $('panel-' + name).classList.add('hidden'));
    $('denied').classList.remove('hidden');
    $('briefing-text').textContent = '当前账号不是管理员，无法配置智能体或查看 AI 运行审计。';
    $('ai-badge').className = 'quality-badge warn';
    $('ai-badge').textContent = '需要管理员';
    $('seller').textContent = '店铺 · ' + (state.me.seller_id || '—');
    $('updated').textContent = '只读身份 · ' + fmtTime(new Date().toISOString());
  }

  async function load() {
    const me = await api('/auth/me');
    state.me = me;
    state.admin = me.role === 'admin' && Boolean(me.employee);
    if (!state.admin) { renderDenied(); return; }
    const [overview, agents, tasks, review, escalations, suggestions, runs] = await Promise.all([
      api('/api/ai/overview'),
      api('/api/agents'),
      safeGet('/api/tasks'),
      safeGet('/api/review-queue?limit=30'),
      safeGet('/api/escalations?status=open&limit=30'),
      safeGet('/api/suggestions?status=pending&limit=50'),
      api('/api/ai/runs?limit=100'),
    ]);
    state.overview = overview;
    state.agents = agents.items || [];
    state.tasks = tasks.items || [];
    state.review = review.items || [];
    state.escalations = escalations.items || [];
    state.suggestions = suggestions.items || [];
    state.runs = runs.items || [];
    $('denied').classList.add('hidden');
    $('kpis').classList.remove('hidden');
    $('ai-tabs').classList.remove('hidden');
    $('seller').textContent = '店铺 · ' + (me.seller_id || '—');
    $('updated').textContent = '更新于 ' + fmtTime(overview.generated_at);
    renderBriefing();
    renderKpis();
    renderTabs();
    renderAiMeta();
    renderGuardRules();
    renderRecentRuns();
    renderAgents();
    renderAgentOptions();
    renderTaskSelect();
    renderEscalations();
    renderReview();
    renderSuggestions();
    renderRuns();
    if (state.currentTaskId) {
      loadTaskItems(state.currentTaskId).catch(() => {});
    } else {
      renderItems();
    }
  }

  function bind() {
    $('ag-save').onclick = saveAgent;
    $('ag-cancel').onclick = resetAgentForm;
    $('as-assign').onclick = assignCustomers;
    $('as-list').onclick = listAssignments;
    $('as-clear').onclick = clearAssignments;
    $('task-create').onclick = createTask;
    $('task-refresh').onclick = () => loadTaskItems($('task-select').value || state.currentTaskId);
    $('task-select').onchange = () => loadTaskItems($('task-select').value);
    $('runs-refresh').onclick = () => refreshRuns().catch(() => {});
    $('runs-kind').onchange = () => refreshRuns().catch(() => {});
    $('runs-state').onchange = () => refreshRuns().catch(() => {});

    $('agent-rows').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const tr = button.closest('tr');
      if (!tr || !tr.dataset.id) return;
      const agent = state.agents.find((item) => item.id === tr.dataset.id);
      if (button.classList.contains('js-edit')) { if (agent) fillAgentForm(agent); return; }
      if (button.classList.contains('js-toggle')) toggleAgent(tr.dataset.id, tr.dataset.status);
      else if (button.classList.contains('js-del')) deleteAgent(tr.dataset.id, agent ? agent.name : '');
    });

    $('task-items').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const tr = button.closest('tr');
      if (!tr || !tr.dataset.id) return;
      const id = tr.dataset.id;
      if (button.classList.contains('js-draft')) draftItem(id);
      else if (button.classList.contains('js-approve')) patchItem(id, 'approved');
      else if (button.classList.contains('js-cancel')) patchItem(id, 'cancelled');
      else if (button.classList.contains('js-view')) viewItem(id);
    });

    $('escalations').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button || !button.classList.contains('js-resolve')) return;
      const tr = button.closest('tr');
      resolveEscalation(tr.dataset.id, tr.dataset.name);
    });

    $('review-rows').addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const tr = button.closest('tr');
      const id = tr.dataset.id;
      try {
        if (button.classList.contains('js-approve')) {
          await api('/api/task-items/' + id, { method: 'PATCH', body: { state: 'approved' } });
          say('review-status', '已通过', true);
        } else if (button.classList.contains('js-reject')) {
          await api('/api/task-items/' + id, { method: 'PATCH', body: { state: 'cancelled' } });
          say('review-status', '已驳回', true);
        }
        await refreshReview();
        await refreshOverview();
      } catch (error) {
        say('review-status', '操作失败：' + error.message, false);
      }
    });

    $('suggestion-rows').addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const tr = button.closest('tr');
      const id = tr.dataset.id;
      try {
        if (button.classList.contains('js-accept')) {
          await api('/api/suggestions/' + id + '/accept', { method: 'POST', body: {} });
          say('suggestion-status', '已接受建议', true);
        } else if (button.classList.contains('js-reject')) {
          await api('/api/suggestions/' + id + '/reject', { method: 'POST', body: {} });
          say('suggestion-status', '已拒绝建议', true);
        }
        await refreshSuggestions();
        await refreshOverview();
      } catch (error) {
        say('suggestion-status', '操作失败：' + error.message, false);
      }
    });
  }

  bind();
  mount(load);
})();
