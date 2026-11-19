// 工作台 AI 流式对话：复用后台 aiStream Port；上下文只包含页面所需的汇总数据。
(function () {
  'use strict';

  function demandContext(d) {
    return JSON.stringify({
      口径: '访客词来自平台访客字段；询盘词和聊天词只代表沟通语料，不代表平台搜索量',
      访客状态: d.visitorState,
      访客上次入库: d.visitorLastImportAt || '未知',
      指标: d.kpi,
      访客真实搜索词: d.searchTerms.slice(0, 30),
      询盘高频词: d.inquiryWords.slice(0, 20),
      聊天高频词: d.chatWords.slice(0, 20),
    });
  }

  function reportContext(d) {
    const names = new Set(['订单_已核实结果', '订单_状态分布', '询盘_员工确认阶段', '询盘_总览',
      '询盘_国家分布', '询盘_来源分布', '询盘_来源端', '询盘_回复状态', '询盘_负责人',
      '聊天_总览', '聊天_活跃时段', '聊天_高频词(客户侧)']);
    return JSON.stringify({
      口径: '本机已导入资料的历史汇总；生成时间不代表平台数据已实时更新。买家累计订单额不是本店成交额。',
      报表生成时间: d.generatedAt,
      汇总分区: d.sections.filter((s) => names.has(s.name)).map((s) => ({
        名称: s.name, 列: s.header, 数据: s.rows.slice(0, 15),
        仅展示前: Math.min(s.rows.length, 15), 总行数: s.rows.length,
      })),
    });
  }

  function openStream(messages, cfg, onDelta) {
    if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.model)
      throw new Error('还没配置模型：到「设置」里选预设并填写 API Key');
    const port = chrome.runtime.connect({ name: 'aiStream' });
    let settled = false;
    let lastDataAt = Date.now();
    let heartbeat;
    let watchdog;
    const clearTimers = () => { clearInterval(heartbeat); clearInterval(watchdog); };
    const promise = new Promise((resolve, reject) => {
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        try { port.disconnect(); } catch (e) { /* 已断开 */ }
        if (error) reject(error); else resolve();
      };
      port.onMessage.addListener((message) => {
        if (!message || settled) return;
        if (message.type === 'delta') {
          lastDataAt = Date.now();
          onDelta(String(message.text || ''));
        } else if (message.type === 'done') finish();
        else if (message.type === 'error') finish(new Error(message.error || '模型调用失败'));
      });
      port.onDisconnect.addListener(() => finish(new Error('流式连接中断，请重试')));
      heartbeat = setInterval(() => {
        try { port.postMessage({ type: 'ping' }); } catch (e) { finish(new Error('流式连接中断，请重试')); }
      }, 12000);
      watchdog = setInterval(() => {
        if (Date.now() - lastDataAt > 90000) {
          try { port.postMessage({ type: 'abort' }); } catch (e) { /* 已断开 */ }
          finish(new Error('90 秒未收到模型输出，请重试'));
        }
      }, 10000);
      try {
        port.postMessage({
          type: 'aiStream',
          url: String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
          body: JSON.stringify({ model: cfg.model, messages, temperature: 0.3, stream: true }),
        });
      } catch (e) { finish(e); }
    });
    return { promise, abort: () => { try { port.postMessage({ type: 'abort' }); } catch (e) { /* 已断开 */ } } };
  }

  function openDifyStream(query, cfg, onDelta, options) {
    const Dify = self.AliDify;
    if (!Dify) throw new Error('Dify 模块未加载，请重新加载扩展');
    if (!cfg || !cfg.baseUrl || !cfg.apiKey)
      throw new Error('还没配置 Dify：到「设置 → Dify 知识库」填 Base URL 和 API Key');
    const request = Dify.buildDifyRequest(cfg, query, {
      user: (options && options.user) || 'ali-workspace',
      conversationId: (options && options.conversationId) || '',
      inputs: (cfg && cfg.inputs) || {},
    });
    const port = chrome.runtime.connect({ name: 'difyStream' });
    let settled = false;
    let lastDataAt = Date.now();
    let conversationId = '';
    let heartbeat;
    let watchdog;
    const clearTimers = () => { clearInterval(heartbeat); clearInterval(watchdog); };
    const promise = new Promise((resolve, reject) => {
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        try { port.disconnect(); } catch (e) { /* 已断开 */ }
        if (error) reject(error); else resolve({ conversationId });
      };
      port.onMessage.addListener((message) => {
        if (!message || settled) return;
        if (message.type === 'difyEvent') {
          lastDataAt = Date.now();
          if (message.conversationId) conversationId = message.conversationId;
          if (message.error) { finish(new Error(message.error)); return; }
          if (message.text) onDelta(String(message.text));
          if (message.done) finish();
        } else if (message.type === 'done') {
          finish();
        } else if (message.type === 'error') {
          finish(new Error(message.error || 'Dify 调用失败'));
        }
      });
      port.onDisconnect.addListener(() => finish(new Error('Dify 流式连接中断，请重试')));
      heartbeat = setInterval(() => {
        try { port.postMessage({ type: 'ping' }); } catch (e) { finish(new Error('Dify 连接中断，请重试')); }
      }, 12000);
      watchdog = setInterval(() => {
        if (Date.now() - lastDataAt > 90000) {
          try { port.postMessage({ type: 'abort' }); } catch (e) { /* 已断开 */ }
          finish(new Error('90 秒未收到 Dify 输出，请重试'));
        }
      }, 10000);
      try {
        port.postMessage({ type: 'difyStream', url: request.url, headers: request.headers, body: request.body });
      } catch (e) { finish(e); }
    });
    return { promise, abort: () => { try { port.postMessage({ type: 'abort' }); } catch (e) { /* 已断开 */ } } };
  }

  function storeOverviewContext(d) {
    return JSON.stringify({
      口径: '本机已导入资料的历史汇总；成交额按币种分开累计，不跨币种相加；订单为已付款或已完成状态，订单数不是询盘去重数。',
      生成时间: d.generatedAt,
      核心指标: d.kpis,
      转化漏斗: d.funnel,
      近6个月趋势: d.trend,
      国家Top: d.countries,
      来源Top: d.sources,
      资料缺口: d.quality,
    });
  }

  const api = { demandContext, reportContext, storeOverviewContext, openStream, openDifyStream };
  if (typeof self !== 'undefined') self.AliDashboardAI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
