// Dify 智能客服接入：知识库问答 / 回复草稿。
// API Key 仅由调用方从本机存储读取，本模块不保存任何密钥。
(function () {
  'use strict';

  const DEFAULT_BASE = 'https://api.dify.ai/v1';

  function normalizeConfig(cfg) {
    let base = String((cfg && cfg.baseUrl) || DEFAULT_BASE).trim().replace(/\/+$/, '');
    if (/\/chat-messages$/i.test(base)) base = base.replace(/\/chat-messages$/i, '');
    if (!/\/v\d+$/i.test(base)) base += '/v1';
    return {
      enabled: !!(cfg && cfg.enabled),
      baseUrl: base,
      apiKey: String((cfg && cfg.apiKey) || '').trim(),
    };
  }

  function buildDifyQuery(item, options) {
    const source = item || {};
    const opts = options || {};
    const facts = String(opts.companyFacts || '').trim().slice(0, 2000);
    const transcript = (source.transcript || []).slice(-10).map((message) =>
      (message.at || '') + (message.mine ? ' 业务员：' : ' 客户：') + String(message.text || '').slice(0, 400)).join('\n');
    const demandType = source.demand && source.demand.type;
    const special = demandType === 'denture_mismatch'
      ? '这是一条成品假牙/义齿需求。公司不生产、不销售成品假牙，也不承接假牙加工；请礼貌说明这块帮不上，最多一句话说明公司做齿科 3D 打印树脂（如义齿基托树脂），不推销、不报价、不承诺样品，感谢并祝对方找到合适供应商。'
      : demandType === 'denture_material'
        ? '客户在咨询义齿基托/柔性义齿/牙龈遮蔽等材料，属于目标需求；确认收到并只提出一个澄清问题。'
        : '';
    return [
      '请为外贸业务员生成一条给客户的回复草稿，供员工审核后决定是否发送。',
      '【客户最新消息】',
      source.lastBuyerText || '无（首次询盘）',
      '【询盘信息】',
      '主题：' + (source.subject || '未知') + '；产品：' + (source.product || '未知')
        + '；国家：' + (source.country || '未知') + '；买家等级：' + (source.level || '未知')
        + '；询盘时间：' + (source.createdAt || '未知'),
      '【最近对话】',
      transcript || '无聊天记录',
      '【公司已确认资料】',
      facts || '未提供；不得引用任何价格、参数、认证或交期',
      '【硬性规则】',
      '1. 使用客户最新消息的语言，40-90 词，语气自然、专业、简短。',
      '2. 禁止承诺或编造价格、折扣、交期、库存、认证、付款条件、产品适配性、独家代理或售后结论；客户询问时只说需要确认具体需求后由业务员提供正式信息，不要给出任何数字或时间。',
      '3. 只提出一个最有助于推进的问题。不要编造客户姓名、公司、订单、样品或案例。不要提及 AI。',
      '4. 只输出回复正文。',
      special,
    ].filter(Boolean).join('\n');
  }

  function buildDifyRequest(cfg, query, options) {
    const config = normalizeConfig(cfg);
    const opts = options || {};
    const body = {
      inputs: opts.inputs && typeof opts.inputs === 'object' ? opts.inputs : {},
      query: String(query || ''),
      response_mode: opts.responseMode || 'streaming',
      conversation_id: String(opts.conversationId || ''),
      user: String(opts.user || 'ali-workspace').slice(0, 64),
      files: [],
    };
    return {
      url: config.baseUrl + '/chat-messages',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + config.apiKey,
      },
      body: JSON.stringify(body),
    };
  }

  function httpError(status, text) {
    let message = String(text || '').slice(0, 400);
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.message) message = String(parsed.message);
    } catch (e) { /* 保留原文 */ }
    if (status === 401) return new Error('401 Dify 不认这个 API Key（确认 Key 以 app- 开头且属于该应用）｜' + message);
    if (status === 404) return new Error('404 Dify 地址不对（Base URL 一般以 /v1 结尾）｜' + message);
    if (status === 400) return new Error('400 Dify 请求被拒绝（检查应用是否 Chatflow/Chatbot、输入变量是否必填）｜' + message);
    if (status === 429) return new Error('429 Dify 限流或额度不足｜' + message);
    return new Error('HTTP ' + status + ' ｜' + message);
  }

  // 解析 Dify SSE：保留半截行，返回完整事件。
  function parseDifySSE(text) {
    const events = [];
    let done = false;
    const lines = String(text === undefined || text === null ? '' : text).split('\n');
    const rest = lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.charAt(0) === ':') continue;
      if (line.indexOf('data:') !== 0) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') { done = true; continue; }
      let obj = null;
      try { obj = JSON.parse(payload); } catch (e) { continue; }
      const event = String(obj.event || '');
      const conversationId = String(obj.conversation_id || '');
      if (event === 'error') {
        events.push({ error: String(obj.message || obj.code || 'Dify 返回错误') });
        done = true;
        continue;
      }
      if (event === 'message_end') {
        events.push({ done: true, conversationId });
        done = true;
        continue;
      }
      const answer = obj.answer != null ? String(obj.answer) : (obj.text != null ? String(obj.text) : '');
      if (answer) events.push({ text: answer, conversationId });
    }
    return { events, rest, done };
  }

  // 过滤 DeepSeek 等推理模型回传的 <think> 过程与 HTML 注释，避免出现在草稿里。
  function createThinkFilter() {
    let buf = '';
    let inThink = false;
    return {
      push(text) {
        buf += String(text || '');
        let out = '';
        const holdPrefix = (prefix) => {
          for (let k = Math.min(prefix.length - 1, buf.length); k > 0; k--) {
            if (buf.slice(buf.length - k) === prefix.slice(0, k)) return k;
          }
          return 0;
        };
        for (;;) {
          if (inThink) {
            const end = buf.indexOf('</think');
            if (end < 0) { if (buf.length > 16) buf = buf.slice(buf.length - 16); break; }
            const gt = buf.indexOf('>', end);
            if (gt < 0) break;
            buf = buf.slice(gt + 1);
            inThink = false;
          } else {
            const start = buf.indexOf('<think');
            if (start < 0) {
              // 结尾可能是半个标签（如 "<thi"），先扣住，避免把推理碎片吐出去。
              const hold = Math.max(holdPrefix('<think'), holdPrefix('<!--'));
              out += hold ? buf.slice(0, buf.length - hold) : buf;
              buf = hold ? buf.slice(buf.length - hold) : '';
              break;
            }
            out += buf.slice(0, start);
            const body = buf.slice(start);
            const gt = body.indexOf('>');
            if (gt < 0) { buf = body; break; }
            buf = body.slice(gt + 1);
            inThink = true;
          }
        }
        return out;
      },
      flush() {
        const rest = inThink ? '' : buf;
        buf = '';
        inThink = false;
        return rest;
      },
    };
  }

  function sanitizeAnswer(text) {
    return String(text || '')
      .replace(/<think[\s\S]*?<\/think>/gi, '')
      .replace(/<think[\s\S]*$/i, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<!--[\s\S]*$/g, '')
      .trim();
  }

  async function streamChat(fetchImpl, req, onEvent, signal) {
    const res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: req.body, signal });
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''));
    if (!res.body || !res.body.getReader) {
      const json = await res.json();
      const answer = sanitizeAnswer(json.answer || (json.data && (json.data.answer || json.data.text)) || '');
      if (answer) onEvent({ text: answer, conversationId: String(json.conversation_id || '') });
      onEvent({ done: true, conversationId: String(json.conversation_id || '') });
      return answer;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const filter = createThinkFilter();
    let buffer = '';
    let full = '';
    let conversationId = '';
    const emit = (raw) => {
      const clean = filter.push(raw);
      if (!clean) return;
      full += clean;
      onEvent({ text: clean, conversationId });
    };
    const finish = () => {
      const tail = filter.flush();
      if (tail) { full += tail; onEvent({ text: tail, conversationId }); }
      onEvent({ done: true, conversationId });
      return full;
    };
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });
      const parsed = parseDifySSE(buffer);
      buffer = parsed.rest;
      for (let i = 0; i < parsed.events.length; i++) {
        const event = parsed.events[i];
        if (event.conversationId) conversationId = event.conversationId;
        if (event.error) throw new Error(event.error);
        if (event.text) emit(event.text);
        if (event.done) return finish();
      }
      if (parsed.done) break;
    }
    // 流结束时最后一行可能没有换行符，补一次解析，避免丢最后一段。
    if (buffer) {
      const tail = parseDifySSE(buffer + '\n');
      for (let i = 0; i < tail.events.length; i++) {
        const event = tail.events[i];
        if (event.conversationId) conversationId = event.conversationId;
        if (event.error) throw new Error(event.error);
        if (event.text) emit(event.text);
        if (event.done) return finish();
      }
    }
    return finish();
  }

  async function chatOnce(fetchImpl, cfg, query, inputs) {
    const req = buildDifyRequest(cfg, query, { responseMode: 'blocking', inputs: inputs || {} });
    const res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: req.body });
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''));
    const json = await res.json();
    const answer = sanitizeAnswer(json.answer || (json.data && (json.data.answer || json.data.text)) || '');
    if (!answer) throw new Error('Dify 返回空答案');
    return { answer, conversationId: String(json.conversation_id || '') };
  }

  const api = {
    DEFAULT_BASE, normalizeConfig, buildDifyQuery, buildDifyRequest,
    httpError, parseDifySSE, streamChat, chatOnce,
    createThinkFilter, sanitizeAnswer,
  };
  if (typeof self !== 'undefined') self.AliDify = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
