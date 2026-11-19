'use strict';

// Dify 服务端客户端：单次阻塞问答，返回正文、引用片段与用量
const DEFAULT_BASE = 'https://api.dify.ai/v1';

function normalizeBase(base) {
  let b = String(base || DEFAULT_BASE).trim().replace(/\/+$/, '');
  if (/\/chat-messages$/i.test(b)) b = b.replace(/\/chat-messages$/i, '');
  if (!/\/v\d+$/i.test(b)) b += '/v1';
  return b;
}

// 过滤推理模型的思考过程，避免混进草稿
function cleanAnswer(text) {
  return String(text || '')
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<think[\s\S]*$/i, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

function citationsOf(metadata) {
  const list = (metadata && metadata.retriever_resources) || [];
  return list.slice(0, 8).map((r) => ({
    dataset: r.dataset_name || '',
    document: r.document_name || '',
    segment: r.segment_id || '',
    score: typeof r.score === 'number' ? Number(r.score.toFixed(4)) : null,
    content: String(r.content || '').slice(0, 240),
  }));
}

async function chatOnce(options) {
  const o = options || {};
  if (!o.apiKey) throw new Error('该业务员还没配置 Dify App Key');
  const res = await fetch(normalizeBase(o.baseUrl) + '/chat-messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + o.apiKey },
    body: JSON.stringify({
      inputs: o.inputs || {},
      query: String(o.query || ''),
      response_mode: 'blocking',
      conversation_id: '',
      user: String(o.user || 'ai-agent').slice(0, 64),
      files: [],
    }),
    signal: AbortSignal.timeout(o.timeoutMs || 45000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  if (!res.ok) {
    throw new Error('Dify ' + res.status + '：' + String((json && json.message) || text).slice(0, 200));
  }
  const answer = cleanAnswer(json && (json.answer || (json.data && json.data.answer)));
  if (!answer) throw new Error('Dify 返回空答案');
  const metadata = (json && json.metadata) || {};
  return {
    answer: answer,
    conversationId: String((json && json.conversation_id) || ''),
    citations: citationsOf(metadata),
    model: String(metadata.model_name || ''),
    usage: metadata.usage || {},
  };
}

// 流式问答：逐段回调，最终返回完整正文与引用
async function chatStream(options) {
  const o = options || {};
  if (!o.apiKey) throw new Error('平台还没配置 DIFY_API_KEY');
  const res = await fetch(normalizeBase(o.baseUrl) + '/chat-messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + o.apiKey },
    body: JSON.stringify({
      inputs: o.inputs || {},
      query: String(o.query || ''),
      response_mode: 'streaming',
      conversation_id: '',
      user: String(o.user || 'ai-agent').slice(0, 64),
      files: [],
    }),
    signal: o.signal || AbortSignal.timeout(o.timeoutMs || 60000),
  });
  if (!res.ok) throw new Error('Dify ' + res.status + '：' + String(await res.text()).slice(0, 200));
  if (!res.body || !res.body.getReader) {
    const json = await res.json();
    const answer = cleanAnswer(json && json.answer);
    if (answer && o.onDelta) o.onDelta(answer);
    return { answer: answer, citations: citationsOf(json && json.metadata), model: '', conversationId: '' };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  let model = '';
  let citations = [];
  let conversationId = '';

  const handleLine = (line) => {
    const text = line.trim();
    if (!text || text.charAt(0) === ':' || text.indexOf('data:') !== 0) return false;
    const payload = text.slice(5).trim();
    if (!payload || payload === '[DONE]') return true;
    let obj = null;
    try { obj = JSON.parse(payload); } catch (e) { return false; }
    if (obj.event === 'error') throw new Error(obj.message || 'Dify 返回错误');
    if (obj.conversation_id) conversationId = obj.conversation_id;
    if (obj.answer) {
      raw += obj.answer;
      if (o.onDelta) o.onDelta(obj.answer);
    }
    if (obj.metadata) {
      if (obj.metadata.model_name) model = obj.metadata.model_name;
      const list = citationsOf(obj.metadata);
      if (list.length) citations = list;
    }
    return obj.event === 'message_end';
  };

  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    buffer += decoder.decode(step.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (handleLine(line)) return { answer: cleanAnswer(raw), citations: citations, model: model, conversationId: conversationId };
    }
  }
  if (buffer.trim()) handleLine(buffer);
  return { answer: cleanAnswer(raw), citations: citations, model: model, conversationId: conversationId };
}

module.exports = { chatOnce, chatStream, normalizeBase, citationsOf, cleanAnswer, DEFAULT_BASE };
