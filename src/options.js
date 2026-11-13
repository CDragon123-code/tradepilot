// 选项页：授权访问客户公司官网（用于「未转化客户跟进」的背调）
const $ = (id) => document.getElementById(id);
const has = (origin) => chrome.permissions.contains({ origins: [origin] }).catch(() => false);

async function refresh() {
  try {
    const https = await has('https://*/*');
    const http = await has('http://*/*');
    const ok = https || http;
    $('status').textContent = ok
      ? ('已授权：' + (https ? 'https' : '') + (https && http ? ' + ' : '') + (http ? 'http' : '') + '，可以抓取客户官网')
      : '未授权：客户官网不会被访问';
    $('status').style.color = ok ? '#15803d' : '#b45309';
    $('grant').textContent = ok ? '重新授权' : '授权访问客户官网';
  } catch (e) {
    $('status').textContent = '权限检查失败：' + ((e && e.message) || e);
    $('status').style.color = '#b91c1c';
  }
}

$('grant').onclick = async () => {
  let ok = false;
  // 先一并申请 https + http；失败再单独申请 https（多数官网只需 https）
  try {
    ok = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
  } catch (e) { /* 下一步单独试 */ }
  if (!ok) {
    try { ok = await chrome.permissions.request({ origins: ['https://*/*'] }); } catch (e) { /* ignore */ }
  }
  if (ok) {
    $('status').textContent = '授权成功，可以关闭本页，回到 AI 设置点「抓官网」';
    $('status').style.color = '#15803d';
  } else {
    $('status').textContent = '未授权：可能被浏览器/企业策略拦截，或被点了「取消」';
    $('status').style.color = '#b45309';
  }
  setTimeout(refresh, 300);
};

refresh();

// ---------------- 云端同步 ----------------
const cloudEls = {
  base: $('cloud-base'), token: $('cloud-token'), seller: $('cloud-seller'),
  enabled: $('cloud-enabled'), status: $('cloud-status'),
};

function sayCloud(text, ok) {
  cloudEls.status.textContent = text;
  cloudEls.status.style.color = ok === false ? '#b91c1c' : ok === true ? '#15803d' : '#6b7e96';
}

function describeCloudStatus(s) {
  if (!s) return '云端状态未知';
  const parts = ['本机队列 ' + (s.queued || 0) + ' 条 / ' + (s.queuedRows || 0) + ' 行'];
  if (s.uploaded) parts.push('上次上传 ' + s.uploaded + ' 行');
  if (s.lastError) parts.push('最近错误：' + s.lastError);
  else if (s.ok) parts.push('上次上传成功');
  return parts.join('；');
}

async function refreshCloud() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'cloudStatus' });
    if (!r || !r.ok) throw new Error((r && r.error) || '读取失败');
    cloudEls.base.value = r.config.baseUrl || '';
    cloudEls.token.value = r.config.token || '';
    cloudEls.seller.value = r.config.sellerId || '';
    cloudEls.enabled.checked = !!r.config.enabled;
    sayCloud(describeCloudStatus(r.status), r.status && r.status.ok);
  } catch (e) {
    sayCloud('云端状态读取失败：' + ((e && e.message) || e), false);
  }
}

$('cloud-save').onclick = async () => {
  const baseUrl = cloudEls.base.value.trim();
  const token = cloudEls.token.value.trim();
  if (baseUrl) {
    let origin = '';
    try { origin = new URL(baseUrl).origin + '/*'; } catch (e) { origin = ''; }
    if (!origin) { sayCloud('服务地址格式不正确，请填完整 URL', false); return; }
    try { await chrome.permissions.request({ origins: [origin] }); } catch (e) { /* 授权失败时上传会提示 */ }
  }
  const r = await chrome.runtime.sendMessage({
    type: 'cloudSave',
    config: { baseUrl: baseUrl, token: token, sellerId: cloudEls.seller.value.trim(), enabled: cloudEls.enabled.checked },
  });
  if (!r || !r.ok) { sayCloud('保存失败：' + ((r && r.error) || '未知错误'), false); return; }
  sayCloud('已保存' + (cloudEls.enabled.checked ? '，自动上传已开启' : '，自动上传未开启'), true);
  setTimeout(refreshCloud, 300);
};

$('cloud-backfill').onclick = async () => {
  sayCloud('正在把现有资料库写入队列…');
  const r = await chrome.runtime.sendMessage({ type: 'cloudBackfill' });
  if (!r || !r.ok) { sayCloud('补传失败：' + ((r && r.error) || '未知错误'), false); return; }
  sayCloud('已入队 ' + r.rows + ' 行，队列剩余 ' + (r.result && r.result.remaining || 0) + ' 条', true);
  setTimeout(refreshCloud, 300);
};

$('cloud-drain').onclick = async () => {
  sayCloud('正在上传队列…');
  const r = await chrome.runtime.sendMessage({ type: 'cloudDrain' });
  if (!r || !r.ok) { sayCloud('上传失败：' + ((r && r.error) || '未知错误'), false); return; }
  const res = r.result || {};
  sayCloud('本次上传 ' + (res.uploaded || 0) + ' 行，队列剩余 ' + (res.remaining || 0) + ' 条'
    + (res.lastError ? ('；错误：' + res.lastError) : ''), !res.lastError);
  setTimeout(refreshCloud, 300);
};

refreshCloud();
