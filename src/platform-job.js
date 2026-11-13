// 长时间的页面采集只立即确认启动；最终结果通过扩展存储交付，避免消息通道超时。
(function () {
  'use strict';
  const active = new Set();
  const key = (jobId) => 'aliPlatformJob:' + jobId;
  const HOUR = 60 * 60 * 1000;
  function sinceMs(lastSuccess, now) {
    const time = Number(now) || Date.now();
    const last = Number(lastSuccess) || time - HOUR;
    return Math.min(time, Math.max(0, last - HOUR));
  }
  function parseTime(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
      const n = Number(value);
      return n < 1e11 ? n * 1000 : n;
    }
    const n = new Date(String(value)).getTime();
    return Number.isFinite(n) ? n : 0;
  }
  function inquiryActivity(item) {
    const keys = ['latest_contact_time', 'latestContactTime', 'lastestContactTime', 'lastContactTime',
      'lastestReplyTime', 'latestReplyTime', 'lastReplyTime'];
    return Math.max(0, ...keys.map((key) => parseTime(item && item[key])));
  }
  async function accountFingerprint(accounts, cryptoApi) {
    const ids = Array.from(new Set((accounts || []).map((a) => String(a && (a.accountId || a.accountIdEncrypt) || '').trim()).filter(Boolean))).sort();
    if (!ids.length) throw new Error('未读取到可核实的卖家账号标识');
    const api = cryptoApi || crypto;
    const bytes = new TextEncoder().encode(ids.join('\u001f'));
    const hash = await api.subtle.digest('SHA-256', bytes);
    return { fingerprint: Array.from(new Uint8Array(hash)).map((n) => n.toString(16).padStart(2, '0')).join('').slice(0, 32), accountCount: ids.length };
  }
  async function recentSnapshots(jobs, byKind, hasSnapshot, now) {
    const preserved = [];
    const time = Number(now) || Date.now();
    for (const job of jobs) {
      if (time - Number(byKind[job.kind] || 0) < 24 * 60 * 60 * 1000
        && await hasSnapshot(job.kind)) preserved.push(job.kind);
    }
    return preserved;
  }

  function start(msg, sendResponse, collect, storage) {
    const jobId = String(msg && msg.jobId || '');
    if (!/^[A-Za-z0-9:_-]{1,120}$/.test(jobId)) {
      sendResponse({ ok: false, error: '无效的采集任务编号' });
      return;
    }
    if (active.has(jobId)) {
      sendResponse({ ok: true, started: true, alreadyRunning: true, jobId });
      return;
    }
    active.add(jobId);
    sendResponse({ ok: true, started: true, jobId });
    Promise.resolve().then(() => collect(msg.kind, !!msg.full, msg))
      .then((result) => storage.set({ [key(jobId)]: { ...result, jobId, at: Date.now() } }))
      .catch((error) => storage.set({ [key(jobId)]: {
        ok: false, jobId, error: error && error.message || String(error), at: Date.now(),
      } }).catch(() => {}))
      .finally(() => active.delete(jobId));
  }

  const api = { key, start, recentSnapshots, sinceMs, parseTime, inquiryActivity, accountFingerprint };
  if (typeof self !== 'undefined') self.AliPlatformJob = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
