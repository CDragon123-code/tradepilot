// 每个工作区独立保存同步游标与覆盖状态；卖家账号指纹只用于阻止跨账号写入。
(function () {
  'use strict';
  const PREFIX = 'aliPlatformSyncStateV2:';
  const key = (workspace) => PREFIX + encodeURIComponent(String(workspace || 'default'));
  const empty = () => ({ fingerprint: '', boundAt: 0, accountError: '', bootstrapComplete: false,
    syncAt: '', syncAtMs: 0, autoAttemptAt: 0, byKind: {}, cursors: {}, sources: {}, orderReconcileAt: 0 });
  async function load(storage, workspace) {
    const name = key(workspace);
    const raw = (await storage.get(name))[name];
    return { ...empty(), ...(raw && typeof raw === 'object' ? raw : {}),
      byKind: { ...((raw && raw.byKind) || {}) },
      cursors: { ...((raw && raw.cursors) || {}) },
      sources: { ...((raw && raw.sources) || {}) } };
  }
  async function save(storage, workspace, change) {
    const next = { ...(await load(storage, workspace)), ...change };
    await storage.set({ [key(workspace)]: next });
    return next;
  }
  function accountError(state, fingerprint, hasFiles) {
    if (!fingerprint) return '无法核实当前阿里卖家账号，已暂停自动更新';
    if (state.fingerprint && state.fingerprint !== fingerprint)
      return '当前登录的卖家账号与此工作区绑定账号不一致，已暂停写入；请切换工作区或阿里账号';
    if (!state.fingerprint && hasFiles)
      return '当前工作区已有旧资料但尚未绑定卖家账号；请在资料库核对后点“绑定当前账号”';
    return '';
  }
  function autoWriteError(file, workspace, state, lock, identity) {
    if (!file || !file.workspace || file.workspace !== workspace || !file.accountFingerprint
      || file.accountFingerprint !== state.fingerprint || !lock || lock.workspace !== workspace
      || lock.fingerprint !== state.fingerprint || !lock.probeTabId)
      return '自动采集文件与当前工作区或绑定账号不一致，已拒绝写入';
    if (identity !== undefined && (!identity || !identity.ok || identity.fingerprint !== state.fingerprint))
      return '卖家账号在采集期间发生变化，已拒绝写入';
    return '';
  }
  function health(state, kind, now) {
    const source = (state.sources || {})[kind] || {};
    const at = Number(source.lastSuccessMs || 0);
    const ageMs = at ? Math.max(0, (Number(now) || Date.now()) - at) : null;
    const staleAfterMs = ['public_customer', 'visitor'].includes(kind) ? 26 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000;
    return { ...source, ageMs, status: !state.fingerprint ? '未绑定账号' : state.accountError ? '账号待核实'
      : source.error ? '更新失败' : source.truncated ? '部分覆盖' : source.coverageGap ? '历史缺口'
        : !at ? '尚未同步' : ageMs > staleAfterMs ? '超过更新周期' : '已更新' };
  }
  const api = { key, empty, load, save, accountError, autoWriteError, health };
  if (typeof self !== 'undefined') self.AliSyncState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
