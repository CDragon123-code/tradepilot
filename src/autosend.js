// 白名单自动发送：从云端执行队列领取已批准的回复，逐条在聊天窗口发送并回写结果。
// 约束：
//   1) 只在显式开启 + 客户命中白名单时动作，默认完全关闭；
//   2) 每条必须先向云端 claim 到租约，避免多端/重复发送；
//   3) 单轮最多 N 条，条间随机间隔，模拟人工节奏；
//   4) 发送结果三态回写：sent / failed / uncertain（页面未回执时交人工核实）。
(function () {
  'use strict';

  const CFG_KEY = 'aliCloudAutoSend';
  const STATUS_KEY = 'aliCloudAutoSendStatus';
  const PENDING_KEY = 'aliSmartReply';
  const RESULT_KEY = 'aliSmartReplyResult';
  const CHAT_BASE = 'https://onetalk.alibaba.com/message/weblitePWA.htm';
  const DEFAULTS = {
    enabled: false,
    allowlist: [],
    maxPerRun: 2,
    minGapSeconds: 25,
    maxGapSeconds: 60,
    leaseSeconds: 300,
  };
  let running = false;

  function normalize(raw) {
    const c = Object.assign({}, DEFAULTS, raw || {});
    const list = Array.isArray(c.allowlist) ? c.allowlist : String(c.allowlist || '').split(/[\n,]/);
    return {
      enabled: !!c.enabled,
      allowlist: list.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 200),
      maxPerRun: Math.max(1, Math.min(10, Number(c.maxPerRun) || 2)),
      minGapSeconds: Math.max(10, Math.min(600, Number(c.minGapSeconds) || 25)),
      maxGapSeconds: Math.max(10, Math.min(900, Number(c.maxGapSeconds) || 60)),
      leaseSeconds: Math.max(60, Math.min(1800, Number(c.leaseSeconds) || 300)),
    };
  }

  async function loadConfig() {
    const data = await chrome.storage.local.get(CFG_KEY);
    return normalize(data && data[CFG_KEY]);
  }

  async function saveConfig(raw) {
    const cfg = normalize(raw);
    await chrome.storage.local.set({ [CFG_KEY]: cfg });
    return cfg;
  }

  async function cloudConfig() {
    const data = await chrome.storage.local.get('aliCloudConfig');
    const c = data && data.aliCloudConfig;
    if (!c || !c.enabled || !c.baseUrl || !c.token) return null;
    return c;
  }

  async function http(cfg, method, path, body) {
    const res = await fetch(String(cfg.baseUrl).replace(/\/+$/, '') + path, {
      method: method,
      headers: Object.assign({ 'content-type': 'application/json' }, { authorization: 'Bearer ' + cfg.token }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    if (!res.ok) {
      const e = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
      e.status = res.status;
      e.body = data;
      throw e;
    }
    return data;
  }

  // 白名单：空列表不放行；支持客户名、询盘 ID、platform_id 三种写法
  function allowed(cfg, item) {
    if (item.gate && item.gate.allowed === false) return false;
    const list = cfg.allowlist || [];
    if (!list.length) return false;
    const key = String(item.customer_key || '');
    const name = String(item.customer_name || '').trim().toLowerCase();
    return list.some((raw) => {
      const v = String(raw || '').trim();
      if (!v) return false;
      if (v === key) return true;
      if (key.replace(/^inquiry:/, '') === v.replace(/^inquiry:/, '')) return true;
      return !!name && name === v.toLowerCase();
    });
  }

  function sessionNameOf(item) {
    const name = String(item.customer_name || '').trim();
    if (name) return name;
    return String(item.customer_key || '').replace(/^inquiry:/, '');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function gapMs(cfg) {
    const min = cfg.minGapSeconds * 1000;
    const max = Math.max(min, cfg.maxGapSeconds * 1000);
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  async function waitResult(key, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const data = await chrome.storage.local.get(RESULT_KEY);
      const r = data && data[RESULT_KEY];
      if (r && r.key === key) {
        await chrome.storage.local.remove(RESULT_KEY).catch(() => {});
        return r;
      }
      await sleep(700);
    }
    return null;
  }

  async function writeResult(cfg, id, payload) {
    try {
      await http(cfg, 'POST', '/api/executions/' + id + '/result', payload);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function sendOne(cfg, cloud, item) {
    const sessionName = sessionNameOf(item);
    const claimed = await http(cloud, 'POST', '/api/executions/' + item.id + '/claim', {
      client_id: chrome.runtime.id,
      lease_seconds: cfg.leaseSeconds,
    });
    // 领取成功后才打开会话，避免多个客户端同时发送
    await chrome.storage.local.remove(RESULT_KEY).catch(() => {});
    await chrome.storage.local.set({
      [PENDING_KEY]: {
        kind: 'inquiry-reply', key: item.id, customer: sessionName,
        text: claimed.draft_text || item.draft_text, createdAt: Date.now(),
      },
    });
    let tab = null;
    try {
      tab = await chrome.tabs.create({
        url: CHAT_BASE + '?aliChat=' + encodeURIComponent(sessionName) + '&aliSmartReply=1',
        active: true,
      });
      const result = await waitResult(item.id, 90000);
      if (result && result.ok) {
        return { status: 'sent', note: '', detail: await writeResult(cfg, item.id, { status: 'sent', note: 'auto-send' }) };
      }
      if (result) {
        return {
          status: 'failed', note: String(result.error || '页面发送失败').slice(0, 300),
          detail: await writeResult(cfg, item.id, { status: 'failed', note: String(result.error || '页面发送失败').slice(0, 300) }),
        };
      }
      return {
        status: 'uncertain', note: '90 秒内未收到页面发送结果',
        detail: await writeResult(cfg, item.id, { status: 'uncertain', note: '90 秒内未收到页面发送结果，请人工核实' }),
      };
    } catch (e) {
      const note = String((e && e.message) || e).slice(0, 300);
      return { status: 'failed', note: note, detail: await writeResult(cfg, item.id, { status: 'failed', note: note }) };
    } finally {
      await chrome.storage.local.remove(PENDING_KEY).catch(() => {});
      if (tab && tab.id != null) setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 2000);
    }
  }

  async function writeStatus(patch) {
    const prev = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] || {};
    await chrome.storage.local.set({ [STATUS_KEY]: Object.assign({}, prev, patch, { at: Date.now() }) });
  }

  /**
   * 跑一轮自动发送。
   * @param {{force?: boolean}} options force 用于手动触发，忽略 enabled 开关但仍遵守白名单
   */
  async function runOnce(options) {
    const opts = options || {};
    if (running) return { ok: false, skipped: 'busy' };
    const cfg = await loadConfig();
    if (!cfg.enabled && !opts.force) return { ok: false, skipped: 'disabled' };
    if (!cfg.allowlist.length) {
      await writeStatus({ ok: false, lastError: '白名单为空，自动发送不会执行', sent: 0, failed: 0, uncertain: 0 });
      return { ok: false, skipped: 'no_allowlist' };
    }
    const cloud = await cloudConfig();
    if (!cloud) {
      await writeStatus({ ok: false, lastError: '未登录云端或未启用上传', sent: 0, failed: 0, uncertain: 0 });
      return { ok: false, skipped: 'no_cloud' };
    }
    running = true;
    const stat = { sent: 0, failed: 0, uncertain: 0, skipped: 0, errors: [] };
    try {
      const d = await http(cloud, 'GET', '/api/executions?limit=50');
      const candidates = (d.items || []).filter((it) => it.gate && it.gate.allowed && allowed(cfg, it));
      stat.skipped = (d.items || []).length - candidates.length;
      const picked = candidates.slice(0, cfg.maxPerRun);
      for (let i = 0; i < picked.length; i += 1) {
        const item = picked[i];
        try {
          const r = await sendOne(cfg, cloud, item);
          stat[r.status] = (stat[r.status] || 0) + 1;
          if (r.note) stat.errors.push(sessionNameOf(item) + '：' + r.note);
        } catch (e) {
          stat.failed += 1;
          stat.errors.push(sessionNameOf(item) + '：' + ((e && e.message) || e));
        }
        if (i < picked.length - 1) await sleep(gapMs(cfg));
      }
      await writeStatus({
        ok: !stat.errors.length, sent: stat.sent, failed: stat.failed,
        uncertain: stat.uncertain, skipped: stat.skipped,
        lastError: stat.errors.slice(0, 3).join('；'),
        queue: (d.items || []).length, candidates: candidates.length,
      });
      return Object.assign({ ok: true }, stat);
    } catch (e) {
      const msg = String((e && e.message) || e);
      await writeStatus({ ok: false, lastError: msg, sent: 0, failed: 0, uncertain: 0 });
      return { ok: false, error: msg };
    } finally {
      running = false;
    }
  }

  async function status() {
    const cfg = await loadConfig();
    const saved = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] || {};
    return { config: cfg, status: saved, running: running };
  }

  const api = { normalize, loadConfig, saveConfig, allowed, sessionNameOf, runOnce, status, gapMs };
  if (typeof self !== 'undefined') self.AliAutoSend = api;
})();
