// 数据看板（扩展内置页）：数据来自 IndexedDB，AI 复用扩展里配置的模型
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const A = self.AliAnalyze;
  const DB = self.AliDB;
  const AI_KEY = 'aliAiCfg';
  const AI_PRESETS = [
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'qwen', label: '通义千问（阿里）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'glm', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  ];
  const NAV = [
    ['home', '今日待办'], ['inquiry', '询盘线索'], ['customers', '客户资产'],
    ['demand', '需求词库'], ['library', '资料库'], ['report', '复盘报表'], ['settings', '设置'],
  ];
  const KINDS = DB.KINDS;
  let cur = 'home';
  let CACHE = null;                       // 当前数据集（分析用）
  const charts = {};

  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }
  function chart(id, option) {
    const dom = document.getElementById(id); if (!dom) return;
    if (charts[id]) charts[id].dispose();
    const c = echarts.init(dom); c.setOption(option); charts[id] = c;
  }
  function tbl(header, rows, limit) {
    if (!rows || !rows.length) return '<div class="muted" style="padding:6px 2px;">暂无数据</div>';
    const n = limit || rows.length;
    return '<div class="scroll"><table><thead><tr>' + header.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>'
      + rows.slice(0, n).map((r) => '<tr>' + r.map((c) => '<td>' + (c === null || c === undefined ? '' : c) + '</td>').join('') + '</tr>').join('')
      + '</tbody></table></div>';
  }
  function cards(items) {
    return '<div class="cards">' + items.map(([k, v, h]) =>
      '<div class="card"><div class="k">' + k + '</div><div class="v">' + (v === null || v === undefined ? '-' : v) + '</div><div class="h">' + (h || '') + '</div></div>').join('') + '</div>';
  }
  const concl = (text, note) => '<div class="concl">' + text + (note ? '<small>' + note + '</small>' : '') + '</div>';
  function barKv(title, pairs, horizontal) {
    return {
      title: { text: title, left: 0, textStyle: { fontSize: 13, color: '#374151' } },
      grid: { left: 8, right: 20, top: 34, bottom: 6, containLabel: true },
      tooltip: { trigger: 'axis' },
      xAxis: horizontal ? { type: 'value' } : { type: 'category', data: pairs.map((p) => p[0]), axisLabel: { interval: 0, rotate: 25, fontSize: 11 } },
      yAxis: horizontal ? { type: 'category', data: pairs.map((p) => p[0]), axisLabel: { fontSize: 11 } } : { type: 'value' },
      series: [{ type: 'bar', data: pairs.map((p) => p[1]), itemStyle: { color: '#2563eb', borderRadius: 4 }, barMaxWidth: 20 }],
    };
  }

  function navBar() {
    $('#nav').innerHTML = NAV.map(([k, t]) => '<a data-k="' + k + '" class="' + (k === cur ? 'on' : '') + '">' + t + '</a>').join('');
    $('#nav').querySelectorAll('a').forEach((a) => { a.onclick = () => go(a.dataset.k); });
  }
  function go(k) {
    cur = k;
    Object.keys(charts).forEach((id) => { charts[id].dispose(); delete charts[id]; });
    navBar();
    const fn = { home: loadHome, inquiry: loadInquiry, customers: loadCustomers, demand: loadDemand,
      library: loadLibrary, report: loadReport, settings: loadSettings }[k];
    if (fn) fn();
  }
  async function data() {
    if (CACHE) return CACHE;
    CACHE = await DB.dataset(['inquiry', 'chat', 'customer', 'public_customer', 'visitor']);
    return CACHE;
  }
  function invalidate() { CACHE = null; }

  async function loadStats() {
    const metas = await DB.list();
    const rows = metas.reduce((s, m) => s + (m.rows || 0), 0);
    $('#statLine').innerHTML = '已入库 <b>' + metas.length + '</b> 个文件 / <b>' + rows + '</b> 行';
  }

  function emptyHint() {
    return '<div class="panel">还没有数据。<br>两种方式：① 在扩展面板点「执行导出」——导出成功后<b>会自动入库</b>；'
      + '② 到「资料库」用 <b>导入 xlsx</b> 把已有的导出文件加进来。</div>';
  }

  // ---------------- 今日待办 ----------------
  async function loadHome() {
    $('#view').innerHTML = '<h2>今日待办</h2><div class="muted">加载中…</div>';
    const d = A.home(await data());
    if (!(await DB.list()).length) { $('#view').innerHTML = '<h2>今日待办</h2>' + emptyHint(); return; }
    $('#view').innerHTML = '<h2>今日待办</h2>'
      + concl(esc(d.headline), '数据时间 ' + d.asOf + ' · 口径：近 7 天为新增线索；未转化 = 询盘已来但未加为客户')
      + cards(d.kpi)
      + '<h3>该做的事（按优先级）</h3>'
      + d.todos.map((t) => '<div class="todo"><span class="lv ' + t.level + '">' + t.level + '</span>'
        + '<div style="flex:1;min-width:0;"><div class="t">' + esc(t.title) + ' <span class="tag">' + esc(t.tag) + '</span></div>'
        + '<div class="d">' + esc(t.detail) + '</div></div>'
        + (t.action ? '<div class="a">' + esc(t.action) + ' →</div>' : '') + '</div>').join('')
      + '<div class="muted" style="margin-top:10px;">这里只列最该做的几件事；要全量名单看「询盘线索 / 客户资产」。</div>';
  }

  // ---------------- 询盘线索 ----------------
  async function loadInquiry() {
    $('#view').innerHTML = '<h2>询盘线索</h2><div class="muted">加载中…</div>';
    const d = A.inquiry(await data());
    $('#view').innerHTML = '<h2>询盘线索</h2>'
      + concl(esc(d.headline), '口径：高价值 = 询盘买家等级 A/B 或金牌买家；转化率 = 已加为客户 / 询盘数')
      + cards(d.kpi)
      + '<h3>渠道效果（哪个来源值得加投）</h3><div class="panel">' + tbl(['来源', '询盘数', '已转客户', '转化率%', '高价值'], d.channel) + '</div>'
      + '<div class="grid2"><div class="panel"><div id="c-country" class="chart"></div></div>'
      + '<div class="panel"><div id="c-grade" class="chart"></div></div></div>'
      + '<h3>询盘明细（未转化 / 高价值已排前）</h3><div class="panel">'
      + tbl(['客户', '国家', '等级', '来源', '询盘时间', '已加客户', '未联系天数', '响应(分)', '主题'],
        d.rows.map((r) => [esc(r.name), r.country, r.grade, esc(r.source), r.created, r.added ? '是' : '否', r.wait, r.resp, esc(r.subject)]), 60)
      + '</div>';
    chart('c-country', barKv('国家分布 Top10', d.country, true));
    chart('c-grade', barKv('买家等级分布（A/B 为高价值）', d.grade, false));
  }

  // ---------------- 客户资产 ----------------
  async function loadCustomers() {
    $('#view').innerHTML = '<h2>客户资产</h2><div class="muted">加载中…</div>';
    const d = A.customers(await data());
    const briefRows = (list) => list.map((c) => [esc(c.name), c.country, c.tier, c.member, esc(c.source), c.note]);
    $('#view').innerHTML = '<h2>客户资产</h2>'
      + concl(esc(d.headline), '口径：高价值 = 买家等级 L3/L4，或金牌买家、星标客户')
      + cards(d.kpi)
      + '<div class="grid2"><div class="panel"><div id="c-mtier" class="chart"></div></div>'
      + '<div class="panel"><div id="c-ptier" class="chart"></div></div></div>'
      + '<h3>高价值客户（重点维护）</h3><div class="panel">' + tbl(['公司', '国家', '等级', '会员等级', '来源', '最近备注'], briefRows(d.hot), 40) + '</div>'
      + '<h3>流失预警（本周回访）</h3><div class="panel">' + tbl(['公司', '国家', '等级', '会员等级', '来源', '最近备注'], briefRows(d.risk), 40) + '</div>'
      + '<h3>公海可捡（高价值待领取）</h3><div class="panel">' + tbl(['公司', '国家', '等级', '会员等级', '来源', '最近备注'], briefRows(d.pubHot), 40) + '</div>'
      + '<div class="grid2"><div class="panel"><h3 style="margin-top:0;">我的客户 · 国家 Top</h3>' + tbl(['国家/地区', '数量'], d.mine.country) + '</div>'
      + '<div class="panel"><h3 style="margin-top:0;">我的客户 · 会员等级</h3>' + tbl(['会员等级', '数量'], d.mine.member) + '</div></div>';
    chart('c-mtier', {
      title: { text: '我的客户 ' + d.mine.total + ' · 买家分层', left: 0, textStyle: { fontSize: 13, color: '#374151' } },
      grid: { left: 8, right: 16, top: 34, bottom: 6, containLabel: true }, tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: d.mine.tiers.map((t) => t[0].split(' ')[0]) }, yAxis: { type: 'value' },
      series: [{ type: 'bar', data: d.mine.tiers.map((t) => t[1]), itemStyle: { color: '#7c3aed', borderRadius: 4 } }],
    });
    chart('c-ptier', {
      title: { text: '公海 ' + d.pub.total + ' · 买家分层', left: 0, textStyle: { fontSize: 13, color: '#374151' } },
      grid: { left: 8, right: 16, top: 34, bottom: 6, containLabel: true }, tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: d.pub.tiers.map((t) => t[0].split(' ')[0]) }, yAxis: { type: 'value' },
      series: [{ type: 'bar', data: d.pub.tiers.map((t) => t[1]), itemStyle: { color: '#0e7490', borderRadius: 4 } }],
    });
  }

  // ---------------- 需求词库 ----------------
  async function loadDemand() {
    $('#view').innerHTML = '<h2>需求词库</h2><div class="muted">加载中…</div>';
    const d = A.demand(await data());
    const kws = d.searchTerms.map(([w, n]) => '<span class="kw">' + esc(w) + ' <b>' + n + '</b></span>').join('')
      || '<span class="muted">该时间段没有访客搜索词（访客数据来自「访客导出」）</span>';
    $('#view').innerHTML = '<h2>需求词库</h2>'
      + concl(esc(d.headline), '数据来源：访客「进店来源词 / 搜索关键词」= 买家真实搜索原话（最贴近市场需求）')
      + cards(d.kpi)
      + '<h3>买家在搜什么（访客搜索词，数字=出现次数）</h3><div class="panel"><div>' + kws + '</div></div>'
      + '<div class="panel"><div id="c-terms" class="chart" style="height:' + Math.max(260, Math.min(620, d.searchTerms.length * 24)) + 'px"></div></div>'
      + '<div class="grid2"><div class="panel"><h3 style="margin-top:0;">询盘里提到的词</h3>' + tbl(['词', '次数'], d.inquiryWords) + '</div>'
      + '<div class="panel"><h3 style="margin-top:0;">聊天里客户提到的词</h3>' + tbl(['词', '次数'], d.chatWords) + '</div></div>'
      + '<div class="bar"><button id="d-ai">AI 生成上架关键词建议（用扩展里已配置的模型）</button>'
      + '<span class="muted">只会把统计出的词发给模型，不发聊天原文</span></div><div id="d-advice"></div>';
    chart('c-terms', {
      title: { text: '访客搜索词 Top', left: 0, textStyle: { fontSize: 13, color: '#374151' } },
      grid: { left: 8, right: 40, top: 34, bottom: 6, containLabel: true }, tooltip: { trigger: 'axis' },
      xAxis: { type: 'value' },
      yAxis: { type: 'category', data: d.searchTerms.map((t) => t[0]).reverse(), axisLabel: { fontSize: 11 } },
      series: [{ type: 'bar', data: d.searchTerms.map((t) => t[1]).reverse(), itemStyle: { color: '#0d9488', borderRadius: 3 }, barMaxWidth: 14 }],
    });
    $('#d-ai').onclick = async (e) => {
      const b = e.target; b.disabled = true; b.textContent = '模型分析中…';
      $('#d-advice').innerHTML = '<div class="muted">调用模型中…</div>';
      try {
        const cfg = await loadAiCfg();
        const prompt = '你是资深外贸与阿里国际站运营顾问。下面是从我自己的访客搜索词、询盘主题、客户聊天记录里统计出的关键词。\n'
          + '访客真实搜索词：' + JSON.stringify(d.searchTerms.slice(0, 30)) + '\n'
          + '询盘高频词：' + JSON.stringify(d.inquiryWords.slice(0, 15)) + '\n'
          + '聊天高频词：' + JSON.stringify(d.chatWords.slice(0, 15)) + '\n\n'
          + '请输出中文、结构化、可执行：\n1) 需求聚类：归纳 3-6 个产品/需求簇，各一句客户在买什么。\n'
          + '2) 可上架关键词建议：15 个候选（含长尾/同义/修饰词），标 P0/P1/P2 优先级。\n'
          + '3) 标题写法建议：3 个可直接用的英文产品标题模板。\n4) 缺口与风险：指出没覆盖到的方向。';
        const txt = await aiChat([{ role: 'user', content: prompt }], cfg);
        $('#d-advice').innerHTML = '<div class="panel"><h3 style="margin-top:0;">AI 上架建议</h3><pre class="advice">' + esc(txt) + '</pre></div>';
      } catch (err) {
        $('#d-advice').innerHTML = '<div class="panel warn">' + esc(err.message) + '</div>';
      } finally { b.disabled = false; b.textContent = 'AI 生成上架关键词建议（用扩展里已配置的模型）'; }
    };
  }


  // ---------------- 资料库 ----------------
  function detectKind(header) {
    const h = new Set(header);
    if (h.has('询盘ID')) return 'inquiry';
    if (h.has('发送时间') && h.has('角色')) return 'chat';
    if (h.has('客户ID')) return h.has('进入公海时间') ? 'public_customer' : 'customer';
    if (h.has('访客ID')) return 'visitor';
    return null;
  }
  async function loadLibrary() {
    $('#view').innerHTML = '<h2>资料库</h2>'
      + '<div class="bar"><button id="l-import">导入 xlsx（可多选）</button>'
      + '<button class="ghost" id="l-export">导出数据备份(JSON)</button>'
      + '<button class="ghost" id="l-importJson">导入数据备份</button>'
      + '<button class="ghost" id="l-clear">清空全部</button>'
      + '<span class="muted">导出即自动入库；同名文件自动跳过</span></div>'
      + '<input id="l-file" type="file" accept=".xlsx" multiple style="display:none;">'
      + '<input id="l-file-json" type="file" accept=".json" style="display:none;">'
      + '<div id="l-body"><div class="muted">加载中…</div></div>';
    $('#l-import').onclick = () => $('#l-file').click();
    $('#l-file').onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      let ok = 0, skip = 0, bad = [];
      for (const f of files) {
        try {
          const buf = new Uint8Array(await f.arrayBuffer());
          const wb = XLSX.read(buf, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
          const header = (aoa[0] || []).map((x) => String(x === null || x === undefined ? '' : x).trim());
          const rows = aoa.slice(1).filter((r) => r && r.some((c) => c !== ''));
          const kind = detectKind(header);
          if (!kind) { bad.push(f.name); continue; }
          const r = await DB.ingest({ name: f.name, kind, header, rows, mtime: new Date(f.lastModified).toISOString().slice(0, 19).replace('T', ' '), source: 'import' });
          r.skipped ? skip++ : ok++;
        } catch (err) { bad.push(f.name); }
      }
      invalidate(); loadStats(); renderLibrary();
      toast('导入 ' + ok + ' 个（跳过 ' + skip + '）' + (bad.length ? '，未识别 ' + bad.length + ' 个' : ''));
    };
    $('#l-export').onclick = async () => {
      const pack = await DB.exportJson();
      const blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '国际站数据备份_' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    };
    $('#l-importJson').onclick = () => $('#l-file-json').click();
    $('#l-file-json').onchange = async (e) => {
      const f = (e.target.files || [])[0]; if (!f) return;
      try {
        const r = await DB.importJson(JSON.parse(await f.text()));
        invalidate(); loadStats(); renderLibrary(); toast('已导入 ' + r.imported + ' 个文件');
      } catch (err) { toast('导入失败：' + err.message); }
    };
    $('#l-clear').onclick = async () => {
      if (!confirm('确定清空本机全部已入库数据？（原始 xlsx 文件不受影响）')) return;
      await DB.clearAll(); invalidate(); loadStats(); renderLibrary(); toast('已清空');
    };
    renderLibrary();
  }
  async function renderLibrary() {
    const box = $('#l-body'); if (!box) return;
    const metas = await DB.list();
    if (!metas.length) { box.innerHTML = emptyHint(); return; }
    const cnt = {};
    metas.forEach((m) => { cnt[m.kind] = (cnt[m.kind] || 0) + 1; });
    box.innerHTML = '<div class="panel"><div class="muted" style="margin-bottom:8px;">'
      + Object.keys(KINDS).map((k) => KINDS[k] + ' ' + (cnt[k] || 0)).join(' · ') + '</div>'
      + tbl(['文件名', '类型', '行数', '来源', '文件时间', '入库时间', '操作'],
        metas.map((m) => [esc(m.name), '<span class="tag">' + (KINDS[m.kind] || m.kind) + '</span>', m.rows,
          m.source === 'import' ? '手动导入' : '导出自动入库', m.mtime, m.importedAt,
          '<a class="link" data-del="' + esc(m.name) + '">删除</a>'])) + '</div>';
    box.querySelectorAll('[data-del]').forEach((a) => {
      a.onclick = async () => {
        await DB.removeFile(a.dataset.del); invalidate(); loadStats(); renderLibrary(); toast('已删除');
      };
    });
  }

  // ---------------- 复盘报表 ----------------
  async function loadReport() {
    $('#view').innerHTML = '<h2>复盘报表</h2><div class="muted">加载中…</div>';
    const d = A.report(await data());
    if (!d.sections.length) { $('#view').innerHTML = '<h2>复盘报表</h2>' + emptyHint(); return; }
    $('#view').innerHTML = '<h2>复盘报表</h2>' + concl('完整分区（需要细看时来这里）', '生成时间 ' + d.generatedAt)
      + d.sections.map((s) => '<h3>' + s.name + '</h3><div class="panel">' + tbl(s.header, s.rows, 200) + '</div>').join('');
  }

  // ---------------- 设置 ----------------
  async function loadAiCfg() {
    const o = await chrome.storage.local.get(AI_KEY);
    return (o && o[AI_KEY]) || {};
  }
  async function aiChat(messages, cfg) {
    if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.model) throw new Error('还没配置模型：到「设置」里选预设并填 API Key');
    const res = await chrome.runtime.sendMessage({
      type: 'aiChat',
      url: String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.3 }),
    });
    if (!res) throw new Error('扩展后台无响应');
    if (!res.ok) {
      const t = String(res.text || res.error || '');
      if (res.status === 401) throw new Error('401：模型不认这个密钥（确认 API Key 与 Base URL 属于同一家）｜ ' + t.slice(0, 200));
      throw new Error('HTTP ' + (res.status || '') + ' ' + t.slice(0, 200));
    }
    const j = JSON.parse(res.text);
    return j.choices[0].message.content;
  }
  const maskKey = (k) => (!k ? '未填' : (k.length > 10 ? k.slice(0, 6) + '…' + k.slice(-4) : '已填'));
  async function loadSettings() {
    const c = await loadAiCfg();
    const problem = !c.apiKey ? '还没配置模型（下面选预设并填 API Key）' : null;
    $('#view').innerHTML = '<h2>设置 · AI 模型</h2>'
      + (problem ? '<div class="panel warn">⚠️ ' + esc(problem) + '</div>' : '')
      + '<div class="panel"><div class="muted">与扩展面板的「AI 设置（模型）」<b>共用同一份配置</b>（存本机 chrome.storage.local），改一处即可。仅用于「需求词库 → AI 上架建议」。</div>'
      + '<div class="muted" style="margin-top:6px;">当前生效：<b>' + esc(c.baseUrl || '未填') + '</b> · 模型 <b>' + esc(c.model || '未填') + '</b> · Key <b>' + esc(maskKey(c.apiKey)) + '</b></div>'
      + '<div class="bar" style="margin-top:10px;">预设<select id="s-preset">' + AI_PRESETS.map((p, i) => '<option value="' + i + '">' + p.label + '</option>').join('') + '</select>'
      + '<span class="muted">选预设会自动填 Base URL 与模型</span></div>'
      + '<div class="bar">Base URL <input id="s-url" value="' + esc(c.baseUrl || '') + '" style="width:360px"><span class="muted">服务商接口地址，如 https://api.deepseek.com/v1</span></div>'
      + '<div class="bar">API Key <input id="s-key" type="password" value="' + esc(c.apiKey || '') + '" style="width:360px"><span class="muted">密钥本身，通常以 sk- 开头（<b>不是</b>网址）</span></div>'
      + '<div class="bar">模型 <input id="s-model" value="' + esc(c.model || '') + '" style="width:240px"><span class="muted">如 deepseek-chat / qwen-plus</span></div>'
      + '<div class="bar"><button id="s-save">保存</button><button class="ghost" id="s-test">测试连接</button></div>'
      + '<div id="s-msg" class="muted" style="margin-top:6px;word-break:break-all;"></div></div>'
      + '<div class="panel"><h3 style="margin-top:0;">数据与迁移</h3><div class="muted">'
      + '所有数据存在<b>本机浏览器 IndexedDB</b>，不上传任何服务器。<br>换电脑：装同一个扩展 → 到「资料库」点「导出数据备份(JSON)」在本机导出，再在新电脑「导入数据备份」。<br>'
      + '也可以在任意电脑直接用「导入 xlsx」把导出文件加进来。</div></div>';
    $('#s-preset').onchange = (e) => {
      const p = AI_PRESETS[+e.target.value]; if (!p) return;
      $('#s-url').value = p.baseUrl; $('#s-model').value = p.model;
    };
    $('#s-save').onclick = async () => {
      const cfg = { baseUrl: $('#s-url').value.trim(), apiKey: $('#s-key').value.trim(), model: $('#s-model').value.trim() };
      await chrome.storage.local.set({ [AI_KEY]: cfg });
      if (String(cfg.apiKey).toLowerCase().startsWith('http')) $('#s-msg').innerHTML = '<span style="color:#b91c1c;">已保存，但 API Key 里看起来是网址：密钥（sk- 开头）填 API Key，网址填 Base URL</span>';
      else { toast('已保存'); $('#s-msg').textContent = '已保存，可点「测试连接」验证。'; }
    };
    $('#s-test').onclick = async () => {
      $('#s-msg').textContent = '测试中…';
      try {
        const cfg = { baseUrl: $('#s-url').value.trim(), apiKey: $('#s-key').value.trim(), model: $('#s-model').value.trim() };
        const t = await aiChat([{ role: 'user', content: '只回复：你好' }], cfg);
        $('#s-msg').innerHTML = '<span style="color:#047857;">连接正常：' + esc(String(t).slice(0, 60)) + '</span>';
      } catch (e) { $('#s-msg').innerHTML = '<span style="color:#b91c1c;">' + esc(e.message) + '</span>'; }
    };
  }

  $('#mask').onclick = () => { $('#modal').classList.remove('on'); $('#mask').classList.remove('on'); };
  window.addEventListener('resize', () => Object.keys(charts).forEach((id) => charts[id].resize()));

  navBar(); loadStats(); loadHome();
})();
