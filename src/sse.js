// SSE 流式对话（OpenAI 兼容 /chat/completions）
// 由 service worker（importScripts）与扩展页面（<script>）共用；parseSSE 是纯函数，可在 Node 下单测。
(function () {
  'use strict';

  function extractDelta(obj) {
    const ch = obj && obj.choices && obj.choices[0];
    if (!ch) return '';
    return (ch.delta && ch.delta.content) || (ch.message && ch.message.content) || '';
  }

  // 解析一段 SSE 文本：只吃「完整的行」，最后一行可能是半截，作为 rest 返回
  function parseSSE(text) {
    const deltas = [];
    let done = false;
    const lines = String(text === undefined || text === null ? '' : text).split('\n');
    const rest = lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.charAt(0) === ':') continue;
      if (line.indexOf('data:') !== 0) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { done = true; continue; }
      try {
        const d = extractDelta(JSON.parse(payload));
        if (d) deltas.push(d);
      } catch (e) { /* 半截 JSON，忽略 */ }
    }
    return { deltas, done, rest };
  }

  function httpError(status, text) {
    const t = String(text || '').slice(0, 300);
    if (status === 401) return new Error('401 模型不认这个密钥（确认 API Key 与 Base URL 属于同一家）｜' + t);
    if (status === 404) return new Error('404 地址或模型名不对（Base URL 一般以 /v1 结尾）｜' + t);
    if (status === 429) return new Error('429 限流或余额不足｜' + t);
    return new Error('HTTP ' + status + ' ｜' + t);
  }

  // 流式请求：每收到一段文本就回调 onDelta
  async function streamChat(fetchImpl, url, headers, body, onDelta, signal) {
    const res = await fetchImpl(url, { method: 'POST', headers, body, signal });
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''));
    if (!res.body || !res.body.getReader) {            // 极端兜底：不支持流式
      const j = await res.json();
      const t = extractDelta(j);
      if (t) onDelta(t);
      return t;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      buf += dec.decode(step.value, { stream: true });
      const r = parseSSE(buf);
      buf = r.rest;
      for (let i = 0; i < r.deltas.length; i++) { full += r.deltas[i]; onDelta(r.deltas[i]); }
      if (r.done) break;
    }
    return full;
  }

  const api = { streamChat, parseSSE, extractDelta };
  if (typeof self !== 'undefined') self.AliSSE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
