// 投流诊断：读取营销中心「直通车报告」导出的 Excel，计算 90 天效率结构、预测与优化建议
// 设计：数据解析与指标计算保持纯函数，便于单测；渲染层只在扩展看板中启用
(function () {
  'use strict';

  const KEY = 'aliAdsInsightSnapshot';
  const HISTORY_KEY = 'aliAdsInsightHistory';
  const TYPES = ['account', 'plan', 'product', 'geo', 'term'];

  /* ---------------- 基础解析 ---------------- */
  function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    const s = String(v).replace(/[￥¥,\s]/g, '').replace('%', '');
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  function txt(v) { return String(v === null || v === undefined ? '' : v).trim(); }

  function classify(headers) {
    const h = headers.join('|');
    if (h.includes('计划名称')) return 'plan';
    if (h.includes('商品信息') || h.includes('产品ID')) return 'product';
    if (h.includes('国家/地域')) return 'geo';
    if (h.includes('买家搜索词')) return 'term';
    if (h.includes('全站商机量') && headers[0] === '日期') return 'account';
    return '';
  }

  function toTable(rows) {
    if (!rows || !rows.length) return null;
    const headers = rows[0].map(txt);
    const body = rows.slice(1).filter((r) => r && r.some((c) => txt(c) !== ''));
    return { headers, body };
  }

  function index(headers) {
    const map = {};
    headers.forEach((h, i) => { if (!(h in map)) map[h] = i; });
    return map;
  }

  function normalize(tables) {
    const raw = { account: [], plan: [], product: [], geo: [], term: [], meta: {} };
    const account = tables.account;
    if (account) {
      const ix = index(account.headers);
      const get = (r, k) => (ix[k] === undefined ? '' : r[ix[k]]);
      account.body.forEach((r) => {
        const date = txt(get(r, '日期'));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
        raw.account.push({
          date,
          spend: num(get(r, '花费')),
          leads: num(get(r, '全站商机量')),
          l1leads: num(get(r, 'L1+全站商机量')),
          clicks: num(get(r, '点击量')),
          l1clicks: num(get(r, 'L1+点击量')),
          imps: num(get(r, '曝光量')),
          inq: num(get(r, '全站商机-询盘量')),
          tm: num(get(r, '全站商机-TM咨询量')),
          orders: num(get(r, '全站商机-订单量')),
        });
      });
      raw.account.sort((a, b) => (a.date < b.date ? -1 : 1));
    }
    const plan = tables.plan;
    if (plan) {
      const ix = index(plan.headers);
      const get = (r, k) => (ix[k] === undefined ? '' : r[ix[k]]);
      plan.body.forEach((r) => {
        const name = txt(get(r, '计划名称'));
        if (!name) return;
        raw.plan.push({
          name,
          id: txt(get(r, '计划ID')),
          spend: num(get(r, '花费')),
          leads: num(get(r, '全站商机量')),
          l1leads: num(get(r, 'L1+全站商机量')),
          clicks: num(get(r, '点击量')),
          imps: num(get(r, '曝光量')),
          ctr: num(get(r, '点击率')),
          inq: num(get(r, '全站商机-询盘量')),
          tm: num(get(r, '全站商机-TM咨询量')),
          orders: num(get(r, '全站商机-订单量')),
        });
      });
    }
    const product = tables.product;
    if (product) {
      const ix = index(product.headers);
      const get = (r, k) => (ix[k] === undefined ? '' : r[ix[k]]);
      product.body.forEach((r) => {
        const name = txt(get(r, '商品信息'));
        if (!name) return;
        raw.product.push({
          name,
          id: txt(get(r, '产品ID')),
          clicks: num(get(r, '点击量')),
          leads: ix['全站商机量'] === undefined ? undefined : num(get(r, '全站商机量')),
          l1clicks: num(get(r, 'L1+点击量')),
          l1leads: num(get(r, 'L1+全站商机量')),
          ctr: num(get(r, '点击率')),
          inq: num(get(r, '全站商机-询盘量')),
          tm: num(get(r, '全站商机-TM咨询量')),
          orders: num(get(r, '全站商机-订单量')),
        });
      });
    }
    const geo = tables.geo;
    if (geo) {
      const ix = index(geo.headers);
      const get = (r, k) => (ix[k] === undefined ? '' : r[ix[k]]);
      geo.body.forEach((r) => {
        const name = txt(get(r, '国家/地域'));
        if (!name) return;
        raw.geo.push({
          name,
          clicks: num(get(r, '点击量')),
          leads: ix['全站商机量'] === undefined ? undefined : num(get(r, '全站商机量')),
          l1leads: num(get(r, 'L1+全站商机量')),
          inq: num(get(r, '全站商机-询盘量')),
          tm: num(get(r, '全站商机-TM咨询量')),
          ctr: num(get(r, '点击率')),
        });
      });
    }
    const term = tables.term;
    if (term) {
      const ix = index(term.headers);
      const get = (r, k) => (ix[k] === undefined ? '' : r[ix[k]]);
      term.body.forEach((r) => {
        const name = txt(get(r, '买家搜索词'));
        if (!name) return;
        raw.term.push({ name, clickshare: num(get(r, '点击占比')), impshare: num(get(r, '曝光占比')) });
      });
    }
    raw.meta.types = TYPES.filter((t) => raw[t] && raw[t].length);
    return raw;
  }

  /* ---------------- 指标计算 ---------------- */
  function sum(rows, key) { return rows.reduce((s, r) => s + (Number(r[key]) || 0), 0); }

  function mergeDaily(oldRows, newRows) {
    const map = {};
    (oldRows || []).concat(newRows || []).forEach((r) => { if (r && r.date) map[r.date] = r; });
    return Object.keys(map).sort().slice(-400).map((k) => map[k]);
  }

  function periodStats(rows) {
    const spend = sum(rows, 'spend');
    const leads = sum(rows, 'leads');
    const clicks = sum(rows, 'clicks');
    const imps = sum(rows, 'imps');
    const l1leads = sum(rows, 'l1leads');
    return {
      days: rows.length,
      spend,
      leads,
      clicks,
      imps,
      inq: sum(rows, 'inq'),
      tm: sum(rows, 'tm'),
      orders: sum(rows, 'orders'),
      l1leads,
      cpl: leads ? spend / leads : 0,
      cpc: clicks ? spend / clicks : 0,
      ctr: imps ? (clicks / imps) * 100 : 0,
      l1share: leads ? (l1leads / leads) * 100 : 0,
      activeDays: rows.filter((r) => r.leads > 0).length,
    };
  }

  function monthBuckets(rows) {
    const map = {};
    rows.forEach((r) => {
      const m = r.date.slice(0, 7);
      (map[m] = map[m] || []).push(r);
    });
    return Object.keys(map).sort().map((m) => ({ month: m, stats: periodStats(map[m]) }));
  }

  function weekKey(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return dateStr;
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    const y = d.getFullYear();
    const oneJan = new Date(y, 0, 1);
    const week = Math.ceil((((d - oneJan) / 86400000) + oneJan.getDay() + 1) / 7);
    return y + '-W' + String(week).padStart(2, '0');
  }

  function weekBuckets(rows) {
    const map = {};
    rows.forEach((r) => {
      const k = weekKey(r.date);
      (map[k] = map[k] || []).push(r);
    });
    return Object.keys(map).sort().map((k) => ({
      week: k,
      from: map[k][0].date,
      to: map[k][map[k].length - 1].date,
      stats: periodStats(map[k]),
    }));
  }

  function efficiency(rows, totalClicks, avgCpc) {
    return rows.map((r) => {
      const leads = (r.leads !== undefined ? r.leads : 0) || ((r.inq || 0) + (r.tm || 0));
      const clicks = r.clicks || 0;
      const estSpend = clicks * avgCpc;
      return {
        ...r,
        leads,
        estSpend,
        estCpl: leads ? estSpend / leads : 0,
        leadsPer100: clicks ? (leads / clicks) * 100 : 0,
      };
    });
  }

  function lastNDays(rows, days) {
    if (!rows || !rows.length || !days) return rows || [];
    const end = rows[rows.length - 1].date;
    const endDate = new Date(end + 'T00:00:00');
    const startDate = new Date(endDate.getTime() - (days - 1) * 86400000);
    const start = startDate.getFullYear() + '-' + String(startDate.getMonth() + 1).padStart(2, '0') + '-' + String(startDate.getDate()).padStart(2, '0');
    return rows.filter((r) => r.date >= start);
  }

  function analyze(raw) {
    const allAccount = raw.account || [];
    const account = lastNDays(allAccount, 90);
    const total = periodStats(account);
    const months = monthBuckets(account);
    const weeks = weekBuckets(account);
    const avgCpc = total.cpc;

    const plans = efficiency((raw.plan || []).map((p) => ({
      name: p.name, id: p.id, spend: p.spend, leads: p.leads, clicks: p.clicks,
      ctr: p.ctr, inq: p.inq, tm: p.tm, orders: p.orders, l1leads: p.l1leads,
    })), total.clicks, avgCpc).map((p) => ({
      ...p,
      cpl: p.leads ? p.spend / p.leads : 0,
      cpc: p.clicks ? p.spend / p.clicks : 0,
      share: total.spend ? (p.spend / total.spend) * 100 : 0,
    })).sort((a, b) => b.spend - a.spend);

    const products = efficiency(raw.product || [], total.clicks, avgCpc)
      .sort((a, b) => b.clicks - a.clicks);
    const geo = efficiency(raw.geo || [], total.clicks, avgCpc)
      .sort((a, b) => b.clicks - a.clicks);

    const terms = (raw.term || []).slice().sort((a, b) => b.clickshare - a.clickshare);

    const recs = recommendations({ total, plans, products, geo, months, weeks });
    const prev = raw.meta && raw.meta.prev;
    if (prev) {
      const delta = (cur, old) => (old ? ((cur - old) / old) * 100 : 0);
      const cplUp = delta(total.cpl, prev.cpl);
      const leadDown = delta(total.leads, prev.leads);
      if (cplUp >= 10) recs.unshift({ level: 'P0', title: '商机成本较上次上升 ' + cplUp.toFixed(0) + '%', detail: '从 ¥' + Number(prev.cpl).toFixed(0) + ' 升到 ¥' + total.cpl.toFixed(0) + '，先停止放量并排查商品/国家/否词变化。', action: '当天回调预算与出价' });
      else if (cplUp <= -10) recs.unshift({ level: 'P2', title: '商机成本较上次下降 ' + Math.abs(cplUp).toFixed(0) + '%', detail: '从 ¥' + Number(prev.cpl).toFixed(0) + ' 降到 ¥' + total.cpl.toFixed(0) + '，可小幅加量验证。', action: '预算 +10% 观察 3 天' });
      if (leadDown <= -15) recs.unshift({ level: 'P0', title: '商机量较上次下降 ' + Math.abs(leadDown).toFixed(0) + '%', detail: '上次 ' + prev.leads + ' 个，本次 ' + total.leads + ' 个；先查 TM 咨询与转化率变化。', action: '检查客户接待与话术' });
    }
    const forecast = buildForecast(account);
    return { total, months, weeks, plans, products, geo, terms, recs, forecast, avgCpc, daily: account };
  }

  /* ---------------- 业务联动（本机资料库） ---------------- */
  function parseTime(v) {
    const s = String(v || '').replace(/\//g, '-').trim();
    if (!s) return 0;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
  }
  function moneyNum(v) {
    const n = Number(String(v || '').replace(/[,\s$¥€]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  async function loadBusiness(analysis) {
    try {
      if (typeof self === 'undefined' || !self.AliDB || !self.AliDB.dataset) return null;
      const rows = await self.AliDB.dataset(['inquiry', 'order', 'chat', 'customer', 'public_customer']);
      let stages = {};
      try { if (self.AliDB.stageMap) stages = await self.AliDB.stageMap(); } catch (e) { stages = {}; }
      return buildBusiness(rows, analysis, stages);
    } catch (e) {
      return null;
    }
  }
  // 会话名/客户名归一化：去掉括号内公司后缀与标点，便于聊天会话 ↔ 询盘匹配
  function normPerson(v) {
    return String(v === undefined || v === null ? '' : v).toLowerCase()
      .replace(/[（(][^)）]*[)）]/g, '')
      .replace(/[\s\-_.·,，。、/\\'"]/g, '');
  }
  // 订单里的国家是英文名，直通车地域报告是中文名；统一成中文后再汇总
  const COUNTRY_CN = {
    China: '中国', 'United States': '美国', Bulgaria: '保加利亚', Italy: '意大利', Philippines: '菲律宾',
    India: '印度', Mexico: '墨西哥', Brazil: '巴西', 'Republic of Moldova': '摩尔多瓦', Colombia: '哥伦比亚',
    Spain: '西班牙', Bolivia: '玻利维亚', Vietnam: '越南', 'Saudi Arabia': '沙特阿拉伯', Georgia: '格鲁吉亚',
    Japan: '日本', Ecuador: '厄瓜多尔', Korea: '韩国', 'South Korea': '韩国', Lithuania: '立陶宛',
    Malaysia: '马来西亚', Mauritius: '毛里求斯', 'North Macedonia': '北马其顿', Thailand: '泰国',
    Namibia: '纳米比亚', Peru: '秘鲁', Pakistan: '巴基斯坦', 'United Arab Emirates': '阿联酋',
    Iraq: '伊拉克', Guatemala: '危地马拉', Germany: '德国', France: '法国', 'United Kingdom': '英国',
    Poland: '波兰', Netherlands: '荷兰', Belgium: '比利时', Switzerland: '瑞士', Austria: '奥地利',
    Sweden: '瑞典', Norway: '挪威', Denmark: '丹麦', Finland: '芬兰', Portugal: '葡萄牙', Greece: '希腊',
    Ireland: '爱尔兰', 'Czech Republic': '捷克', Czechia: '捷克', Romania: '罗马尼亚', Hungary: '匈牙利',
    Slovakia: '斯洛伐克', Slovenia: '斯洛文尼亚', Croatia: '克罗地亚', Serbia: '塞尔维亚', Ukraine: '乌克兰',
    Belarus: '白俄罗斯', Kazakhstan: '哈萨克斯坦', Israel: '以色列', Iran: '伊朗', Kuwait: '科威特',
    Qatar: '卡塔尔', Oman: '阿曼', Jordan: '约旦', Lebanon: '黎巴嫩', Morocco: '摩洛哥', Algeria: '阿尔及利亚',
    Tunisia: '突尼斯', Nigeria: '尼日利亚', Kenya: '肯尼亚', Ghana: '加纳', Ethiopia: '埃塞俄比亚',
    Tanzania: '坦桑尼亚', Uganda: '乌干达', Chile: '智利', Argentina: '阿根廷', Venezuela: '委内瑞拉',
    'Costa Rica': '哥斯达黎加', Panama: '巴拿马', 'Dominican Republic': '多米尼加', Uruguay: '乌拉圭',
    Paraguay: '巴拉圭', Turkey: '土耳其', Turkiye: '土耳其', Indonesia: '印度尼西亚', Bangladesh: '孟加拉国',
    'Sri Lanka': '斯里兰卡', Cambodia: '柬埔寨', Myanmar: '缅甸', Australia: '澳大利亚', 'New Zealand': '新西兰',
    Canada: '加拿大', Singapore: '新加坡', 'Hong Kong': '中国香港', Taiwan: '中国台湾',
  };
  function countryCn(v) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!s) return '';
    return COUNTRY_CN[s] || s;
  }
  // 真实首回：聊天表里「客户首条消息 → 业务员第一条回复」，并生成超时名单（高价值 30 分钟 / 普通 2 小时）
  function buildChatSla(chatRows, ad, isHot, since, until) {
    const sessions = {};
    (chatRows || []).forEach((r) => {
      const t = parseTime(r['发送时间']);
      if (!t || (since && t < since) || (until && t > until)) return;
      const key = normPerson(r['会话']);
      if (!key) return;
      const role = String(r['角色'] || '');
      (sessions[key] = sessions[key] || []).push({ t: t, buyer: /客户|buyer/i.test(role), seller: /业务员|seller|我方/i.test(role) });
    });
    const perSession = {};
    const hours = [];
    let noReply = 0;
    Object.keys(sessions).forEach((k) => {
      const msgs = sessions[k].sort((a, b) => a.t - b.t);
      const firstBuyer = msgs.find((m) => m.buyer);
      if (!firstBuyer) return;
      const reply = msgs.find((m) => m.t >= firstBuyer.t && m.seller);
      if (!reply) { noReply += 1; perSession[k] = { hours: Infinity }; return; }
      const h = (reply.t - firstBuyer.t) / 3600000;
      hours.push(h);
      perSession[k] = { hours: h };
    });
    const sorted = hours.slice().sort((a, b) => a - b);
    const total = hours.length + noReply;
    const overdue = [];
    (ad || []).forEach((r) => {
      const key = normPerson(r['客户名称'] || r['姓名']);
      const s = key && perSession[key];
      if (!s) return;
      const hot = isHot(r);
      const target = hot ? 0.5 : 2;
      const h = s.hours;
      if (h === Infinity) overdue.push({ name: String(r['客户名称'] || '').trim() || String(r['询盘ID'] || ''), target: target, hours: null, level: hot ? '高价值' : '普通' });
      else if (h > target) overdue.push({ name: String(r['客户名称'] || '').trim() || String(r['询盘ID'] || ''), target: target, hours: h, level: hot ? '高价值' : '普通' });
    });
    overdue.sort((a, b) => (b.hours === null ? 9999 : b.hours) - (a.hours === null ? 9999 : a.hours));
    return {
      samples: total,
      repliedSamples: hours.length,
      noReply,
      avgHours: hours.length ? hours.reduce((s, v) => s + v, 0) / hours.length : 0,
      p50Hours: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
      within30: total ? (hours.filter((h) => h <= 0.5).length / total) * 100 : 0,
      within120: total ? (hours.filter((h) => h <= 2).length / total) * 100 : 0,
      overdue: overdue.slice(0, 12),
    };
  }
  // 聊天行为推进：样本口径（只有能对上会话的广告客户），识别业务员是否发出报价/样品相关内容
  const CHAT_QUOTE_RE = /报价|价格|单价|quote|price|usd|fob|cif|exw|\$\s?\d|美元/i;
  const CHAT_SAMPLE_RE = /样品|打样|规格|sample|spec|spc/i;
  function buildChatProgress(chatRows, ad) {
    const names = new Set();
    (ad || []).forEach((r) => {
      const k = normPerson(r['客户名称']);
      if (k) names.add(k);
    });
    const sessions = new Set();
    const quote = new Set();
    const sample = new Set();
    (chatRows || []).forEach((r) => {
      const key = normPerson(r['会话']);
      if (!key || !names.has(key)) return;
      sessions.add(key);
      if (!/业务员|seller|我方/i.test(String(r['角色'] || ''))) return;
      const txt = String(r['内容'] || '');
      if (CHAT_QUOTE_RE.test(txt)) quote.add(key);
      if (CHAT_SAMPLE_RE.test(txt)) sample.add(key);
    });
    return { sessions: sessions.size, quote: quote.size, sample: sample.size };
  }
  // 阶段漏斗：取本机阶段数据（询盘当前阶段），推算广告询盘的推进与流失
  function buildFunnel(stages, ad) {
    const counts = {};
    let matched = 0;
    (ad || []).forEach((r) => {
      const id = String(r['询盘ID'] || '').trim();
      const s = id && stages ? stages[id] : null;
      if (!s || !s.stage) return;
      counts[s.stage] = (counts[s.stage] || 0) + 1;
      matched += 1;
    });
    if (!matched) return null;
    const n = ad.length || 0;
    const quoted = (counts['已报价'] || 0) + (counts['样品/规格确认'] || 0) + (counts['已成交'] || 0);
    const sampled = (counts['样品/规格确认'] || 0) + (counts['已成交'] || 0);
    return {
      matched, total: n, counts,
      quoteRate: n ? (quoted / n) * 100 : 0,
      sampleRate: n ? (sampled / n) * 100 : 0,
      wonRate: n ? ((counts['已成交'] || 0) / n) * 100 : 0,
      lostRate: n ? ((counts['已流失'] || 0) / n) * 100 : 0,
    };
  }
  function buildBusiness(rows, analysis, stages) {
    // 与直通车 90 天口径对齐：结束于昨天 23:59:59，避免把今天算进来导致商机/询盘 >100%
    const _now = new Date();
    const endBoundary = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate()).getTime();
    const until = endBoundary - 1;
    const since = endBoundary - 90 * 86400000;
    const CORE = typeof self !== 'undefined' && self.AliDataCore ? self.AliDataCore : null;
    const isAd = (r) => /营销|广告|直通车|mkt/i.test(String(r['来源'] || '') + String(r['来源端'] || ''));
    // 高价值询盘口径与看板一致：字母等级 A/B，或客户库关联到的 L3/L4，或金牌买家
    const isHot = (r) => {
      const levels = [r['买家等级(字母)'], r['买家等级']].map((v) => String(v === undefined || v === null ? '' : v).trim().toUpperCase());
      return levels.some((v) => /^[AB]$/.test(v) || /^L[34]/.test(v)) || String(r['金牌买家'] || '').trim() === '是';
    };
    const inquiries = (rows.inquiry || []).filter((r) => {
      const t = parseTime(r['创建时间'] || r['最新回复时间']);
      return !t || (t >= since && t <= until);
    });
    // 商品名归一化：去空格与标点，降低订单「产品明细」匹配偏差
    const normTxt = (v) => String(v === undefined || v === null ? '' : v).toLowerCase()
      .replace(/[\s\-_/\\.,，。()（）【】[\]]/g, '');
    const ad = inquiries.filter(isAd);
    const hot = ad.filter(isHot).length;
    const added = ad.filter((r) => String(r['是否已加为客户'] || '').trim() === '是').length;
    const replied = ad.filter((r) => String(r['回复状态'] || '').indexOf('已回复') >= 0).length;
    // 资料库只有「最新回复时间」，这里仅作兜底；真实首回由聊天表计算
    const hours = [];
    ad.forEach((r) => {
      const a = parseTime(r['创建时间']);
      const b = parseTime(r['最新回复时间']);
      if (a && b && b >= a) hours.push((b - a) / 3600000);
    });
    const orders = (rows.order || []).filter((r) => {
      const t = parseTime(r['下单时间']);
      return t >= since && t <= until;
    });
    const wonOrder = CORE && CORE.wonOrder
      ? CORE.wonOrder
      : (r) => /已付款|已完成|交易成功|paid|completed|finished/i.test(String(r['订单状态'] || ''));
    const won = orders.filter(wonOrder);
    const inqMap = new Map(inquiries.map((r) => [String(r['询盘ID'] || '').trim(), r]).filter((x) => x[0]));
    // 复用统一客户身份（我的客户/公海客户 + 询盘 + 聊天），把订单回溯到客户档案，再判断该客户是否有广告来源询盘
    const IDX = (typeof self !== 'undefined' && self.AliIdentity && self.AliIdentity.build)
      ? (() => {
        try {
          return self.AliIdentity.build({
            customer: rows.customer || [], public_customer: rows.public_customer || [],
            inquiry: rows.inquiry || [], chat: rows.chat || [],
          });
        } catch (e) { return null; }
      })()
      : null;
    const adsByUid = new Map();
    if (IDX) {
      inquiries.forEach((r) => {
        let uid = '';
        try { uid = IDX.uidOfInquiry(r); } catch (e) { uid = ''; }
        if (!uid) return;
        const at = parseTime(r['创建时间']);
        const cur = adsByUid.get(uid) || { ad: false, at: 0 };
        adsByUid.set(uid, { ad: cur.ad || isAd(r), at: Math.max(cur.at, at) });
      });
    }
    // 客户级归因：客户在历史上（不限 90 天）是否被广告带来过；其后续复购计入广告客户 LTV
    const everAdByUid = new Set();
    const firstAdAt = new Map();
    if (IDX) {
      (rows.inquiry || []).forEach((r) => {
        if (!isAd(r)) return;
        let uid = '';
        try { uid = IDX.uidOfInquiry(r); } catch (e) { uid = ''; }
        if (!uid) return;
        everAdByUid.add(uid);
        const at = parseTime(r['创建时间']);
        if (at && (!firstAdAt.has(uid) || at < firstAdAt.get(uid))) firstAdAt.set(uid, at);
      });
    }
    const uidOfOrder = (o) => {
      if (!IDX) return '';
      try {
        const p = IDX.lookup(o['公司名称']) || IDX.lookup(o['客户名称']);
        return p ? p.uid : '';
      } catch (e) { return ''; }
    };
    // 新客/老客：用「全部历史已确认订单」判断该客户在这笔之前是否已成交（不只看 90 天）
    const firstWinByUid = new Map();
    (rows.order || []).filter(wonOrder).forEach((o) => {
      const uid = uidOfOrder(o);
      if (!uid) return;
      const t = parseTime(o['下单时间']);
      if (!firstWinByUid.has(uid) || t < firstWinByUid.get(uid)) firstWinByUid.set(uid, t);
    });
    // 订单导出没有询盘ID时，用「客户名/公司名」回溯该买家是否有营销来源询盘（估算归因，会单独标注）
    const buyerAdHit = new Map();
    inquiries.forEach((r) => {
      const adFlag = isAd(r);
      const at = parseTime(r['创建时间']);
      [r['客户名称'], r['公司名称']].forEach((v) => {
        const k = normPerson(v);
        if (!k) return;
        const cur = buyerAdHit.get(k) || { ad: false, at: 0 };
        buyerAdHit.set(k, { ad: cur.ad || adFlag, at: Math.max(cur.at, at) });
      });
    });
    let adOrders = 0;
    let adOrdersStrict = 0;
    let adOrdersEstimated = 0;
    let buyerMatched = 0;
    let repeatOrders = 0;
    let adGmv = 0;
    let gmv = 0;
    // 新客/老客/未匹配 × 广告归因 交叉统计；未归因订单清单供业务员核对
    const emptySplit = () => ({ orders: 0, gmv: 0, adOrders: 0, adGmv: 0 });
    const split = { new: emptySplit(), repeat: emptySplit(), unmatched: emptySplit() };
    const unattributed = [];
    let unattributedCount = 0;
    let unattributedGmv = 0;
    // 客户级归因（含复购）：客户历史上被广告带来过，则其成交计入广告客户 LTV
    let ftOrders = 0;
    let ftGmv = 0;
    let ftRepeat = 0;
    const byCountry = {};
    const byProduct = {};
    const adByCountry = {};
    const adByProduct = {};
    won.forEach((o) => {
      const amt = moneyNum(o['成交金额']);
      gmv += amt;
      const iid = String(o['询盘ID'] || '').trim();
      const uid = uidOfOrder(o);
      if (uid) buyerMatched += 1;
      const ot = parseTime(o['下单时间']);
      const firstT = uid ? (firstWinByUid.get(uid) || 0) : 0;
      const isRepeat = !!(uid && ot && firstT && ot > firstT);
      if (isRepeat) repeatOrders += 1;
      const bucket = !uid ? 'unmatched' : (isRepeat ? 'repeat' : 'new');
      let isAdOrder = false;
      let estimated = false;
      if (iid && iid !== '-' && inqMap.has(iid)) {
        isAdOrder = isAd(inqMap.get(iid));
      } else {
        // 先用统一客户身份判断该客户有没有广告来源询盘，再用名称兜底
        let hitAd = false;
        if (uid) {
          const hit = adsByUid.get(uid);
          if (hit && hit.ad) hitAd = true;
        }
        if (!hitAd) {
          const keys = [o['客户名称'], o['公司名称']].map(normPerson).filter(Boolean);
          for (const k of keys) {
            const hit = buyerAdHit.get(k);
            if (hit && hit.ad) { hitAd = true; break; }
          }
        }
        if (hitAd) { isAdOrder = true; estimated = true; }
      }
      if (isAdOrder) {
        adOrders += 1;
        adGmv += amt;
        if (estimated) adOrdersEstimated += 1; else adOrdersStrict += 1;
      }
      const c = countryCn(o['国家/地区'] || o['国家']) || '未知';
      const ftAd = !!(uid && everAdByUid.has(uid));
      if (ftAd) { ftOrders += 1; ftGmv += amt; if (isRepeat) ftRepeat += 1; }
      // 新客/老客/未匹配 × 广告归因
      split[bucket].orders += 1;
      split[bucket].gmv += amt;
      if (isAdOrder) { split[bucket].adOrders += 1; split[bucket].adGmv += amt; }
      if (!isAdOrder) {
        unattributedCount += 1;
        unattributedGmv += amt;
        if (unattributed.length < 200) {
          unattributed.push({
            id: String(o['订单ID'] || ''), name: String(o['客户名称'] || ''), company: String(o['公司名称'] || ''),
            country: c, amount: amt, at: String(o['下单时间'] || ''),
            matched: !!uid, reason: uid ? '客户无营销询盘' : '无客户档案',
          });
        }
      }
      const bump = (map) => {
        map[c] = map[c] || { orders: 0, gmv: 0 };
        map[c].orders += 1;
        map[c].gmv += amt;
      };
      bump(byCountry);
      if (isAdOrder) bump(adByCountry);
      const detail = normTxt(o['产品明细']);
      let pid = '其他';
      if (analysis && detail) {
        // 取命中且名称最长（最具体）的商品，减少同名前缀误匹配
        let best = null;
        (analysis.products || []).forEach((x) => {
          const n = normTxt(x.name).slice(0, 24);
          if (n.length >= 8 && detail.indexOf(n) >= 0 && (!best || n.length > best.len)) best = { p: x, len: n.length };
        });
        if (best) pid = best.p.id || best.p.name.slice(0, 20);
      }
      const bumpProd = (map) => {
        map[pid] = map[pid] || { orders: 0, gmv: 0 };
        map[pid].orders += 1;
        map[pid].gmv += amt;
      };
      bumpProd(byProduct);
      if (isAdOrder) bumpProd(adByProduct);
    });
    const sla = buildChatSla(rows.chat, ad, isHot, since, until);
    const funnel = buildFunnel(stages, ad);
    // 行为漏斗：平台无「报价/样品」阶段字段，用可核实字段拼出「询盘 → 已首回 → 可识别客户 → 已加客户 → 成交」
    const profiled = ad.filter((r) => String(r['客户名称'] || '').trim()).length;
    const addedCount = ad.filter((r) => String(r['是否已加为客户'] || '').trim() === '是').length;
    const repliedAd = ad.filter((r) => String(r['回复状态'] || '').indexOf('已回复') >= 0).length;
    const chatProgress = buildChatProgress(rows.chat, ad);
    const stageFunnel = {
      total: ad.length,
      replied: repliedAd,
      profiled,
      added: addedCount,
      won: adOrders,
      chatSessions: chatProgress.sessions,
      chatQuote: chatProgress.quote,
      chatSample: chatProgress.sample,
    };
    const useChatSla = sla.repliedSamples > 0;
    const firstReplyHours = useChatSla ? sla.avgHours : (hours.length ? hours.reduce((s, v) => s + v, 0) / hours.length : 0);
    const graded = ad.filter((r) => String(r['买家等级(字母)'] || r['买家等级'] || '').trim()).length;
    const gradeCoverage = ad.length ? (graded / ad.length) * 100 : 0;
    // 广告客户 LTV：历史被广告带来过的客户，其全部已确认成交 / 有成交客户数
    let ltvGmv = 0;
    const ltvUids = new Set();
    (rows.order || []).filter(wonOrder).forEach((o) => {
      const uid = uidOfOrder(o);
      if (!uid || !everAdByUid.has(uid)) return;
      ltvGmv += moneyNum(o['成交金额']);
      ltvUids.add(uid);
    });
    // 广告获客 → 首单：转化率与平均首单周期（广告询盘创建 → 首次成交）
    let daysSum = 0;
    let daysCount = 0;
    ltvUids.forEach((uid) => {
      const adAt = firstAdAt.get(uid);
      const wonAt = firstWinByUid.get(uid);
      if (adAt && wonAt && wonAt >= adAt) { daysSum += (wonAt - adAt) / 86400000; daysCount += 1; }
    });
    const firstTouch = {
      customers: everAdByUid.size,
      orders: ftOrders,
      gmv: ftGmv,
      repeatOrders: ftRepeat,
      ltvGmv,
      ltvCustomers: ltvUids.size,
      ltv: ltvUids.size ? ltvGmv / ltvUids.size : 0,
      firstOrderRate: everAdByUid.size ? (ltvUids.size / everAdByUid.size) * 100 : 0,
      avgFirstOrderDays: daysCount ? daysSum / daysCount : 0,
    };
    const gaps = [];
    if (!inquiries.length) gaps.push('本机资料库暂无询盘数据，无法评估商机质量');
    if (!won.length) gaps.push('本机资料库暂无近 90 天已确认订单，成交 ROI 暂不可算');
    if (won.length && !adOrders) gaps.push('订单缺少可匹配的询盘ID，广告成交无法归因（建议订单导出补全询盘ID）');
    if (adOrdersEstimated) gaps.push('订单未带询盘ID：可匹配客户 ' + buyerMatched + '/' + won.length + ' 单，其中广告来源估算 ' + adOrdersEstimated + ' 单' + (repeatOrders ? '；另有 ' + repeatOrders + ' 单为老客复购' : ''));
    if (ad.length && gradeCoverage < 50) gaps.push('买家等级缺失 ' + Math.round(100 - gradeCoverage) + '%，高价值询盘占比会偏低');
    const profileRate = ad.length ? (profiled / ad.length) * 100 : 0;
    if (ad.length && profileRate < 50) gaps.push('广告商机买家资料缺口 ' + Math.round(100 - profileRate) + '%：' + (ad.length - profiled) + ' 条没有客户名称/公司（多为 TM 商机未补全），无法识别身份、补等级与归因');
    if (!useChatSla) gaps.push('聊天资料为空，首回时长按「创建→最新回复」估算，偏大');
    if (!funnel) gaps.push('询盘阶段数据为空，改用「已首回→可识别客户→已加客户→成交」行为漏斗（平台无报价/样品阶段字段）');
    return {
      adInquiries: ad.length,
      totalInquiries: inquiries.length,
      hotShare: ad.length ? (hot / ad.length) * 100 : 0,
      gradeCoverage,
      addedRate: ad.length ? (added / ad.length) * 100 : 0,
      replyRate: ad.length ? (replied / ad.length) * 100 : 0,
      firstReplyHours,
      firstReplySource: useChatSla ? 'chat' : 'inquiry',
      sla,
      funnel,
      stageFunnel,
      orders: won.length,
      gmv,
      adOrders,
      adOrdersStrict,
      adOrdersEstimated,
      buyerMatched,
      repeatOrders,
      split,
      firstTouch,
      unattributedCount,
      unattributedGmv,
      unattributed,
      adGmv,
      byCountry,
      adByCountry,
      byProduct,
      adByProduct,
      gaps,
    };
  }
  /* ---------------- 价值杠杆：数量 vs 客单价 ---------------- */
  function valueAdvice(r, bench) {
    const conv = r.conv || 0;
    const aov = r.aov || 0;
    // 有全渠道成交但没归因到广告：先提示核对，不能按“0 成交”给优化建议
    if (!r.wonOrders && (r.allOrders || 0) > 0) return '有成交但未归因（核对询盘ID）';
    // 低客单价 + 高转化：单量看着好，但收益薄，要先提客单而不是盲目放量
    if (r.wonOrders > 0 && bench.convAll > 0 && bench.aovAll > 0
      && conv >= bench.convAll * 1.3 && aov <= bench.aovAll * 0.6) {
      return '高转化低客单（提客单）';
    }
    if (r.wonOrders > 0) {
      if (r.gmvPer100 >= bench.gmvPer100All * 1.2) return r.clicks <= bench.avgClicks * 1.2 ? '加投（高产值）' : '维持（高产值）';
      if (r.gmvPer100 >= bench.gmvPer100All * 0.6) return '维持';
      return '控成本（有成交但效率低）';
    }
    if (r.clicks >= 50 && !r.leads) return '降价或暂停';
    if (r.leads > 0) return '优化转化';
    return '观望';
  }

  function valueModel(a, biz, econ) {
    if (!a || !a.total || !biz) return null;
    const orders = biz.orders || 0;
    const adOrders = biz.adOrders || 0;
    const aov = orders ? biz.gmv / orders : 0;
    const adAov = adOrders ? biz.adGmv / adOrders : 0;
    const adInquiries = biz.adInquiries || 0;
    const convRate = adInquiries ? (adOrders / adInquiries) * 100 : 0;
    const leadToInquiry = a.total.leads ? (adInquiries / a.total.leads) * 100 : 0;
    const convPer100Leads = a.total.leads ? (adOrders / a.total.leads) * 100 : 0;
    const valuePer100Leads = a.total.leads ? (biz.adGmv / a.total.leads) * 100 : 0;
    const spendPerOrder = adOrders ? a.total.spend / adOrders : 0;
    // 价值矩阵只用「可归因到广告」的成交，避免自然单抬高产值
    const gmvPer100All = a.total.clicks ? (biz.adGmv / a.total.clicks) * 100 : 0;
    const convAll = a.total.leads ? (adOrders / a.total.leads) * 100 : 0;
    const adCountry = biz.adByCountry || biz.byCountry || {};
    const adProduct = biz.adByProduct || biz.byProduct || {};
    const allCountry = biz.byCountry || {};
    const allProduct = biz.byProduct || {};
    const avgGeoClicks = a.geo && a.geo.length
      ? a.geo.reduce((s, g) => s + (g.clicks || 0), 0) / a.geo.length : 0;
    const bench = { gmvPer100All: gmvPer100All, avgClicks: avgGeoClicks, convAll: convAll, aovAll: aov };
    const geoRows = (a.geo || []).map((g) => {
      const v = adCountry[g.name] || { orders: 0, gmv: 0 };
      const all = allCountry[g.name] || { orders: 0, gmv: 0 };
      const row = {
        name: g.name, clicks: g.clicks || 0, leads: g.leads || 0, leadsPer100: g.leadsPer100 || 0,
        wonOrders: v.orders, gmv: v.gmv, gmvPer100: g.clicks ? (v.gmv / g.clicks) * 100 : 0,
        aov: v.orders ? v.gmv / v.orders : 0,
        conv: g.leads ? (v.orders / g.leads) * 100 : 0,
        allOrders: all.orders, allGmv: all.gmv,
      };
      row.advice = valueAdvice(row, bench);
      return row;
    }).sort((x, y) => y.gmv - x.gmv || y.clicks - x.clicks);
    const avgProdClicks = a.products && a.products.length
      ? a.products.reduce((s, p) => s + (p.clicks || 0), 0) / a.products.length : 0;
    const prodBench = Object.assign({}, bench, { avgClicks: avgProdClicks });
    const productRows = (a.products || []).map((p) => {
      const key = p.id || p.name.slice(0, 20);
      const v = adProduct[key] || { orders: 0, gmv: 0 };
      const all = allProduct[key] || { orders: 0, gmv: 0 };
      const row = {
        key: key, name: p.name, clicks: p.clicks || 0, leads: p.leads || 0, leadsPer100: p.leadsPer100 || 0,
        wonOrders: v.orders, gmv: v.gmv, gmvPer100: p.clicks ? (v.gmv / p.clicks) * 100 : 0,
        aov: v.orders ? v.gmv / v.orders : 0,
        conv: p.leads ? (v.orders / p.leads) * 100 : 0,
        allOrders: all.orders, allGmv: all.gmv,
      };
      row.advice = valueAdvice(row, prodBench);
      return row;
    }).sort((x, y) => y.gmv - x.gmv || y.clicks - x.clicks);
    const other = adProduct['其他'] || { orders: 0, gmv: 0 };
    // 汇率 + 毛利率：把美元成交额换成人民币毛利，算毛利 ROI 与盈亏平衡 CPL
    const cfg = econ || {};
    const fx = Number(cfg.fx) > 0 ? Number(cfg.fx) : 0;
    const margin = Number(cfg.margin) >= 0 && Number(cfg.margin) <= 1 ? Number(cfg.margin) : 0;
    const adGmvCny = fx ? biz.adGmv * fx : 0;
    const grossProfit = adGmvCny * margin;
    const grossPerOrder = adOrders ? grossProfit / adOrders : 0;
    return {
      hasValue: orders > 0,
      orders, adOrders, adInquiries,
      adOrdersStrict: biz.adOrdersStrict || 0,
      adOrdersEstimated: biz.adOrdersEstimated || 0,
      buyerMatched: biz.buyerMatched || 0,
      repeatOrders: biz.repeatOrders || 0,
      firstTouch: biz.firstTouch || null,
      gradeCoverage: biz.gradeCoverage || 0,
      gmv: biz.gmv, adGmv: biz.adGmv, aov, adAov, cpl: a.total.cpl,
      convRate, leadToInquiry, convPer100Leads, valuePer100Leads, spendPerOrder, gmvPer100All, convAll,
      geoRows, productRows,
      unmatchedOrders: other.orders, unmatchedGmv: other.gmv,
      econ: {
        fx: fx, margin: margin,
        adGmvCny: adGmvCny,
        grossProfit: grossProfit,
        grossRoi: a.total.spend ? grossProfit / a.total.spend : 0,
        grossPerOrder: grossPerOrder,
        breakEvenCpl: a.total.leads ? (adOrders / a.total.leads) * grossPerOrder : 0,
        enabled: !!(fx && margin > 0),
      },
    };
  }

  function valueRecs(a, vm) {
    const out = [];
    if (!vm || !vm.hasValue) return out;
    if (vm.firstTouch && vm.firstTouch.orders > vm.adOrders && vm.firstTouch.gmv > vm.adGmv) {
      out.push({ level: 'P1', title: '广告价值被直接归因低估', detail: '直接归因 ' + vm.adOrders + ' 单 / $' + Math.round(vm.adGmv) + '；客户级归因 ' + vm.firstTouch.orders + ' 单 / $' + Math.round(vm.firstTouch.gmv) + '（含复购 ' + vm.firstTouch.repeatOrders + ' 单）；广告获客客户 LTV $' + Math.round(vm.firstTouch.ltv) + '。', action: '考核加入客户级 LTV，避免只看本单 ROI 削减预算' });
    }
    if (vm.firstTouch && vm.firstTouch.customers >= 50 && vm.firstTouch.firstOrderRate < 2) {
      out.push({ level: 'P1', title: '广告获客首单转化率仅 ' + pct(vm.firstTouch.firstOrderRate, 1), detail: '历史广告获客 ' + vm.firstTouch.customers + ' 个客户，只有 ' + vm.firstTouch.ltvCustomers + ' 个成交' + (vm.firstTouch.avgFirstOrderDays ? '，平均首单 ' + Math.round(vm.firstTouch.avgFirstOrderDays) + ' 天' : '') + '。', action: '优先排查首回/报价/样品卡点，并对未成交广告客户做二次激活' });
    }
    const geoLow = vm.geoRows.filter((r) => r.advice.indexOf('高转化低客单') >= 0).slice(0, 4);
    if (geoLow.length) {
      out.push({ level: 'P1', title: '高转化但低客单价的国家', detail: geoLow.map((r) => r.name + '（成交 ' + r.wonOrders + ' 单，转化率 ' + r.conv.toFixed(1) + '%，客单价 $' + Math.round(r.aov) + '）').join('、') + '；单量好看但收益薄。', action: '先提客单：捆绑耗材/配件、设起订量、主推高配款，再考虑放量' });
    }
    const prodLow = vm.productRows.filter((r) => r.advice.indexOf('高转化低客单') >= 0).slice(0, 4);
    if (prodLow.length) {
      out.push({ level: 'P1', title: '高转化但低客单价的商品', detail: prodLow.map((r) => (r.key || r.name.slice(0, 10)) + '（成交 ' + r.wonOrders + ' 单，转化率 ' + r.conv.toFixed(1) + '%，客单价 $' + Math.round(r.aov) + '）').join('、') + '。', action: '搭配高客单组合或升级款，避免只靠低价款冲单量' });
    }
    // 有成交但没归因到广告：提示核询盘ID，而不是当作 0 成交去暂停
    const geoGap = vm.geoRows.filter((r) => !r.wonOrders && r.allOrders > 0).slice(0, 4);
    if (geoGap.length) {
      out.push({ level: 'P1', title: '有成交但广告未归因的国家', detail: geoGap.map((r) => r.name + '（全部 ' + r.allOrders + ' 单 / $' + Math.round(r.allGmv || 0) + '）').join('、') + '。', action: '核对订单询盘ID或客户名归因后再决定加减预算' });
    }
    const prodGap = vm.productRows.filter((r) => !r.wonOrders && r.allOrders > 0).slice(0, 4);
    if (prodGap.length) {
      out.push({ level: 'P1', title: '有成交但广告未归因的商品', detail: prodGap.map((r) => (r.key || r.name.slice(0, 10)) + '（全部 ' + r.allOrders + ' 单 / $' + Math.round(r.allGmv || 0) + '）').join('、') + '。', action: '补全订单询盘ID后复核，避免误判为低效商品' });
    }
    const geoHigh = vm.geoRows.filter((r) => !r.wonOrders && !r.allOrders && r.leadsPer100 >= 6 && r.clicks >= 50).slice(0, 4);
    if (geoHigh.length) {
      out.push({ level: 'P1', title: '高商机但 0 成交的国家', detail: geoHigh.map((r) => r.name + '（商机 ' + r.leads + '，百点击商机 ' + r.leadsPer100.toFixed(1) + '）').join('、') + '，数量多但没带来成交。', action: '收紧人群/否词，或换更高客单商品测试' });
    }
    const geoValue = vm.geoRows.filter((r) => r.wonOrders > 0 && r.gmvPer100 >= vm.gmvPer100All * 1.5 && r.clicks < 100).slice(0, 4);
    if (geoValue.length) {
      out.push({ level: 'P1', title: '低量高价值的国家', detail: geoValue.map((r) => r.name + '（成交 ' + r.wonOrders + ' 单 / $' + Math.round(r.gmv) + '，点击仅 ' + r.clicks + '）').join('、') + '。', action: '小步加投验证，优先高客单商品' });
    }
    const prodHigh = vm.productRows.filter((r) => !r.wonOrders && !r.allOrders && r.leadsPer100 >= 6 && r.clicks >= 50).slice(0, 4);
    if (prodHigh.length) {
      out.push({ level: 'P1', title: '商机多但无成交的商品', detail: prodHigh.map((r) => (r.key || r.name.slice(0, 10)) + '（商机 ' + r.leads + '）').join('、') + '。', action: '换主图/详情或降出价，优先测试高客单款' });
    }
    const prodValue = vm.productRows.filter((r) => r.wonOrders > 0 && r.gmvPer100 >= vm.gmvPer100All * 1.5 && r.clicks < 100).slice(0, 4);
    if (prodValue.length) {
      out.push({ level: 'P1', title: '低量高价值的商品', detail: prodValue.map((r) => (r.key || r.name.slice(0, 10)) + '（成交 ' + r.wonOrders + ' 单 / $' + Math.round(r.gmv) + '）').join('、') + '。', action: '加预算与选品曝光，主推高客单组合' });
    }
    if (vm.adOrders >= 2 && vm.aov > 0 && vm.adAov > 0 && vm.adAov < vm.aov * 0.8) {
      out.push({ level: 'P1', title: '广告成交客单价偏低', detail: '广告关联客单价 $' + Math.round(vm.adAov) + '，低于全部成交 $' + Math.round(vm.aov) + '；单量有但收益薄。', action: '优先推整机/高配组合，减少低客单引流' });
    }
    return out;
  }

  function valueHtml(vm) {
    if (!vm || !vm.hasValue) {
      return panel('价值杠杆（客单价 × 成交）', '<div class="muted">本机资料库暂无近 90 天已确认订单，无法按「数量 vs 客单价」评估；先在「资料库」同步或导入订单后自动补算。</div>');
    }
    const geo = vm.geoRows.filter((r) => r.wonOrders > 0 || r.clicks >= 50).slice(0, 8);
    const prod = vm.productRows.filter((r) => r.wonOrders > 0 || r.clicks >= 50).slice(0, 8);
    const econ = vm.econ || { fx: 7.2, margin: 0.3, enabled: false };
    const cpl = vm.cpl || 0;
    const econGap = econ.breakEvenCpl ? (econ.breakEvenCpl - cpl) : 0;
    return panel('价值杠杆（数量 vs 客单价 · 近 90 天）',
      '<div class="muted" style="margin-bottom:8px">不只看商机数与 CPL，重点看「每百点击成交额」「客单价」和「转化率」：成交额高的国家/商品优先加投；商机多但 0 成交的先收紧；转化高但客单价低的先提客单（捆绑、起订量、高配款），不要盲目放量低价单。</div>'
      + '<div class="cards">'
      + card('广告客单价', '$' + Math.round(vm.adAov), '全部成交 $' + Math.round(vm.aov))
      + card('询盘→成交率', pct(vm.convRate, 1), '商机→询盘 ' + pct(vm.leadToInquiry, 1) + '（可 >100%，一条商机多条询盘）')
      + card('每 100 商机成交', vm.convPer100Leads.toFixed(1) + ' 单', '约 $' + Math.round(vm.valuePer100Leads))
      + card('广告单均花费', vm.spendPerOrder ? money(vm.spendPerOrder) : '待归因', '花费 / 广告成交单')
      + card('成交额', '$' + Math.round(vm.gmv), '广告关联 $' + Math.round(vm.adGmv) + (vm.gmv ? '（占 ' + pct((vm.adGmv / vm.gmv) * 100, 0) + '）' : ''))
      + card('毛利 ROI', econ.enabled ? (econ.grossRoi * 100).toFixed(0) + '%' : '待配置',
        econ.enabled ? '毛利 ¥' + Math.round(econ.grossProfit) + ' / 花费' : '设置汇率与毛利率后计算')
      + card('盈亏平衡 CPL', econ.enabled ? money(econ.breakEvenCpl) : '待配置',
        econ.enabled ? (econGap >= 0 ? '当前 ' + money(cpl) + '，尚有 ¥' + Math.round(econGap) + ' 空间' : '当前 ' + money(cpl) + '，已超出 ¥' + Math.round(-econGap)) : '按每单毛利折算')
      + '</div>'
      + (vm.firstTouch ? '<div style="margin-top:4px"><h3>归因口径对比</h3>'
        + table(['口径', '成交单', '成交额', '说明'], [
          ['直接归因（本单可追溯营销询盘）', vm.adOrders, '$' + Math.round(vm.adGmv), '保守：只算本单前 90 天'],
          ['客户级归因（客户历史被广告带来过）', vm.firstTouch.orders, '$' + Math.round(vm.firstTouch.gmv), '含复购，评估广告 LTV'],
          ['全部成交', vm.orders, '$' + Math.round(vm.gmv), '含自然流量/老客'],
        ])
        + '<div class="muted" style="margin-top:6px">广告获客客户 ' + vm.firstTouch.customers + ' 个；其中有成交 ' + vm.firstTouch.ltvCustomers
        + ' 个，累计成交额 $' + Math.round(vm.firstTouch.ltvGmv) + '，单客 LTV $' + Math.round(vm.firstTouch.ltv)
        + '；客户级归因中含复购 ' + vm.firstTouch.repeatOrders + ' 单。</div>'
        + '<div class="muted" style="margin-top:4px">广告获客漏斗：' + vm.firstTouch.customers + ' 个广告客户 → '
        + vm.firstTouch.ltvCustomers + ' 个首单（' + pct(vm.firstTouch.firstOrderRate, 1) + '）'
        + (vm.firstTouch.avgFirstOrderDays ? '；平均首单 ' + Math.round(vm.firstTouch.avgFirstOrderDays) + ' 天' : '')
        + '。</div></div>' : '')
      + '<div style="margin-top:10px"><h3>国家价值矩阵（广告成交）</h3>' + table(['国家', '点击', '商机', '广告成交', '全部成交', '广告成交额', '全部成交额', '客单价', '转化率', '百点击成交额', '策略'],
        geo.map((r) => [esc(r.name), r.clicks, r.leads, r.wonOrders, r.allOrders, '$' + Math.round(r.gmv), '$' + Math.round(r.allGmv || 0), r.wonOrders ? '$' + Math.round(r.aov) : '—', r.leads ? pct(r.conv, 1) : '—', '$' + Math.round(r.gmvPer100), esc(r.advice)])) + '</div>'
      + '<div style="margin-top:10px"><h3>商品价值矩阵（广告成交）</h3>' + table(['商品', '点击', '商机', '广告成交', '全部成交', '广告成交额', '全部成交额', '客单价', '转化率', '百点击成交额', '策略'],
        prod.map((r) => [esc(r.key || r.name.slice(0, 18)), r.clicks, r.leads, r.wonOrders, r.allOrders, '$' + Math.round(r.gmv), '$' + Math.round(r.allGmv || 0), r.wonOrders ? '$' + Math.round(r.aov) : '—', r.leads ? pct(r.conv, 1) : '—', '$' + Math.round(r.gmvPer100), esc(r.advice)])) + '</div>'
      + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;padding-top:8px;border-top:1px solid #eef1f4">'
      + '<span class="muted">收益换算：1 USD =</span>'
      + '<input id="ads-econ-fx" value="' + esc(String(econ.fx || 7.2)) + '" style="width:64px;padding:4px 6px;border:1px solid #dfe3e8;border-radius:6px">'
      + '<span class="muted">CNY，毛利率</span>'
      + '<input id="ads-econ-margin" value="' + esc(String(Math.round((econ.margin || 0) * 100))) + '" style="width:56px;padding:4px 6px;border:1px solid #dfe3e8;border-radius:6px">'
      + '<span class="muted">%</span>'
      + '<button id="ads-econ-save" class="ghost">保存并重算</button>'
      + '<span class="muted">默认假设，请按实际成本修改</span>'
      + '</div>'
      + '<div class="muted" style="margin-top:8px">口径：点击/商机来自直通车商品或地域报告（近 90 天）；「广告成交」优先按订单「询盘ID」回溯询盘来源，订单没有询盘ID时按统一客户身份/名称估算（严格 ' + vm.adOrdersStrict + ' 单 + 估算 ' + vm.adOrdersEstimated + ' 单 = ' + vm.adOrders + ' 单 / 全部 ' + vm.orders + ' 单；可匹配客户 ' + vm.buyerMatched + ' 单，老客复购 ' + vm.repeatOrders + ' 单）。商品按订单「产品明细」与商品名匹配。'
      + (vm.adOrders < 3 ? '可归因样本不足 3 单，矩阵仅供参考。' : '')
      + (vm.unmatchedGmv ? '另有 $' + Math.round(vm.unmatchedGmv) + ' 广告成交未匹配到投放商品（订单产品明细未命中商品名），商品矩阵仅覆盖可匹配部分。' : '')
      + '与「商品运营工作台」不可直接对比：那边是全渠道、且曝光/访问为近 30 天，TM+询盘/支付为近 90 天，支付买家数也不等于订单数。'
      + '</div>');
  }

  // 收益参数（汇率 / 毛利率）保存后整页重算
  function bindEcon(raw, meta, biz) {
    const btn = document.getElementById('ads-econ-save');
    if (!btn) return;
    btn.onclick = () => {
      const fxEl = document.getElementById('ads-econ-fx');
      const marginEl = document.getElementById('ads-econ-margin');
      const fx = Number(String((fxEl && fxEl.value) || '').replace(/[^\d.]/g, ''));
      const margin = Number(String((marginEl && marginEl.value) || '').replace(/[^\d.]/g, ''));
      if (!(fx > 0)) { toast('请填写有效汇率'); return; }
      if (!(margin >= 0 && margin <= 100)) { toast('毛利率需在 0~100 之间'); return; }
      adsEcon = { fx: fx, margin: margin / 100 };
      chrome.storage.local.set({ aliAdsEconomics: adsEcon }, () => {
        toast('已保存收益参数，正在重算');
        if (rootEl) paint(rootEl, raw, meta, biz);
      });
    };
  }

  function recommendations(ctx) {
    const { total, plans, products, geo, weeks } = ctx;
    const out = [];
    const add = (level, title, detail, action) => out.push({ level, title, detail, action });
    const avgCpl = total.cpl || 0;

    plans.filter((p) => p.spend >= 300).forEach((p) => {
      if (!p.leads) {
        add('P0', '计划「' + p.name + '」0 商机', '花费 ¥' + p.spend.toFixed(0) + '，点击 ' + p.clicks + ' 次，90 天无商机。', '暂停或重做选品');
      } else if (avgCpl && p.cpl > avgCpl * 1.2) {
        add('P1', '计划「' + p.name + '」商机成本偏高', 'CPL ¥' + p.cpl.toFixed(0) + '，高于账户均值 ' + ((p.cpl / avgCpl - 1) * 100).toFixed(0) + '%。', '预算下调 30%~40%');
      } else if (avgCpl && p.cpl < avgCpl * 0.75) {
        add('P1', '计划「' + p.name + '」效率最优', 'CPL ¥' + p.cpl.toFixed(0) + '，仅为账户均值的 ' + ((p.cpl / avgCpl) * 100).toFixed(0) + '%，预算占比 ' + p.share.toFixed(0) + '%。', '加预算 30%~50%');
      }
    });

    // 数量 vs 质量：商机多但 L1+ 占比低 → 只买到低质流量；反之加投
    const avgL1 = total.l1share || 0;
    plans.filter((p) => p.spend >= 300 && p.leads >= 10 && avgL1 > 0).forEach((p) => {
      const q = (p.l1leads / p.leads) * 100;
      if (q < avgL1 * 0.6) {
        add('P1', '计划「' + p.name + '」商机多但质量低', '商机 ' + p.leads + ' 个，L1+ 占比 ' + q.toFixed(0) + '%，低于账户均值 ' + avgL1.toFixed(0) + '%。', '收紧人群、加否词，减少低质流量');
      } else if (q >= avgL1 * 1.3 && avgCpl && p.cpl <= avgCpl * 1.2) {
        add('P1', '计划「' + p.name + '」高质量可加投', 'L1+ 占比 ' + q.toFixed(0) + '%，高于账户均值 ' + avgL1.toFixed(0) + '%，CPL ¥' + p.cpl.toFixed(0) + '。', '预算 +20%~30%，优先扩量');
      }
    });

    const dead = products.filter((p) => p.clicks >= 50 && !p.leads);
    if (dead.length) {
      const spend = dead.reduce((s, p) => s + p.estSpend, 0);
      const clicks = dead.reduce((s, p) => s + p.clicks, 0);
      add('P0', dead.length + ' 个商品 0 商机', '合计 ' + clicks + ' 次点击、估算 ¥' + spend.toFixed(0) + '。', '暂停：' + dead.slice(0, 4).map((p) => p.id || p.name.slice(0, 12)).join('、'));
    }
    const low = products.filter((p) => p.clicks >= 100 && p.leads && p.leadsPer100 < 2);
    if (low.length) {
      add('P1', low.length + ' 个商品点击高但商机低', low.map((p) => (p.id || p.name.slice(0, 10)) + '（' + p.leadsPer100.toFixed(1) + '%）').join('、'), '降权或合并重复链接');
    }
    const high = products.filter((p) => p.clicks >= 50 && p.leadsPer100 >= 6).slice(0, 5);
    if (high.length) {
      add('P1', '高效率商品可加投', high.map((p) => (p.id || p.name.slice(0, 10)) + '（CPL≈¥' + p.estCpl.toFixed(0) + '）').join('、'), '提高出价 / 增加选品');
    }

    const badGeo = geo.filter((g) => g.clicks >= 50 && g.leadsPer100 < 2);
    if (badGeo.length) {
      const clicks = badGeo.reduce((s, g) => s + g.clicks, 0);
      const spend = badGeo.reduce((s, g) => s + g.estSpend, 0);
      add('P0', badGeo.length + ' 个低效国家', '合计 ' + clicks + ' 次点击、估算 ¥' + spend.toFixed(0) + '，商机 ' + badGeo.reduce((s, g) => s + g.leads, 0) + ' 个。', '暂停或降价：' + badGeo.slice(0, 4).map((g) => g.name).join('、'));
    }
    const goodGeo = geo.filter((g) => g.clicks >= 30 && g.leadsPer100 >= 6).slice(0, 5);
    if (goodGeo.length) {
      add('P1', '高效率国家可加投', goodGeo.map((g) => g.name + '（' + g.leadsPer100.toFixed(1) + '%）').join('、'), '单独提价测试');
    }

    if (weeks.length >= 4) {
      const cpls = weeks.filter((w) => w.stats.days >= 5).map((w) => w.stats.cpl).filter((v) => v > 0);
      const max = Math.max(...cpls);
      const min = Math.min(...cpls);
      if (min && max / min >= 2) {
        add('P1', '周商机成本波动过大', '最低 ¥' + min.toFixed(0) + '，最高 ¥' + max.toFixed(0) + '（' + (max / min).toFixed(1) + ' 倍）。', '固定日预算与出价目标，避免脉冲式放量');
      }
    }
    const zeroDays = 0;
    void zeroDays;
    if (total.orders <= 1 && total.leads > 0) {
      add('P2', '广告成交归因缺失', '90 天平台仅回传 ' + total.orders + ' 单，无法计算真实 ROI。', '回填询盘ID→订单，标记成交结果');
    }
    const order = { P0: 0, P1: 1, P2: 2 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
  }

  /* ---------------- 预测 ---------------- */
  function ols(points) {
    const n = points.length;
    if (n < 3) return null;
    let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
    points.forEach(([x, y]) => { sx += x; sy += y; sxx += x * x; sxy += x * y; });
    const den = n * sxx - sx * sx;
    if (!den) return null;
    const b = (n * sxy - sx * sy) / den;
    const a = (sy - b * sx) / n;
    return { a, b };
  }

  function buildForecast(account) {
    const rows = (account || []).filter((r) => r.spend > 0).slice(-30);
    if (!rows.length) return null;
    const cpls = rows.map((r) => (r.leads ? r.spend / r.leads : 0)).filter((v) => v > 0);
    const avgCpl = cpls.length ? cpls.reduce((s, v) => s + v, 0) / cpls.length : 0;
    const trend = ols(cpls.map((v, i) => [i, v]));
    const step = trend ? trend.b : 0;
    const base = trend ? trend.a + trend.b * (cpls.length - 1) : avgCpl;
    const dayCpl = (i) => Math.max(20, base + step * (i + 1));
    const avgSpend = rows.reduce((s, r) => s + r.spend, 0) / rows.length;
    let r2 = 0;
    if (trend) {
      let ssTot = 0; let ssRes = 0;
      cpls.forEach((v, i) => {
        const fit = trend.a + trend.b * i;
        ssTot += (v - avgCpl) * (v - avgCpl);
        ssRes += (v - fit) * (v - fit);
      });
      r2 = ssTot ? Math.max(0, 1 - ssRes / ssTot) : 0;
    }
    return {
      samples: cpls.length,
      avgCpl,
      slope: step,
      r2,
      dailySpend: avgSpend,
      dayCpl,
      confidence: (r2 >= 0.45 && cpls.length >= 14) ? '中高' : (cpls.length >= 10 ? '中' : '低'),
    };
  }

  function scenario(forecast, budget, days) {
    if (!forecast) return null;
    let spend = 0; let leads = 0;
    for (let i = 0; i < days; i += 1) {
      const cpl = forecast.dayCpl(i);
      spend += budget;
      leads += budget / cpl;
    }
    return {
      days,
      budget,
      spend,
      leads,
      cpl: leads ? spend / leads : 0,
      dailyLeads: leads / days,
    };
  }

  /* ---------------- 渲染（仅扩展页） ---------------- */
  let charts = [];
  let rootEl = null;
  let autoDone = false;
  let aiTask = null;            // 进行中的 AI 流式任务，重绘/离开页面时中止
  let aiBusy = false;           // 是否有提问正在等待回答
  let aiStatus = '';            // AI 面板状态文案
  const aiMessages = [];        // 多轮对话历史（user / assistant）
  let adsEcon = { fx: 7.2, margin: 0 };   // 投流收益换算：美元→人民币汇率、毛利率（毛利率未填时不输出 ROI）

  function money(v, digits) { return '¥' + Number(v || 0).toFixed(digits === undefined ? 0 : digits); }
  function pct(v, digits) { return Number(v || 0).toFixed(digits === undefined ? 1 : digits) + '%'; }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function card(k, v, h) { return '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="h">' + (h || '') + '</div></div>'; }
  function panel(title, body) { return '<div class="panel"><h3 style="margin-top:0">' + title + '</h3>' + body + '</div>'; }
  function table(headers, rows) {
    if (!rows || !rows.length) return '<div class="muted">暂无数据</div>';
    return '<div class="scroll"><table><thead><tr>' + headers.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>'
      + rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  }
  function mkChart(id, option) {
    const dom = document.getElementById(id);
    if (!dom) return null;
    const c = echarts.init(dom);
    c.setOption(Object.assign({ animation: false }, option));
    charts.push(c);
    return c;
  }

  async function render(el, guard) {
    rootEl = el;
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get([KEY], (o) => resolve(o && o[KEY] ? o[KEY] : null));
    });
    if (typeof guard === 'function' && !guard()) return;
    const econ = await new Promise((resolve) => {
      chrome.storage.local.get(['aliAdsEconomics'], (o) => resolve(o && o.aliAdsEconomics ? o.aliAdsEconomics : null));
    });
    if (econ && Number(econ.fx) > 0 && Number(econ.margin) >= 0 && Number(econ.margin) <= 1) {
      adsEcon = { fx: Number(econ.fx), margin: Number(econ.margin) };
    }
    const raw = stored && stored.raw ? stored.raw : null;
    const a = raw && raw.account && raw.account.length ? analyze(raw) : null;
    const biz = a ? await loadBusiness(a) : null;
    paint(el, raw, stored && stored.meta ? stored.meta : {}, biz);

    // 自动同步：每日任务（adsAuto=1）或数据超过 20 小时未更新
    const auto = new URLSearchParams(location.search).get('adsAuto') === '1';
    const stale = !!stored && (!stored.meta || (Date.now() - Number(stored.meta.updatedAt || 0) > 20 * 3600 * 1000));
    if (!autoDone && (auto || stale)) {
      autoDone = true;
      if (!auto) toast('数据超过 20 小时未更新，正在自动同步…');
      let ok = false;
      try { ok = await collect(el, stored && stored.raw ? stored.raw : null); } catch (e) { ok = false; }
      if (auto && ok) {
        try { chrome.tabs.getCurrent((t) => { if (t && t.id != null) chrome.tabs.remove(t.id); }); } catch (e) { /* ignore */ }
      }
    }
  }

  function toolbarHtml(updatedAt) {
    return '<div class="bar" style="justify-content:space-between">'
      + '  <div><b style="font-size:16px">投流诊断</b> <span class="muted">' + (updatedAt ? '数据更新：' + new Date(updatedAt).toLocaleString('zh-CN') : '尚未导入数据') + '</span></div>'
      + '  <div>'
      + '    <input id="ads-file" type="file" accept=".xlsx,.xls" multiple style="display:none">'
      + '    <button id="ads-sync">一键同步数据</button> '
      + '    <button id="ads-ai" class="ghost">AI 深度诊断</button> '
      + '    <button id="ads-open" class="ghost">打开直通车报告</button> '
      + '    <button id="ads-import" class="ghost">导入报表</button> '
      + '    <button id="ads-csv" class="ghost">导出诊断 CSV</button> '
      + '    <button id="ads-clear" class="ghost">清空</button>'
      + '  </div>'
      + '</div>'
      + '<div id="ads-sync-status" class="muted" style="margin:-6px 0 10px"></div>';
  }

  function bindToolbar(el, raw) {
    const file = document.getElementById('ads-file');
    const sync = document.getElementById('ads-sync');
    if (sync) sync.onclick = () => collect(el, raw);
    const ai = document.getElementById('ads-ai');
    if (ai) ai.onclick = () => aiDiagnose(raw);
    const open = document.getElementById('ads-open');
    if (open) {
      open.onclick = () => {
        if (typeof chrome !== 'undefined' && chrome.tabs) chrome.tabs.create({ url: REPORT_URL });
      };
    }
    document.getElementById('ads-import').onclick = () => file.click();
    file.onchange = async () => {
      const files = Array.from(file.files || []);
      if (!files.length) return;
      try {
        const merged = await importFiles(files, raw);
        await save(merged);
        toast('已导入 ' + files.length + ' 个文件，正在重算');
        const a2 = analyze(merged);
        const biz2 = await loadBusiness(a2);
        paint(el, merged, { updatedAt: Date.now() }, biz2);
      } catch (e) {
        toast('导入失败：' + (e && e.message || e));
      }
      file.value = '';
    };
    const csv = document.getElementById('ads-csv');
    if (csv) csv.onclick = () => { if (raw && raw.account && raw.account.length) exportCsv(analyze(raw)); else toast('请先导入数据'); };
    const clear = document.getElementById('ads-clear');
    if (clear) clear.onclick = async () => {
      await new Promise((r) => chrome.storage.local.remove([KEY], r));
      paint(el, null, {});
    };
  }

  const GUIDE = '<div class="panel"><h3 style="margin-top:0">使用步骤</h3>'
    + '<ol style="margin:0 0 0 18px;padding:0;line-height:2">'
    + '<li>点右上角<b>「一键同步数据」</b>：首次自动拉取 <b>180 天</b>日数据建立基线，之后每次按 <b>90 天</b>更新；同时采集计划、商品、地域和搜索词（搜索词平台固定 7 天）。</li>'
    + '<li>同步完成后自动生成诊断、优先级建议和未来 14 天预测；点「AI 深度诊断」可用本机配置的模型给出更细的优化方案。</li>'
    + '<li>首次使用后，每天 08:30 会自动检查并同步（数据超过 20 小时才触发），也可随时手动点。</li>'
    + '</ol>'
    + '<div class="muted" style="margin-top:8px">若同步失败，可用「导入报表」手动导入平台导出的 Excel。</div></div>';

  function businessRecs(a, biz) {
    const out = [];
    if (!biz) return out;
    if (biz.adInquiries > 0) {
      if (biz.replyRate < 80) out.push({ level: 'P0', title: '广告询盘回复率仅 ' + pct(biz.replyRate, 0), detail: '近 90 天营销来源询盘 ' + biz.adInquiries + ' 个，已回复 ' + pct(biz.replyRate, 0) + '；回复慢会直接拉低成交。', action: '24 小时内首回，安排值守' });
      if (biz.addedRate < 50 && biz.adInquiries >= 5) out.push({ level: 'P1', title: '广告商机加客户率偏低', detail: '营销来源询盘 ' + biz.adInquiries + ' 个，已加为客户 ' + pct(biz.addedRate, 0) + '。', action: '询盘 2 小时内加客户并跟进' });
      if (biz.hotShare < 30 && biz.adInquiries >= 10) out.push({ level: 'P1', title: '广告高价值询盘占比仅 ' + pct(biz.hotShare, 0), detail: '营销来源询盘 ' + biz.adInquiries + ' 个，A/B 或 L3+ 买家仅 ' + pct(biz.hotShare, 0) + '；投放人群与关键词需要收窄。', action: '加否词、收紧人群，优先高等级买家词' });
    }
    if (biz.adOrders > 0 && a.total.spend) {
      out.push({ level: 'P2', title: '广告关联成交 ' + biz.adOrders + ' 单', detail: '成交额约 $' + Math.round(biz.adGmv) + '，按花费折算单均获客成本 ¥' + Math.round(a.total.spend / biz.adOrders) + '（严格 ' + (biz.adOrdersStrict || 0) + ' 单 + 估算 ' + (biz.adOrdersEstimated || 0) + ' 单）。', action: '核对客单价与复购，评估放量空间' });
    }
    if (biz.adOrdersEstimated) {
      out.push({ level: 'P1', title: '订单缺询盘ID，广告成交为估算', detail: '可匹配客户 ' + (biz.buyerMatched || 0) + '/' + biz.orders + ' 单；严格归因 ' + (biz.adOrdersStrict || 0) + ' 单，按客户身份/名称估算 ' + biz.adOrdersEstimated + ' 单' + (biz.repeatOrders ? '，另有 ' + biz.repeatOrders + ' 单为老客复购' : '') + '。', action: '订单导出补全询盘ID后重新同步，复核成交额与 ROI' });
    }
    if (biz.adInquiries >= 20 && (biz.gradeCoverage || 0) < 50) {
      out.push({ level: 'P1', title: '买家等级缺失 ' + Math.round(100 - (biz.gradeCoverage || 0)) + '%', detail: '广告询盘 ' + biz.adInquiries + ' 个，高价值占比仅 ' + pct(biz.hotShare, 0) + '，主要因等级字段为空，容易低估商机质量。', action: '补全买家等级/客户库关联后再评估质量' });
    }
    const adCountry = biz.adByCountry || biz.byCountry || {};
    const keep = a.geo.filter((g) => g.clicks >= 50 && g.leadsPer100 < 2 && adCountry[g.name] && adCountry[g.name].orders > 0);
    if (keep.length) {
      out.push({ level: 'P1', title: '有成交但广告效率低的国家', detail: keep.map((g) => g.name + '（成交 ' + adCountry[g.name].orders + ' 单）').join('、') + '。', action: '先保留观察，不要直接暂停' });
    }
    const adProduct = biz.adByProduct || biz.byProduct || {};
    const lowClicks = Object.keys(adProduct).filter((k) => k !== '其他' && k !== '未知')
      .map((id) => a.products.find((p) => p.id === id))
      .filter((p) => p && p.clicks < 100);
    if (lowClicks.length) {
      out.push({ level: 'P1', title: '有成交但广告曝光不足的商品', detail: lowClicks.map((p) => (p.id || p.name.slice(0, 10)) + '（成交 ' + (adProduct[p.id] || {}).orders + ' 单）').join('、') + '。', action: '提高出价 / 增加选品曝光' });
    }
    // 首回 SLA：超时名单是可直接执行的转化动作
    if (biz.sla && biz.sla.overdue.length) {
      const noReply = biz.sla.overdue.filter((x) => x.hours === null).length;
      out.unshift({ level: 'P0', title: '首回超时 ' + biz.sla.overdue.length + ' 个广告询盘' + (noReply ? '（含 ' + noReply + ' 个未回复）' : ''), detail: '目标：高价值 30 分钟内、普通 2 小时内；名单见「成交推进」面板。', action: '今天逐条补首回，高价值优先' });
    }
    // 阶段漏斗：报价推进不足 / 流失偏高
    if (biz.funnel) {
      if (biz.adInquiries >= 10 && biz.funnel.quoteRate < 20) {
        out.push({ level: 'P1', title: '广告询盘报价推进不足', detail: '仅 ' + pct(biz.funnel.quoteRate, 0) + ' 推进到报价/样品/成交（阶段匹配 ' + biz.funnel.matched + ' 条）。', action: '24 小时内给可执行报价或替代方案' });
      }
      if (biz.funnel.lostRate >= 30) {
        out.push({ level: 'P1', title: '广告询盘流失率 ' + pct(biz.funnel.lostRate, 0), detail: '阶段标记为已流失占比偏高。', action: '回访流失原因：价格 / 交期 / 认证 / 起订量' });
      }
    }
    // 买家资料缺口：连客户名称都没有，后续等级评估、聊天匹配与成交归因都无从谈起
    const sf = biz.stageFunnel;
    if (sf && sf.total >= 20 && sf.profiled / sf.total < 0.5) {
      const miss = sf.total - sf.profiled;
      out.push({ level: 'P0', title: '广告商机买家资料缺口 ' + pct((miss / sf.total) * 100, 0), detail: '近 90 天 ' + sf.total + ' 条广告商机中 ' + miss + ' 条没有客户名称/公司（TM 商机未补全客户信息），无法补买家等级、无法匹配聊天与成交。', action: '对询盘执行一次完整补全同步后再评估质量与首单转化' });
    }
    return out;
  }

  function bizHtml(biz, a) {
    if (!biz) return panel('业务联动（本机资料库）', '<div class="muted">未读取到本机询盘/订单数据。可先在「资料库」导入或同步询盘、订单后重试。</div>');
    const costPer = biz.adOrders ? Math.round(a.total.spend / biz.adOrders) : 0;
    const countryRows = Object.keys(biz.byCountry).sort((x, y) => biz.byCountry[y].orders - biz.byCountry[x].orders)
      .slice(0, 8).map((c) => [esc(c), biz.byCountry[c].orders, '$' + Math.round(biz.byCountry[c].gmv)]);
    const productRows = Object.keys(biz.byProduct).sort((x, y) => biz.byProduct[y].orders - biz.byProduct[x].orders)
      .slice(0, 8).map((id) => {
        const p = a.products.find((x) => x.id === id);
        return [esc(p ? (p.id + ' · ' + p.name.slice(0, 20)) : id), biz.byProduct[id].orders, '$' + Math.round(biz.byProduct[id].gmv)];
      });
    return panel('业务联动（本机资料库 · 近 90 天）',
      '<div class="cards">'
      + card('广告来源询盘', biz.adInquiries, '全部询盘 ' + biz.totalInquiries)
      + card('高价值询盘占比', pct(biz.hotShare, 0), 'A/B 或 L3+ 买家')
      + card('加客户率', pct(biz.addedRate, 0), '营销来源')
      + card('回复率', pct(biz.replyRate, 0), (biz.firstReplySource === 'chat' || biz.firstReplyHours) ? (biz.firstReplySource === 'chat' ? '聊天真实首回 ' : '首回估算 ') + biz.firstReplyHours.toFixed(1) + ' 小时' : '首回时长待补')
      + card('成交订单', biz.orders, '广告估算 ' + biz.adOrders + ' · 可匹配客户 ' + (biz.buyerMatched || 0))
      + card('成交额', '$' + Math.round(biz.gmv), costPer ? '广告单均花费 ¥' + costPer : '待归因')
      + '</div>'
      + '<div style="margin-top:8px"><h3>新客 / 老客复购（近 90 天成交）</h3>'
      + table(['客户类型', '订单', '成交额', '广告归因', '广告成交额'], [
        ['新客', biz.split.new.orders, '$' + Math.round(biz.split.new.gmv), biz.split.new.adOrders, '$' + Math.round(biz.split.new.adGmv)],
        ['老客复购', biz.split.repeat.orders, '$' + Math.round(biz.split.repeat.gmv), biz.split.repeat.adOrders, '$' + Math.round(biz.split.repeat.adGmv)],
        ['未匹配客户', biz.split.unmatched.orders, '$' + Math.round(biz.split.unmatched.gmv), biz.split.unmatched.adOrders, '$' + Math.round(biz.split.unmatched.adGmv)],
      ])
      + '</div>'
      + (biz.stageFunnel && biz.stageFunnel.total ? (() => {
        const sf = biz.stageFunnel;
        const p = (n) => pct((n / sf.total) * 100, 0);
        return '<div style="margin-top:8px"><h3>广告商机推进（各环节覆盖）</h3>'
          + table(['环节', '数量', '占商机', '口径'], [
            ['广告商机', sf.total, '100%', '近 90 天营销来源询盘 / TM 商机'],
            ['平台已回复', sf.replied, p(sf.replied), '平台「回复状态 = 已回复」'],
            ['可识别客户', sf.profiled, p(sf.profiled), '有客户名称，可补等级与归因'],
            ['已加为客户', sf.added, p(sf.added), '平台「是否已加为客户 = 是」'],
            ['广告成交', sf.won, p(sf.won), '严格 + 客户身份归因成交单'],
          ])
          + '<div class="muted" style="margin-top:6px">平台没有「报价 / 样品」阶段字段：聊天样本中 ' + sf.chatSessions
          + ' 个广告客户会话，业务员提到报价 ' + sf.chatQuote + ' 个、样品/规格 ' + sf.chatSample + ' 个（样本小，仅作参考）。'
          + '「可识别客户」是后续首回、加客与归因的前提。'
          + (sf.profiled < sf.total * 0.5 ? '当前 ' + Math.round(100 - (sf.profiled / sf.total) * 100) + '% 的广告商机没有买家资料，优先补全。' : '')
          + '</div></div>';
      })() : '')
      + '<div class="grid2">'
      + '<div><h3>成交国家（全部）</h3>' + table(['国家', '订单', '金额'], countryRows) + '</div>'
      + '<div><h3>成交商品（全部）</h3>' + table(['商品', '订单', '金额'], productRows) + '</div>'
      + '</div>'
      + (biz.gaps.length ? '<div class="muted" style="margin-top:8px">数据缺口：' + biz.gaps.map(esc).join('；') + '</div>' : ''));
  }

  // 未归因订单：给业务员核对客户来源，支持导出 CSV
  function unattrHtml(biz) {
    if (!biz) return '';
    if (!biz.unattributedCount) return panel('未归因订单（近 90 天）', '<div class="muted">当前没有未归因订单。</div>');
    const list = biz.unattributed || [];
    const rows = list.slice(0, 20).map((x) => [
      esc(String(x.id || '').slice(-8)), esc(x.name || '—'), esc(x.company || '—'), esc(x.country || '—'),
      '$' + Math.round(x.amount || 0), esc(String(x.at || '').slice(0, 10)),
      x.matched ? '已匹配' : '未匹配', esc(x.reason || ''),
    ]);
    return panel('未归因订单（近 90 天 · ' + biz.unattributedCount + ' 单 / $' + Math.round(biz.unattributedGmv) + '）',
      '<div class="muted" style="margin-bottom:8px">这些成交没有回溯到广告来源：先看客户档案是否有营销询盘；列表展示前 20 条，可导出 CSV 交给业务员核对'
      + (list.length < biz.unattributedCount ? '（单次最多记录 200 条）' : '') + '。</div>'
      + table(['订单号后8位', '客户', '公司', '国家', '成交额', '下单时间', '客户档案', '原因'], rows)
      + '<div style="margin-top:8px"><button id="ads-unattr-csv" class="ghost">导出未归因订单 CSV</button></div>');
  }

  function exportUnattrCsv(biz) {
    if (!biz || !biz.unattributedCount) { toast('没有未归因订单'); return; }
    const lines = ['订单ID,客户名称,公司名称,国家,成交金额,下单时间,客户档案,原因'];
    (biz.unattributed || []).forEach((x) => {
      lines.push([x.id, x.name, x.company, x.country, x.amount, x.at, x.matched ? '已匹配' : '未匹配', x.reason]
        .map((v) => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"').join(','));
    });
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '未归因订单_' + new Date().toISOString().slice(0, 10) + '.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function bindUnattr(biz) {
    const btn = document.getElementById('ads-unattr-csv');
    if (btn) btn.onclick = () => exportUnattrCsv(biz);
  }

  // 成交推进：阶段漏斗 + 真实首回 SLA + 超时名单
  function slaHtml(biz) {
    const sla = biz && biz.sla;
    const funnel = biz && biz.funnel;
    const sf = biz && biz.stageFunnel;
    const hasSla = !!(sla && sla.samples);
    const hasStage = !!(sf && sf.total);
    if (!hasSla && !funnel && !hasStage) {
      return panel('成交推进（阶段漏斗 + 首回 SLA）', '<div class="muted">暂无聊天与阶段数据：先在「资料库」同步聊天记录，并在客户档案里维护询盘阶段后自动补算。</div>');
    }
    const cards = [];
    if (hasSla) {
      cards.push(card('聊天首回均值', sla.avgHours ? sla.avgHours.toFixed(1) + ' 小时' : (sla.noReply ? '有未回复' : '—'), '会话 ' + sla.samples + ' 个，中位 ' + sla.p50Hours.toFixed(1) + ' 小时'));
      cards.push(card('30 分钟内首回', pct(sla.within30, 0), '2 小时内 ' + pct(sla.within120, 0)));
      cards.push(card('未回复会话', sla.noReply, '仅有客户消息、无业务员回复'));
    }
    if (funnel) {
      cards.push(card('询盘→报价率', pct(funnel.quoteRate, 0), '已报价/样品/成交 合计'));
      cards.push(card('询盘→样品率', pct(funnel.sampleRate, 0), '样品/规格确认 + 成交'));
      cards.push(card('询盘→成交率', pct(funnel.wonRate, 0), '阶段标记为已成交'));
    } else if (hasStage) {
      cards.push(card('可识别客户', pct((sf.profiled / sf.total) * 100, 0), '有客户名称 ' + sf.profiled + '/' + sf.total));
      cards.push(card('询盘→成交率', pct((sf.won / sf.total) * 100, 0), '广告归因成交 ' + sf.won + ' 单'));
    }
    const stageRows = funnel
      ? Object.keys(funnel.counts).sort((x, y) => funnel.counts[y] - funnel.counts[x])
        .map((k) => [esc(k), funnel.counts[k], pct(funnel.counts[k] / (funnel.total || 1) * 100, 0)])
      : [];
    const overdueRows = sla && sla.overdue.length
      ? sla.overdue.map((o) => [esc(o.name), esc(o.level), o.hours === null ? '<b>未回复</b>' : o.hours.toFixed(1) + ' 小时', o.target + ' 小时'])
      : [];
    return panel('成交推进（阶段漏斗 + 首回 SLA）',
      (cards.length ? '<div class="cards">' + cards.join('') + '</div>' : '')
      + (stageRows.length ? '<div style="margin-top:8px"><h3>当前阶段分布（广告询盘' + (funnel ? ' · 已匹配 ' + funnel.matched + '/' + funnel.total : '') + '）</h3>' + table(['阶段', '询盘数', '占比'], stageRows) + '</div>' : '')
      + (!funnel && hasStage ? '<div style="margin-top:8px"><h3>行为漏斗（平台字段口径）</h3>'
        + table(['环节', '数量', '占商机', '口径'], [
          ['广告商机', sf.total, '100%', '近 90 天营销来源'],
          ['平台已回复', sf.replied, pct((sf.replied / sf.total) * 100, 0), '回复状态 = 已回复'],
          ['可识别客户', sf.profiled, pct((sf.profiled / sf.total) * 100, 0), '有客户名称'],
          ['已加为客户', sf.added, pct((sf.added / sf.total) * 100, 0), '是否已加为客户 = 是'],
          ['广告成交', sf.won, pct((sf.won / sf.total) * 100, 0), '严格 + 客户身份归因'],
        ]) + '</div>' : '')
      + (overdueRows.length
        ? '<div style="margin-top:8px"><h3>首回超时名单（高价值 30 分钟 / 普通 2 小时）</h3>' + table(['客户', '等级', '实际首回', '目标'], overdueRows) + '</div>'
        : (hasSla ? '<div class="muted" style="margin-top:8px">当前没有超时的广告询盘。</div>' : ''))
      + '<div class="muted" style="margin-top:8px">首回按聊天表「客户首条消息 → 业务员第一条回复」计算；未匹配到聊天会话的询盘不列入名单，避免误报。'
      + (funnel ? '阶段来自客户档案的当前阶段，匹配不到阶段的询盘不计入占比。' : '平台没有「报价 / 样品」阶段字段：行为漏斗用回复状态、客户名称、是否加客与成交归因拼出，报价/样品只能从聊天样本侧观察，不能当作全量口径。')
      + '</div>');
  }

  function paint(el, raw, meta, biz) {
    destroyCharts();
    if (aiTask) aiTask.stop();
    const hasData = !!(raw && raw.account && raw.account.length);
    if (!hasData) {
      el.innerHTML = toolbarHtml(meta && meta.updatedAt) + GUIDE;
      bindToolbar(el, raw);
      return;
    }
    const a = analyze(raw);
    const vm = valueModel(a, biz, adsEcon);
    if (biz) a.recs = valueRecs(a, vm).concat(businessRecs(a, biz)).concat(a.recs);
    const recOrder = { P0: 0, P1: 1, P2: 2 };
    a.recs.sort((x, y) => (recOrder[x.level] === undefined ? 9 : recOrder[x.level]) - (recOrder[y.level] === undefined ? 9 : recOrder[y.level]));
    const t = a.total;
    const updated = meta && meta.updatedAt ? new Date(meta.updatedAt).toLocaleString('zh-CN') : '—';
    const types = (raw.meta && raw.meta.types) || [];
    const missing = ['account', 'plan', 'product', 'geo'].filter((k) => types.indexOf(k) < 0);

    el.innerHTML = toolbarHtml(meta && meta.updatedAt)
      + (missing.length ? '<div class="muted" style="margin:-6px 0 10px">尚未导入：' + missing.map((k) => ({ account: '账户概览', plan: '计划', product: '商品', geo: '账户分地域' }[k])).join('、') + '，相关模块将不展示。</div>' : '')
      + '<div id="ads-ai-panel"></div>'
      + '<div id="ads-value"></div>'
      + '<div class="cards">'
      + card('近 90 天花费', money(t.spend), '日数据保留 180 天 / 有效天 ' + t.days)
      + card('商机量', t.leads, '日均 ' + (t.days ? (t.leads / t.days).toFixed(1) : 0))
      + card('商机成本', money(t.cpl), 'CPC ' + money(t.cpc, 2))
      + card('点击成本', money(t.cpc, 2), '点击 ' + t.clicks)
      + card('点击率', pct(t.ctr, 2), '曝光 ' + t.imps)
      + card('L1+ 商机占比', pct(t.l1share), '归因订单 ' + t.orders)
      + '</div>'
      + '<div id="ads-conclusions"></div>'
      + '<div class="grid2">'
      + panel('月度：花费与商机成本', '<div id="ads-month" class="chart"></div>')
      + panel('周度：投放节奏', '<div id="ads-week" class="chart"></div>')
      + '</div>'
      + panel('计划效率', '<div id="ads-plan" class="chart" style="height:320px"></div><div id="ads-plan-tbl" style="margin-top:10px"></div>')
      + '<div class="grid2">'
      + panel('商品效率', '<div id="ads-prod" class="chart" style="height:340px"></div>')
      + panel('国家效率', '<div id="ads-geo" class="chart" style="height:340px"></div>')
      + '</div>'
      + panel('商品明细（按点击排序）', '<div id="ads-prod-tbl"></div>')
      + panel('国家明细（按点击排序）', '<div id="ads-geo-tbl"></div>')
      + panel('搜索词结构（7 天样本）', '<div id="ads-term" class="chart" style="height:300px"></div>'
        + '<div class="muted">平台搜索词报告最长 7 天，仅用于判断词结构；点击环形图分类可在下方查看该词类的全部搜索词。</div>'
        + '<div id="ads-term-list" style="margin-top:10px"></div>')
      + '<div id="ads-biz"></div>'
      + '<div id="ads-unattr"></div>'
      + '<div id="ads-sla"></div>'
      + '<div id="ads-forecast"></div>'
      + '<div id="ads-actions"></div>';

    const bizBox = document.getElementById('ads-biz');
    if (bizBox) bizBox.innerHTML = bizHtml(biz, a);

    const unattrBox = document.getElementById('ads-unattr');
    if (unattrBox) {
      unattrBox.innerHTML = unattrHtml(biz);
      bindUnattr(biz);
    }

    const valueBox = document.getElementById('ads-value');
    if (valueBox) {
      valueBox.innerHTML = valueHtml(vm);
      bindEcon(raw, meta, biz);
    }

    const slaBox = document.getElementById('ads-sla');
    if (slaBox) slaBox.innerHTML = slaHtml(biz);

    const aiBox = document.getElementById('ads-ai-panel');
    if (aiBox) {
      aiBox.innerHTML = aiPanelHtml();
      renderAiLog();
      bindAiPanel(raw);
    }

    // 结论
    const months = a.months;
    const first = months[0]; const last = months[months.length - 1];
    const concls = [];
    if (first && last && months.length > 1) {
      concls.push('商机成本从 ' + first.month + ' 的 <b>' + money(first.stats.cpl) + '</b> 变为 ' + last.month + ' 的 <b>' + money(last.stats.cpl) + '</b>，花费 ' + money(first.stats.spend) + ' → ' + money(last.stats.spend) + '。');
    }
    const bestPlan = a.plans.filter((p) => p.leads).sort((x, y) => x.cpl - y.cpl)[0];
    const worstBig = a.plans.filter((p) => p.leads).sort((x, y) => y.share - x.share)[0];
    if (bestPlan && worstBig && bestPlan !== worstBig) {
      concls.push('效率最好的计划「' + bestPlan.name + '」CPL ' + money(bestPlan.cpl) + '，预算占比 ' + pct(bestPlan.share, 0) + '；花费最大的计划「' + worstBig.name + '」CPL ' + money(worstBig.cpl) + '。');
    }
    if (t.orders <= 1) concls.push('广告归因订单仅 ' + t.orders + ' 单，成交 ROI 暂不可计算，建议先回填订单归因。');
    document.getElementById('ads-conclusions').innerHTML = concls.length
      ? '<div class="concl">' + concls[0] + '<small>' + (concls[1] || '') + '</small></div>' : '';

    // 月度图
    if (months.length) {
      mkChart('ads-month', {
        tooltip: { trigger: 'axis' },
        legend: { data: ['花费', '商机成本'], top: 0, textStyle: { fontSize: 11 } },
        grid: { left: 56, right: 56, top: 36, bottom: 28 },
        xAxis: { type: 'category', data: months.map((m) => m.month), axisLabel: { fontSize: 11 } },
        yAxis: [{ type: 'value', name: '花费', axisLabel: { fontSize: 11 } }, { type: 'value', name: 'CPL', axisLabel: { fontSize: 11 } }],
        series: [
          { name: '花费', type: 'bar', data: months.map((m) => Math.round(m.stats.spend)), itemStyle: { color: '#d9d9d6' } },
          { name: '商机成本', type: 'line', yAxisIndex: 1, data: months.map((m) => Number(m.stats.cpl.toFixed(2))), itemStyle: { color: '#b42318' }, lineStyle: { color: '#b42318', width: 2 } },
        ],
      });
    }
    if (a.weeks.length) {
      mkChart('ads-week', {
        tooltip: { trigger: 'axis' },
        legend: { data: ['周花费', '周 CPL'], top: 0, textStyle: { fontSize: 11 } },
        grid: { left: 56, right: 56, top: 36, bottom: 28 },
        xAxis: { type: 'category', data: a.weeks.map((w) => w.week.slice(5)), axisLabel: { fontSize: 11 } },
        yAxis: [{ type: 'value', name: '花费' }, { type: 'value', name: 'CPL' }],
        series: [
          { name: '周花费', type: 'bar', data: a.weeks.map((w) => Math.round(w.stats.spend)), itemStyle: { color: '#d9d9d6' } },
          { name: '周 CPL', type: 'line', yAxisIndex: 1, data: a.weeks.map((w) => Number(w.stats.cpl.toFixed(2))), itemStyle: { color: '#b42318' }, lineStyle: { color: '#b42318', width: 2 } },
        ],
      });
    }

    // 计划
    if (a.plans.length) {
      const avg = t.cpl;
      mkChart('ads-plan', {
        tooltip: { trigger: 'item', formatter: (p) => p.data.name + '<br/>花费：' + money(p.value[0]) + '<br/>CPL：' + money(p.value[1]) + '<br/>商机：' + p.value[2] },
        grid: { left: 60, right: 110, top: 20, bottom: 40 },
        xAxis: { type: 'value', name: '花费', axisLabel: { fontSize: 11 } },
        yAxis: { type: 'value', name: '商机成本', axisLabel: { fontSize: 11 } },
        series: [{
          type: 'scatter',
          data: a.plans.filter((p) => p.spend > 0).map((p) => ({
            name: p.name, value: [Math.round(p.spend), Number(p.cpl.toFixed(2)), p.leads],
            symbolSize: 12 + p.leads * 0.5,
            itemStyle: { color: p.cpl < avg ? '#067647' : '#b42318', opacity: 0.8 },
            label: { show: true, position: 'right', formatter: p.name.slice(0, 10), fontSize: 10 },
          })),
        }],
      });
      document.getElementById('ads-plan-tbl').innerHTML = table(
        ['计划', '花费', '占比', '商机', 'CPL', 'CPC', 'CTR', '建议'],
        a.plans.map((p) => [
          esc(p.name.slice(0, 22)), money(p.spend), pct(p.share, 0), p.leads,
          p.leads ? money(p.cpl) : '—', money(p.cpc, 2), pct(p.ctr, 2),
          p.cpl && p.cpl < avg * 0.75 ? '<span class="tag">加预算</span>' : (p.cpl > avg * 1.2 ? '<span class="tag" style="background:#fee2e2;color:#b91c1c">降预算</span>' : '—'),
        ]),
      );
    }

    // 商品 / 国家
    if (a.products.length) {
      const top = a.products.filter((p) => p.clicks >= 20).slice(0, 24);
      mkChart('ads-prod', {
        tooltip: { trigger: 'item', formatter: (p) => p.data.name + '<br/>点击：' + p.value[0] + '<br/>商机：' + p.value[1] },
        grid: { left: 46, right: 20, top: 16, bottom: 34 },
        xAxis: { type: 'value', name: '点击', axisLabel: { fontSize: 11 } },
        yAxis: { type: 'value', name: '商机', axisLabel: { fontSize: 11 }, minInterval: 1 },
        series: [{
          type: 'scatter',
          data: top.map((p) => ({
            name: (p.id || '') + ' ' + p.name.slice(0, 20),
            value: [p.clicks, p.leads],
            symbolSize: 8 + p.leads * 1.4,
            itemStyle: { color: p.leadsPer100 >= 6 ? '#067647' : (p.leadsPer100 < 2 ? '#b42318' : '#6b7280'), opacity: 0.75 },
          })),
        }],
      });
      document.getElementById('ads-prod-tbl').innerHTML = table(
        ['商品', '点击', '商机', '每百点击商机', '估算花费', '估算 CPL'],
        a.products.slice(0, 15).map((p) => [
          esc((p.id ? p.id + ' · ' : '') + p.name.slice(0, 26)), p.clicks, p.leads,
          pct(p.leadsPer100, 1), money(p.estSpend), p.leads ? money(p.estCpl) : '—',
        ]),
      );
    }
    if (a.geo.length) {
      const top = a.geo.slice(0, 14);
      mkChart('ads-geo', {
        tooltip: { trigger: 'axis', formatter: (ps) => { const g = top[ps[0].dataIndex]; return g.name + '<br/>点击：' + g.clicks + '<br/>商机：' + g.leads + '<br/>每百点击：' + g.leadsPer100.toFixed(1); } },
        grid: { left: 74, right: 56, top: 16, bottom: 30 },
        xAxis: { type: 'value', name: '点击' },
        yAxis: { type: 'category', inverse: true, data: top.map((g) => g.name), axisLabel: { fontSize: 11 } },
        series: [{
          type: 'bar', barWidth: 14,
          data: top.map((g) => ({ value: g.clicks, itemStyle: { color: g.leadsPer100 < 2 ? '#b42318' : '#111827', opacity: 0.85 } })),
          label: { show: true, position: 'right', fontSize: 10, formatter: (p) => '商机 ' + top[p.dataIndex].leads },
        }],
      });
      document.getElementById('ads-geo-tbl').innerHTML = table(
        ['国家/地域', '点击', '商机', '每百点击商机', 'CPL'],
        a.geo.slice(0, 12).map((g) => [esc(g.name), g.clicks, g.leads, pct(g.leadsPer100, 1), g.leads ? money(g.estCpl) : '—']),
      );
    }
    if (a.terms.length) {
      const sumShare = a.terms.reduce((s, x) => s + x.clickshare, 0) || 1;
      const groups = [
        { name: '过泛词', test: /^(polymer|liquid polymer|resin|plastic resin|3d resin|uv resin|3d printing resin|3d printer resin|micro-resin|resin printing clear)$/i, color: '#111827' },
        { name: '核心品类词', test: /product|material|equipment/i, color: '#8c8c87' },
        { name: '无关词', test: /whitening|porcelain|epoxy|filament|3d printers|fabrication|after-sales|resin art/i, color: '#b42318' },
      ];
      const agg = {};
      a.terms.forEach((x) => {
        const hit = groups.find((g) => g.test.test(x.name));
        const key = hit ? hit.name : '其他';
        agg[key] = agg[key] || { name: key, share: 0, terms: [] };
        agg[key].share += x.clickshare;
        agg[key].terms.push(x);
      });
      const cats = Object.keys(agg).map((k) => agg[k]).sort((x, y) => y.share - x.share);
      cats.forEach((c) => c.terms.sort((x, y) => y.clickshare - x.clickshare));
      const data = cats.map((c) => ({
        name: c.name, value: Number(((c.share / sumShare) * 100).toFixed(1)),
        itemStyle: { color: (groups.find((g) => g.name === c.name) || { color: '#d9d9d6' }).color },
      }));
      // 点击分类 → 在该图下方列出词类明细
      const termChart = mkChart('ads-term', {
        tooltip: { trigger: 'item', formatter: '{b}<br/>点击占比：{c}%' },
        legend: { bottom: 0, textStyle: { fontSize: 11 } },
        series: [{
          type: 'pie', radius: ['40%', '64%'], center: ['50%', '44%'], data,
          label: { formatter: '{b}\n{d}%', fontSize: 11 },
          selectedMode: 'single',
          select: { itemStyle: { borderColor: '#1858c9', borderWidth: 2 } },
        }],
      });
      const box = document.getElementById('ads-term-list');
      const showCat = (name) => {
        if (!box) return;
        const c = cats.find((x) => x.name === name) || cats[0];
        if (!c) { box.innerHTML = ''; return; }
        box.innerHTML = '<div class="muted" style="margin-bottom:6px">「' + esc(c.name) + '」共 ' + c.terms.length
          + ' 个搜索词，点击占比合计 ' + pct((c.share / sumShare) * 100, 1) + '（点击分类可切换）</div>'
          + table(['搜索词', '点击占比', '曝光占比'],
            c.terms.map((t) => [esc(t.name), pct(t.clickshare, 1), pct(t.impshare, 1)]));
      };
      if (termChart) {
        termChart.on('click', (p) => {
          if (!p || !p.name) return;
          showCat(p.name);
        });
      }
      if (cats.length) {
        showCat(cats[0].name);
        if (termChart) termChart.dispatchAction({ type: 'select', seriesIndex: 0, name: cats[0].name });
      }
    }

    // 预测
    renderForecast(a, vm);

    // 建议
    const recWrap = document.getElementById('ads-actions');
    const items = a.recs || [];
    recWrap.innerHTML = panel('优化建议（按优先级）', items.length ? items.map((r) => (
      '<div class="todo"><span class="lv ' + r.level + '">' + r.level + '</span><div><div class="t">' + esc(r.title) + '</div>'
      + '<div class="d">' + esc(r.detail) + '</div></div><div class="a">' + esc(r.action) + '</div></div>'
    )).join('') : '<div class="muted">暂无建议，请先导入完整报表。</div>');

    // 事件
    bindToolbar(el, raw);
  }

  function renderForecast(a, vm) {
    const f = a.forecast;
    const wrap = document.getElementById('ads-forecast');
    if (!wrap) return;
    if (!f) { wrap.innerHTML = panel('预测', '<div class="muted">账户日报不足，无法预测。</div>'); return; }
    const curBudget = Math.round(f.dailySpend);
    const scenarios = [200, 300, 400].map((b) => scenario(f, b, 14));
    // 价值口径：用近 90 天「广告关联成交 / 商机」估转化，再乘客单价估成交额
    const convPerLead = vm && a.total.leads ? vm.adOrders / a.total.leads : 0;
    const aov = vm ? (vm.adAov || vm.aov) : 0;
    const hist = (a.daily || []).filter((r) => r.spend > 0).slice(-7)
      .map((r) => ({ d: r.date.slice(5), v: r.leads ? r.spend / r.leads : 0 }));
    const future = [];
    for (let i = 0; i < 14; i += 1) future.push({ d: 'D+' + (i + 1), v: f.dayCpl(i) });
    const labels = hist.map((x) => x.d).concat(future.map((x) => x.d));
    const histData = hist.map((x) => Number(x.v.toFixed(0))).concat(future.map(() => null));
    const futData = hist.map((x) => (x === hist[hist.length - 1] ? Number(x.v.toFixed(0)) : null))
      .concat(future.map((x) => Number(x.v.toFixed(0))));
    wrap.innerHTML = panel('未来 14 天预测（基于最近 ' + f.samples + ' 个有消耗日）',
      '<div class="muted" style="margin-bottom:8px">当前日均花费 ' + money(f.dailySpend) + '，CPL 趋势 ' + (f.slope >= 0 ? '上行 ' : '下行 ') + money(Math.abs(f.slope), 1) + '/天；样本 ' + f.samples + ' 天，拟合度 R²=' + f.r2.toFixed(2) + '；预测置信度：' + f.confidence + '。</div>'
      + '<div id="ads-forecast-chart" class="chart" style="height:260px;margin-bottom:10px"></div>'
      + table(['日预算', '14 天花费', '预计商机', '预计 CPL', '预计成交单', '预计成交额', '日均商机'], scenarios.map((s) => {
        const ord = s.leads * convPerLead;
        return [
          money(s.budget), money(s.spend), s.leads.toFixed(1), money(s.cpl),
          convPerLead ? ord.toFixed(2) : '—',
          convPerLead && aov ? '$' + Math.round(ord * aov) : '—',
          s.dailyLeads.toFixed(2),
        ];
      }))
      + '<div class="muted" style="margin-top:8px">按当前出价与转化结构推算；预计成交单/额按近 90 天「广告关联成交 ÷ 商机」与客单价折算，样本少时波动大；若调整商品、国家或否词，需重新评估。当前日均预算 ' + money(curBudget) + '。</div>');

    mkChart('ads-forecast-chart', {
      tooltip: { trigger: 'axis' },
      legend: { data: ['实际 CPL', '预测 CPL'], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 48, right: 20, top: 34, bottom: 28 },
      xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', name: 'CPL' },
      series: [
        { name: '实际 CPL', type: 'line', data: histData, connectNulls: false, itemStyle: { color: '#111827' }, lineStyle: { color: '#111827', width: 2 } },
        { name: '预测 CPL', type: 'line', data: futData, connectNulls: true, itemStyle: { color: '#b42318' }, lineStyle: { color: '#b42318', width: 2, type: 'dashed' } },
      ],
    });
  }

  /* ---------------- AI 深度诊断 ---------------- */
  function aiContext(a, biz) {
    const r = (v, d) => Number(v || 0).toFixed(d === undefined ? 0 : d);
    const vm = biz ? valueModel(a, biz, adsEcon) : null;
    return {
      window: '最近 90 天（首次同步保留 180 天日数据用于趋势）',
      total: { spend: r(a.total.spend), leads: a.total.leads, cpl: r(a.total.cpl), cpc: r(a.total.cpc, 2), ctr: r(a.total.ctr, 2), l1share: r(a.total.l1share, 1), orders: a.total.orders },
      months: a.months.map((m) => ({ month: m.month, spend: r(m.stats.spend), leads: m.stats.leads, cpl: r(m.stats.cpl) })),
      plans: a.plans.map((p) => ({ name: p.name.slice(0, 20), spend: r(p.spend), share: r(p.share, 1), leads: p.leads, cpl: r(p.cpl), l1share: p.leads ? r((p.l1leads / p.leads) * 100, 1) : 0 })),
      products: a.products.slice(0, 12).map((p) => ({ id: p.id, name: p.name.slice(0, 30), clicks: p.clicks, leads: p.leads, per100: r(p.leadsPer100, 1), estCpl: r(p.estCpl) })),
      geo: a.geo.slice(0, 12).map((g) => ({ name: g.name, clicks: g.clicks, leads: g.leads, per100: r(g.leadsPer100, 1) })),
      terms: a.terms.slice(0, 15).map((t) => t.name),
      business: biz ? {
        source: '本机资料库（询盘 + 订单，近 90 天）',
        adInquiries: biz.adInquiries,
        totalInquiries: biz.totalInquiries,
        hotInquiryShare: r(biz.hotShare, 1),
        hotInquiryGradeCoverage: r(biz.gradeCoverage, 1),
        addedRate: r(biz.addedRate, 1),
        replyRate: r(biz.replyRate, 1),
        firstReplyHours: r(biz.firstReplyHours, 1),
        firstReplySource: biz.firstReplySource,
        sla: biz.sla ? {
          sessions: biz.sla.samples, repliedSessions: biz.sla.repliedSamples, noReply: biz.sla.noReply,
          avgHours: r(biz.sla.avgHours, 1), p50Hours: r(biz.sla.p50Hours, 1),
          within30: r(biz.sla.within30, 1), within120: r(biz.sla.within120, 1),
          overdue: biz.sla.overdue.slice(0, 8).map((x) => ({ customer: x.name, level: x.level, hours: x.hours === null ? '未回复' : r(x.hours, 1), target: x.target })),
        } : null,
        funnel: biz.funnel ? {
          matched: biz.funnel.matched, total: biz.funnel.total, stages: biz.funnel.counts,
          quoteRate: r(biz.funnel.quoteRate, 1), sampleRate: r(biz.funnel.sampleRate, 1),
          wonRate: r(biz.funnel.wonRate, 1), lostRate: r(biz.funnel.lostRate, 1),
        } : null,
        wonOrders: biz.orders,
        gmv: r(biz.gmv),
        adLinkedOrders: biz.adOrders,
        adLinkedOrdersStrict: biz.adOrdersStrict,
        adLinkedOrdersEstimated: biz.adOrdersEstimated,
        buyerMatchedOrders: biz.buyerMatched,
        repeatOrders: biz.repeatOrders,
        split: biz.split ? {
          new: { orders: biz.split.new.orders, gmv: r(biz.split.new.gmv), adOrders: biz.split.new.adOrders, adGmv: r(biz.split.new.adGmv) },
          repeat: { orders: biz.split.repeat.orders, gmv: r(biz.split.repeat.gmv), adOrders: biz.split.repeat.adOrders, adGmv: r(biz.split.repeat.adGmv) },
          unmatched: { orders: biz.split.unmatched.orders, gmv: r(biz.split.unmatched.gmv) },
        } : null,
        firstTouch: biz.firstTouch ? {
          adCustomers: biz.firstTouch.customers,
          orders: biz.firstTouch.orders,
          gmv: r(biz.firstTouch.gmv),
          repeatOrders: biz.firstTouch.repeatOrders,
          ltvCustomers: biz.firstTouch.ltvCustomers,
          ltvGmv: r(biz.firstTouch.ltvGmv),
          ltv: r(biz.firstTouch.ltv),
          firstOrderRate: r(biz.firstTouch.firstOrderRate, 1),
          avgFirstOrderDays: r(biz.firstTouch.avgFirstOrderDays, 0),
        } : null,
        unattributedOrders: biz.unattributedCount,
        unattributedGmv: r(biz.unattributedGmv),
        stageFunnel: biz.stageFunnel ? {
          adInquiries: biz.stageFunnel.total,
          platformReplied: biz.stageFunnel.replied,
          identifiableCustomers: biz.stageFunnel.profiled,
          addedCustomers: biz.stageFunnel.added,
          adOrders: biz.stageFunnel.won,
          chatSampleSessions: biz.stageFunnel.chatSessions,
          chatQuoteSessions: biz.stageFunnel.chatQuote,
          chatSampleSessionsWithSpec: biz.stageFunnel.chatSample,
          note: '平台无报价/样品阶段字段；可识别客户=有客户名称，是首回、加客与归因的前提',
        } : null,
        adLinkedGmv: r(biz.adGmv),
        costPerAdOrder: biz.adOrders ? r(a.total.spend / biz.adOrders) : null,
        wonByCountry: Object.keys(biz.byCountry).sort((x, y) => biz.byCountry[y].gmv - biz.byCountry[x].gmv).slice(0, 6)
          .map((c) => ({ country: c, orders: biz.byCountry[c].orders, gmv: r(biz.byCountry[c].gmv) })),
        wonByProduct: Object.keys(biz.byProduct).sort((x, y) => biz.byProduct[y].gmv - biz.byProduct[x].gmv).slice(0, 6)
          .map((id) => ({ product: id, orders: biz.byProduct[id].orders, gmv: r(biz.byProduct[id].gmv) })),
        gaps: biz.gaps,
      } : null,
      value: vm && vm.hasValue ? {
        logic: '数量×质量×客单价：每百点击成交额高且客单价高的国家/商品优先加投；商机多但 0 成交的收紧；转化高但客单价低的先提客单（捆绑/起订量/高配款），不要盲目放量低价单',
        aov: r(vm.aov), adAov: r(vm.adAov),
        inquiryPer100Leads: r(vm.leadToInquiry, 1),
        inquiryPerLeadNote: '询盘条数/商机，可 >100%（同一商机多条询盘）',
        inquiryToOrderRate: r(vm.convRate, 1),
        ordersPer100Leads: r(vm.convPer100Leads, 1),
        gmvPer100Leads: r(vm.valuePer100Leads),
        spendPerAdOrder: r(vm.spendPerOrder),
        gmvPer100ClicksAll: r(vm.gmvPer100All),
        ordersPer100LeadsAll: r(vm.convAll, 1),
        economics: vm.econ && vm.econ.enabled ? {
          fxUsdCny: vm.econ.fx, grossMargin: r(vm.econ.margin * 100, 0),
          grossProfitCny: r(vm.econ.grossProfit), grossRoi: r(vm.econ.grossRoi * 100, 0),
          breakEvenCpl: r(vm.econ.breakEvenCpl), currentCpl: r(vm.cpl),
        } : null,
        geo: vm.geoRows.filter((x) => x.wonOrders > 0 || x.clicks >= 50).slice(0, 6)
          .map((x) => ({ name: x.name, clicks: x.clicks, leads: x.leads, orders: x.wonOrders, gmv: r(x.gmv), gmvPer100: r(x.gmvPer100), aov: r(x.aov), convRate: r(x.conv, 1), advice: x.advice })),
        products: vm.productRows.filter((x) => x.wonOrders > 0 || x.clicks >= 50).slice(0, 6)
          .map((x) => ({ product: x.key, name: x.name.slice(0, 24), clicks: x.clicks, leads: x.leads, orders: x.wonOrders, gmv: r(x.gmv), gmvPer100: r(x.gmvPer100), aov: r(x.aov), convRate: r(x.conv, 1), advice: x.advice })),
      } : null,
      forecast: a.forecast ? {
        samples: a.forecast.samples,
        cplSlope: r(a.forecast.slope, 1),
        r2: r(a.forecast.r2, 2),
        scenarios: [200, 300, 400].map((b) => { const s = scenario(a.forecast, b, 14); return { budget: b, leads: r(s.leads, 1), cpl: r(s.cpl) }; }),
      } : null,
      rules: a.recs.slice(0, 8).map((x) => ({ level: x.level, title: x.title, action: x.action })),
    };
  }

  /* AI 深度诊断与多轮问答：输入框提问 + 流式回答 */
  const AI_DIAG_Q = '请基于当前投流与业务数据做一次深度诊断：①一句话结论；②P0/P1 动作（按「每百点击成交额、客单价、商机质量」权衡，每条含数据依据与目标值，标明依据来自投流还是业务数据）；③未来 14 天预测与风险；④本周执行计划（今天 / 3 天内 / 本周各自做什么）；⑤需要补充的数据。';
  const AI_SYSTEM = '你是阿里国际站直通车投流与外贸运营顾问。你会拿到投流报表数据（total/months/plans/products/geo/terms/forecast）'
    + '与本机资料库的业务数据（business：询盘质量、回复率、首回 SLA 与超时名单、阶段漏斗、成交国家/商品）以及价值数据（value：客单价、商机→询盘→成交、每百点击成交额、毛利 ROI）。'
    + '判断是否放量时按「杠杆」逻辑：优先看每百点击成交额、客单价、成单率，而不是只看商机数与 CPL——商机多但 0 成交或客单低的方向要收紧，量少但成交额高的方向可小步加投。'
    + '若 business.sla 或 funnel 有数据，要优先用首回超时、报价推进率、流失率解释转化问题；若 value.economics 有值，用毛利 ROI 与盈亏平衡 CPL 判断还能不能加预算。'
    + '回答员工追问时：先给结论，再给数据依据（引用具体数字或维度），最后给可执行动作；投流与业务数据要交叉验证，不得编造，缺数据就直说缺什么。'
    + '默认 300 字以内；若员工要求完整诊断，按「结论 / P0 P1 动作 / 14 天预测 / 本周执行计划 / 数据缺口」分点展开到 800 字以内。中文回答。';

  function aiPanelHtml() {
    return panel('AI 深度诊断与问答',
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">'
      + '<span id="ads-ai-status" class="muted">' + esc(aiStatus || '可直接提问；点「AI 深度诊断」生成完整诊断') + '</span>'
      + '<button id="ads-ai-stop" class="ghost" style="margin-left:auto"' + (aiBusy ? '' : ' disabled') + '>停止</button>'
      + '<button id="ads-ai-reset" class="ghost">清空对话</button></div>'
      + '<div id="ads-ai-log" style="max-height:460px;overflow:auto"></div>'
      + '<div style="display:flex;gap:8px;align-items:flex-end;margin-top:10px">'
      + '<textarea id="ads-ai-input" rows="2" placeholder="问点什么：9 月 CPL 为什么上升？下周预算怎么排？哪些国家该暂停？（Enter 发送，Shift+Enter 换行）" '
      + 'style="flex:1;min-height:44px;max-height:140px;padding:8px 10px;border:1px solid #dfe3e8;border-radius:8px;font:13px/1.6 \'Microsoft YaHei\',sans-serif;resize:vertical"></textarea>'
      + '<button id="ads-ai-send">发送</button></div>'
      + '<div class="muted" style="margin-top:8px">基于当前投流报表与本机资料库（询盘/订单）作答；结论由本机模型生成，请核对后执行。</div>');
  }

  function setAiStatus(s) {
    aiStatus = s;
    const el = document.getElementById('ads-ai-status');
    if (el) el.textContent = s;
  }

  function setAiBusy(b) {
    aiBusy = b;
    const send = document.getElementById('ads-ai-send');
    const stop = document.getElementById('ads-ai-stop');
    if (send) { send.disabled = b; send.textContent = b ? '回答中…' : '发送'; }
    if (stop) stop.disabled = !b;
  }

  function renderAiLog() {
    const log = document.getElementById('ads-ai-log');
    if (!log) return;
    if (!aiMessages.length) {
      log.innerHTML = '<div class="muted" style="padding:4px 2px">还没有对话：点上方「AI 深度诊断」生成完整诊断，或在下方输入框直接提问，例如「9 月 CPL 为什么上升」「哪些计划该降预算」「下周预算怎么排」。</div>';
      return;
    }
    log.innerHTML = aiMessages.map((m) => (m.role === 'user'
      ? '<div style="margin:10px 0 6px;padding:8px 12px;background:#eef4ff;border-radius:8px;font-size:13px;white-space:pre-wrap">' + esc(m.content) + '</div>'
      : '<pre style="white-space:pre-wrap;background:#f9fafb;border:1px solid #eef1f4;border-radius:8px;padding:10px 12px;font:13px/1.75 \'Microsoft YaHei\',monospace;margin:0 0 10px">' + esc(m.content) + '</pre>')).join('');
    log.scrollTop = log.scrollHeight;
  }

  function bindAiPanel(raw) {
    const stop = document.getElementById('ads-ai-stop');
    if (stop) stop.onclick = () => { if (aiTask) aiTask.stop(); };
    const reset = document.getElementById('ads-ai-reset');
    if (reset) {
      reset.onclick = () => {
        if (aiTask) aiTask.stop();
        aiMessages.length = 0;
        renderAiLog();
        setAiStatus('已清空对话，可重新提问');
        const input = document.getElementById('ads-ai-input');
        if (input) { input.value = ''; input.focus(); }
      };
    }
    const input = document.getElementById('ads-ai-input');
    const send = document.getElementById('ads-ai-send');
    const submit = () => {
      if (!input) return;
      const q = input.value.trim();
      if (!q) return;
      input.value = '';
      askAi(raw, q);
    };
    if (send) send.onclick = submit;
    if (input) {
      input.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      };
    }
  }

  // 单轮提问：把当前数据快照 + 历史对话 + 新问题交给模型，流式写回
  async function askAi(raw, question) {
    const q = String(question || '').trim();
    if (!q) return;
    if (!raw || !raw.account || !raw.account.length) { toast('请先同步或导入数据'); return; }
    if (aiBusy) { toast('正在回答，请先停止或稍候'); return; }
    aiBusy = true;
    const cfg = await new Promise((r) => chrome.storage.local.get(['aliAiCfg'], (o) => r(o && o.aliAiCfg ? o.aliAiCfg : {})));
    if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) { aiBusy = false; toast('请先在「设置」里配置 AI 模型与 API Key'); return; }

    const a = analyze(raw);
    const biz = await loadBusiness(a);
    const snapshot = JSON.stringify(aiContext(a, biz));
    const url = String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions';
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey };
    const payload = (stream) => JSON.stringify({
      model: cfg.model,
      temperature: 0.3,
      stream,
      messages: [
        { role: 'system', content: AI_SYSTEM },
        { role: 'user', content: '当前数据快照（JSON）：' + snapshot },
      ].concat(aiMessages),
    });

    aiMessages.push({ role: 'user', content: q });
    renderAiLog();
    const log = document.getElementById('ads-ai-log');
    const live = document.createElement('pre');
    live.style.cssText = "white-space:pre-wrap;background:#f9fafb;border:1px solid #eef1f4;border-radius:8px;padding:10px 12px;font:13px/1.75 'Microsoft YaHei',monospace;margin:0 0 10px";
    live.textContent = '▍';
    if (log) { log.appendChild(live); log.scrollTop = log.scrollHeight; }
    setAiStatus('思考中…');
    setAiBusy(true);

    let text = '';
    let finished = false;
    let lastAt = Date.now();
    let port = null;
    let heartbeat = null;
    let watchdog = null;
    let task = null;
    const removeLive = () => { try { if (live.parentNode) live.parentNode.removeChild(live); } catch (e) { /* ignore */ } };
    const renderLive = (caret) => {
      live.textContent = text + (caret && !finished ? '▍' : '');
      if (log) log.scrollTop = log.scrollHeight;
    };
    const cleanup = () => {
      clearInterval(heartbeat); clearInterval(watchdog);
      heartbeat = null; watchdog = null;
      const p = port; port = null;
      try { if (p) p.disconnect(); } catch (e) { /* ignore */ }
      if (aiTask === task) aiTask = null;
    };
    const commit = (statusText) => {
      finished = true;
      cleanup();
      if (text) aiMessages.push({ role: 'assistant', content: text });
      removeLive();
      renderAiLog();
      setAiStatus(statusText);
      setAiBusy(false);
    };
    // 流式不可用时退回一次性请求
    const fallback = async () => {
      setAiStatus('流式异常，改用普通模式重试…');
      try {
        const res = await new Promise((resolve) => chrome.runtime.sendMessage({
          type: 'aiChat', url, headers, body: payload(false),
        }, resolve));
        if (!res) throw new Error('扩展后台无响应');
        if (!res.ok) throw new Error('HTTP ' + (res.status || '') + ' ' + String(res.text || res.error || '').slice(0, 200));
        let full = '';
        try {
          const j = JSON.parse(res.text);
          full = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
        } catch (e) { full = String(res.text || ''); }
        text = full;
        commit('已完成（普通模式）');
      } catch (e) {
        finished = true;
        removeLive();
        renderAiLog();
        setAiStatus('分析失败：' + String((e && e.message) || e));
        setAiBusy(false);
      }
    };
    const endWithError = (msg) => {
      if (finished) return;
      if (!text) { finished = true; cleanup(); fallback(); return; }
      commit('已中断：' + msg + '（以上为已接收内容）');
    };

    task = {
      stop() {
        if (finished) return;
        try { if (port) port.postMessage({ type: 'abort' }); } catch (e) { /* ignore */ }
        commit('已停止');
      },
    };
    aiTask = task;

    try {
      port = chrome.runtime.connect({ name: 'aiStream' });
    } catch (e) {
      finished = true;
      cleanup();
      fallback();
      return;
    }
    port.onMessage.addListener((m) => {
      if (!m || finished) return;
      if (m.type === 'delta') {
        lastAt = Date.now();
        text += String(m.text || '');
        setAiStatus('正在输出…');
        renderLive(true);
      } else if (m.type === 'done') {
        if (!text) { finished = true; cleanup(); fallback(); return; }
        commit('已完成');
      } else if (m.type === 'error') {
        endWithError(String(m.error || '未知错误'));
      }
    });
    port.onDisconnect.addListener(() => {
      if (!finished) endWithError('后台连接已断开（扩展可能被重新加载）');
    });
    // 12 秒心跳保活 service worker；90 秒无新增内容判定超时
    heartbeat = setInterval(() => {
      try { port.postMessage({ type: 'ping' }); } catch (e) { /* 端口已断 */ }
    }, 12000);
    watchdog = setInterval(() => {
      if (!finished && Date.now() - lastAt > 90000) endWithError('模型 90 秒无输出，可能超时');
    }, 5000);

    port.postMessage({ type: 'aiStream', url, headers, body: payload(true) });
  }

  function aiDiagnose(raw) {
    if (!raw || !raw.account || !raw.account.length) { toast('请先同步或导入数据'); return; }
    if (aiTask) aiTask.stop();
    askAi(raw, AI_DIAG_Q);
    setTimeout(() => {
      const input = document.getElementById('ads-ai-input');
      if (input) input.focus();
    }, 80);
  }

  /* ---------------- 一键同步（平台页面自动化） ---------------- */
  let collecting = false;
  // 平台会在 i.alibaba.com 与 www2.alibaba.com 之间跳转，两个域名都要认
  const DL_URL = 'https://www2.alibaba.com/ads/download.htm';
  const REPORT_URL = 'https://www2.alibaba.com/ads/p4p/report.htm';
  const DL_RE = /^https:\/\/(?:i|www2)\.alibaba\.com\/ads\/download\.htm/;
  const REPORT_RE = /^https:\/\/(?:i|www2)\.alibaba\.com\/ads\/p4p\/report\.htm/;

  function queryTabs() {
    return new Promise((resolve) => chrome.tabs.query({}, (tabs) => resolve(tabs || [])));
  }

  function openDownloadTab() {
    return new Promise((resolve) => chrome.tabs.create({ url: DL_URL, active: false }, resolve));
  }

  function closeTab(id) {
    return new Promise((resolve) => { try { chrome.tabs.remove(id, () => resolve()); } catch (e) { resolve(); } });
  }

  // 后台标签页会被浏览器冻结，长任务消息可能一直不响应；操作前先切到前台
  function activateTab(id) {
    return new Promise((resolve) => {
      try { chrome.tabs.update(id, { active: true }, () => resolve()); } catch (e) { resolve(); }
    });
  }

  async function findNewDownloadTab(known) {
    const tabs = await queryTabs();
    return tabs.find((t) => t && t.id && !known.has(t.id)
      && (DL_RE.test(t.url || '') || DL_RE.test(t.pendingUrl || ''))) || null;
  }

  async function waitPing(tabId, tries) {
    for (let i = 0; i < (tries || 40); i += 1) {
      try {
        const r = await chrome.tabs.sendMessage(tabId, { type: 'adsCollectPing' });
        if (r && r.ok) return true;
      } catch (e) { /* 页面还在加载或未注入 */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('未收到页面响应');
  }

  // 扩展更新后旧标签页不会自动带内容脚本：这里主动补注入（脚本自带去重标记）
  function injectCollector(tabId) {
    return new Promise((resolve) => {
      try {
        if (!chrome.scripting || !chrome.scripting.executeScript) { resolve(false); return; }
        chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['src/ads-collector.js'] }, () => {
          const err = chrome.runtime.lastError;
          resolve(!err);
        });
      } catch (e) { resolve(false); }
    });
  }

  async function pingOrInject(tabId, tries) {
    try { await waitPing(tabId, tries); return true; } catch (e) { /* 需要补注入 */ }
    await injectCollector(tabId);
    try { await waitPing(tabId, 12); return true; } catch (e) { return false; }
  }

  async function readyTab(tabId) {
    if (await pingOrInject(tabId, 30)) return;
    // 旧标签页可能属于上一版扩展实例（没有内容脚本），刷新后重新注入
    try { await new Promise((r) => chrome.tabs.update(tabId, { active: true }, r)); } catch (e) { /* ignore */ }
    await reloadTab(tabId);
    await sleep(2500);
    if (await pingOrInject(tabId, 30)) return;
    throw new Error('页面未就绪：已尝试自动注入脚本并刷新。请确认已登录国际站并停留在营销中心；仍失败可先关闭直通车报告标签页再重试');
  }

  function sendMsg(tabId, msg, timeout, label) {
    const ms = timeout || 90000;
    return Promise.race([
      chrome.tabs.sendMessage(tabId, msg),
      new Promise((_, reject) => setTimeout(() => reject(new Error(
        (label ? '「' + label + '」' : '') + '页面响应超时（' + Math.round(ms / 1000) + ' 秒）'
      )), ms)),
    ]);
  }

  // 失败时清掉本轮自动打开的下载中心页，避免下一份报表误抓旧记录
  async function closeStrayDownloadTabs(initialIds, known) {
    const tabs = await queryTabs();
    for (const t of tabs) {
      if (t && t.id && !initialIds.has(t.id) && DL_RE.test(t.url || '')) {
        known.add(t.id);
        await closeTab(t.id);
      }
    }
  }

  function reloadTab(id) {
    return new Promise((resolve) => { try { chrome.tabs.reload(id, {}, () => resolve()); } catch (e) { resolve(); } });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function collect(el, raw) {
    if (collecting) return false;
    collecting = true;
    let succeeded = false;
    const btn = document.getElementById('ads-sync');
    const setStatus = (t) => {
      const node = document.getElementById('ads-sync-status');
      if (node) node.textContent = t;
    };
    if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }

    const initialTabs = await queryTabs();
    const initialIds = new Set(initialTabs.map((t) => t.id));
    const known = new Set(initialIds);
    const selfTab = await new Promise((resolve) => { try { chrome.tabs.getCurrent((t) => resolve(t || null)); } catch (e) { resolve(null); } });
    try {
      const endDate = new Date(Date.now() - 86400000);
      const startDate = new Date(endDate.getTime() - 89 * 86400000);
      const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const start = fmt(startDate);
      const end = fmt(endDate);
      setStatus('正在打开直通车报告（' + start + ' ~ ' + end + '）…');

      let tab = initialTabs.find((t) => t && REPORT_RE.test(t.url || ''));
      if (!tab) {
        tab = await new Promise((resolve) => chrome.tabs.create({ url: REPORT_URL, active: false }, resolve));
      }
      // 报告页 SPA 需要可见才能完整渲染；先尝试后台，失败时再切前台
      await readyTab(tab.id);
      await activateTab(tab.id);

      const items = [];
      const firstRun = !(raw && raw.account && raw.account.length);
      const accountDays = firstRun ? 180 : 90;
      const kinds = [
        ['account', '账户概览', accountDays],
        ['plan', '计划', 90],
        ['product', '商品', 90],
        ['geo', '账户分地域', 90],
        ['term', '搜索词', 0],
      ];
      const failed = [];
      let domAccount = null;   // 账户报导出失败时，直接读页面明细的兜底数据
      const rangeFor = (days) => {
        if (!days) return { s: '', e: '' };
        const endD = new Date(Date.now() - 86400000);
        const startD = new Date(endD.getTime() - (days - 1) * 86400000);
        const f = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        return { s: f(startD), e: f(endD) };
      };
      // 采集单份报表（准备 → 导出 → 下载中心抓取）
      async function runOne(kind, label, days) {
        const range = rangeFor(days);
        const s = range.s;
        const e = range.e;
        await activateTab(tab.id);
        setStatus('正在导出「' + label + '」' + (days ? '（近 ' + days + ' 天）' : '（平台固定 7 天）') + '…');
        let prep = null;
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            prep = await sendMsg(tab.id, { type: 'adsCollectPrepare', kind, start: s, end: e }, 90000, '准备' + label);
            if (prep && prep.ok === false) throw new Error(prep.error || ('切换/设置' + label + '失败'));
            break;
          } catch (err) {
            lastErr = err;
            const timedOut = /超时/.test((err && err.message) || '');
            if (attempt === 0) {
              setStatus('「' + label + '」' + (timedOut ? '页面无响应，正在刷新报告页重试…' : '页面未就绪，正在把报告页切到前台重试…'));
              if (timedOut) {
                await reloadTab(tab.id);
                await sleep(2500);
              } else {
                try { await new Promise((r) => chrome.tabs.update(tab.id, { active: true }, r)); } catch (e2) { /* ignore */ }
                await sleep(1500);
              }
              await readyTab(tab.id);
            } else if (attempt === 1) {
              setStatus('「' + label + '」仍在加载，正在刷新报告页重试…');
              await reloadTab(tab.id);
              await sleep(2500);
              await readyTab(tab.id);
            }
          }
        }
        if (!prep) throw lastErr || new Error('准备导出失败');

        // 先打开下载中心记录基线，避免拿到上一次导出的旧文件
        let dl = await openDownloadTab();
        if (!dl || !dl.id) throw new Error('无法打开下载中心页签');
        known.add(dl.id);
        await readyTab(dl.id);
        await activateTab(dl.id);
        let baseline = [];
        try {
          const listed = await sendMsg(dl.id, { type: 'adsCollectList' }, 20000, '读取下载中心');
          if (listed && listed.rows) baseline = listed.rows.map((r) => r.href);
        } catch (e) { baseline = []; }

        await sendMsg(tab.id, { type: 'adsCollectExport' }, 45000, '触发导出' + label);
        await sleep(2000);

        // 平台可能自己再弹一个下载中心页：关掉它，复用我们这页
        const extra = await findNewDownloadTab(known);
        if (extra) { known.add(extra.id); await closeTab(extra.id); }
        await reloadTab(dl.id);
        await sleep(1500);
        await readyTab(dl.id);
        await activateTab(dl.id);

        let file = null;
        try {
          file = await sendMsg(dl.id, { type: 'adsCollectGrab', kind, start: s, end: e, baseline: baseline }, 180000, '下载' + label);
        } catch (e) {
          await reloadTab(dl.id);
          await sleep(1500);
          await readyTab(dl.id);
          file = await sendMsg(dl.id, { type: 'adsCollectGrab', kind, start: s, end: e, baseline: baseline }, 180000, '下载' + label);
        }
        if (!file || file.ok === false) throw new Error((file && file.error) || ('下载' + label + '失败'));
        items.push({ name: file.name, buffer: base64ToBuf(file.base64) });
        await closeTab(dl.id);
      }
      for (const pair of kinds) {
        const kind = pair[0];
        const label = pair[1];
        const days = pair[2];
        try {
          if (kind === 'account') {
            // 账户报优先直读报表页（平台导出队列经常卡「加载中」）；直读失败再走导出
            setStatus('正在读取「账户概览」明细（近 ' + days + ' 天）…');
            let got = null;
            const tries = days === 180 ? [180, 90] : [days || 90];
            for (const dd of tries) {
              const r = rangeFor(dd);
              try {
                await activateTab(tab.id);
                const t = await sendMsg(tab.id, { type: 'adsCollectAccountDom', start: r.s, end: r.e }, 240000, '读取账户明细');
                if (t && t.ok && t.body && t.body.length >= Math.min(dd, 7) - 2) { got = t; break; }
              } catch (e2) { /* 试下一个区间 */ }
            }
            if (got) {
              domAccount = normalize({ account: { headers: got.headers, body: got.body } });
              setStatus('账户概览已从报表页直读（' + got.body.length + ' 天），继续下一份…');
            } else {
              setStatus('账户明细直读失败，改为导出「账户概览」…');
              await runOne(kind, label, days);
            }
          } else {
            await runOne(kind, label, days);
          }
        } catch (err) {
          const msg = (err && err.message) || String(err);
          failed.push({ label: label, msg: msg });
          setStatus('「' + label + '」未完成：' + msg + '，继续下一份…');
          await closeStrayDownloadTabs(initialIds, known);
        }
      }
      if (!items.length && !domAccount) {
        throw new Error('全部报表未取到：' + failed.map((f) => f.label + '（' + f.msg + '）').join('；'));
      }

      setStatus('正在解析并计算…');
      const merged = items.length
        ? await importBuffers(items, raw)
        : (raw ? JSON.parse(JSON.stringify(raw)) : { account: [], plan: [], product: [], geo: [], term: [], meta: {} });
      if (domAccount && domAccount.account && domAccount.account.length) {
        merged.account = mergeDaily(merged.account, domAccount.account);
        merged.meta = Object.assign({}, merged.meta || {}, { types: TYPES.filter((t) => merged[t] && merged[t].length) });
      }
      await save(merged);
      succeeded = !!(merged.account && merged.account.length);
      if (document.body.contains(el)) {
        const a2 = analyze(merged);
        const biz2 = await loadBusiness(a2);
        paint(el, merged, { updatedAt: Date.now() }, biz2);
        if (failed.length) {
          toast('同步部分完成：成功 ' + items.length + ' 份，失败 ' + failed.length + ' 份');
          setStatus('部分完成：成功 ' + items.length + ' 份；失败：' + failed.map((f) => f.label + '（' + f.msg + '）').join('、') + '。可稍后重试或手动导入。');
        } else {
          const domNote = domAccount ? '（账户概览由报表页直读）' : '';
          toast('同步完成：已更新 ' + items.length + ' 份报表' + domNote);
          setStatus('同步完成：已更新 ' + items.length + ' 份报表' + domNote);
        }
      }
    } catch (e) {
      const msg = e && e.message || String(e);
      toast('同步失败：' + msg);
      setStatus('同步失败：' + msg + '。可改用「导入报表」手动导入。');
    } finally {
      // 清理本次自动打开的下载中心页（不动用户原有页签）
      const tabs = await queryTabs();
      for (const t of tabs) {
        if (!initialIds.has(t.id) && DL_RE.test(t.url || '')) await closeTab(t.id);
      }
      // 回到看板
      if (selfTab && selfTab.id) {
        try { await new Promise((r) => chrome.tabs.update(selfTab.id, { active: true }, r)); } catch (e) { /* ignore */ }
      }
      collecting = false;
      const b = document.getElementById('ads-sync');
      if (b) { b.disabled = false; b.textContent = '一键同步数据'; }
    }
    return succeeded;
  }

  async function importBuffers(items, base) {
    const merged = base ? JSON.parse(JSON.stringify(base)) : { account: [], plan: [], product: [], geo: [], term: [], meta: {} };
    for (const it of items) {
      const wb = XLSX.read(it.buffer, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
      const table = toTable(rows);
      if (!table) continue;
      const type = classify(table.headers);
      if (!type) throw new Error('无法识别文件「' + it.name + '」，请导出直通车报告标准文件');
      const payload = { account: null, plan: null, product: null, geo: null, term: null };
      payload[type] = table;
      const part = normalize(payload);
      if (type === 'account') merged.account = mergeDaily(base && base.account, part.account);
      else merged[type] = part[type];
    }
    merged.meta = { types: TYPES.filter((t) => merged[t] && merged[t].length) };
    return merged;
  }

  async function importFiles(files, base) {
    const items = [];
    for (const f of files) items.push({ name: f.name, buffer: await f.arrayBuffer() });
    return importBuffers(items, base);
  }

  function base64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  async function save(raw) {
    const prev = await new Promise((r) => chrome.storage.local.get([KEY], (o) => r(o && o[KEY] ? o[KEY] : null)));
    if (prev && prev.raw && prev.raw.account && prev.raw.account.length) {
      const pa = analyze(prev.raw);
      raw.meta = Object.assign({}, raw.meta || {}, {
        prev: {
          at: Date.now(), spend: pa.total.spend, leads: pa.total.leads,
          cpl: pa.total.cpl, cpc: pa.total.cpc, ctr: pa.total.ctr,
        },
      });
    }
    const meta = Object.assign({}, raw.meta || {}, { updatedAt: Date.now() });
    await new Promise((r) => chrome.storage.local.set({ [KEY]: { raw, meta } }, r));
  }

  function exportCsv(a) {
    const lines = [];
    lines.push('指标,数值');
    [['花费', a.total.spend], ['商机', a.total.leads], ['商机成本', a.total.cpl], ['点击', a.total.clicks],
      ['点击成本', a.total.cpc], ['点击率', a.total.ctr], ['L1+商机占比', a.total.l1share], ['订单', a.total.orders]]
      .forEach(([k, v]) => lines.push(k + ',' + (typeof v === 'number' ? v.toFixed(2) : v)));
    lines.push('');
    lines.push('计划,花费,商机,CPL,CPC,CTR,占比');
    a.plans.forEach((p) => lines.push([p.name, p.spend, p.leads, p.cpl.toFixed(2), p.cpc.toFixed(2), p.ctr.toFixed(2), p.share.toFixed(1)].join(',')));
    lines.push('');
    lines.push('商品ID,点击,商机,每百点击商机,估算CPL');
    a.products.forEach((p) => lines.push([p.id || p.name, p.clicks, p.leads, p.leadsPer100.toFixed(2), p.leads ? p.estCpl.toFixed(0) : ''].join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '投流诊断_' + new Date().toISOString().slice(0, 10) + '.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function destroyCharts() {
    charts.forEach((c) => { try { c.dispose(); } catch (e) { /* ignore */ } });
    charts = [];
  }
  function destroy() {
    if (aiTask) aiTask.stop();
    destroyCharts();
    rootEl = null;
  }
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  const api = { render, destroy, analyze, normalize, importFiles, importBuffers, save, scenario, mergeDaily, buildBusiness, buildChatSla, buildChatProgress, buildFunnel, businessRecs, valueModel, valueRecs, KEY, HISTORY_KEY };
  if (typeof self !== 'undefined') self.AliAdsInsight = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      charts.forEach((c) => { try { c.resize(); } catch (e) { /* ignore */ } });
    });
  }
})();
