// 业务视角分析（纯逻辑，无 DOM / 无 chrome API，便于在 Node 下单测）
// 口径：
//   询盘侧买家等级 = A/B/C（A、B 记为高价值）
//   客户侧买家等级 = L0~L4（L3/L4 或 金牌买家、星标客户 记为高价值客户）
//   待核实加客 = 询盘记录显示「否」，且当前我的客户快照没有匹配档案
(function () {
  'use strict';
  const CORE = typeof self !== 'undefined' ? self.AliDataCore : require('./data-core');
  const identityApi = () => {
    if (typeof self !== 'undefined' && self.AliIdentity) return self.AliIdentity;
    if (typeof require === 'function') {
      try { return require('./identity'); } catch (e) { return null; }
    }
    return null;
  };

  const TIER_ORDER = ['L0', 'L1', 'L2', 'L3', 'L4'];
  const TIER_MEAN = { L0: '注册买家', L1: '潜力买家', L2: '小B买家', L3: '企业类买家', L4: '金标买家' };

  const val = (o, k) => {
    const v = o ? o[k] : '';
    if (v === undefined || v === null) return '';
    const s = String(v).trim();
    return s === '-' ? '' : s;
  };
  const toNum = (v, d) => {
    const n = parseFloat(String(v === undefined || v === null ? '' : v).replace(/[,$\s]/g, ''));
    return isNaN(n) ? (d || 0) : n;
  };
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => (d ? d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) : '');
  const fmtDT = (d, withSec) => (d ? dayKey(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + (withSec ? ':' + pad(d.getSeconds()) : '') : '');
  function toDt(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    const s = String(v).trim();
    if (!s || s === '-') return null;
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') : s);
    return isNaN(d.getTime()) ? null : d;
  }

  const fmtName = (x) => val(x, '客户名称') || val(x, '公司名称') || '未命名客户';
  const invGrade = (x) => (val(x, '买家等级') || '-').toUpperCase();
  // 询盘侧等级：老数据是字母 A/B/C；新数据（v0.16.0 起）是用客户库关联到的 L0~L4 —— 两套都认
  const HOT_INQ = ['A', 'B', 'L3', 'L4'];
  const isHotInquiry = (x) => HOT_INQ.indexOf(invGrade(x)) >= 0 || val(x, '金牌买家') === '是';
  const custTier = (c) => (val(c, '买家等级') || '-').toUpperCase();
  const isHotCustomer = (c) => ['L3', 'L4'].indexOf(custTier(c)) >= 0 || val(c, '金牌买家') === '是' || val(c, '星标客户') === '是';
  function respMinutes(x) {
    const a = toDt(val(x, '创建时间')), b = toDt(val(x, '最新回复时间'));
    return a && b && b >= a ? (b - a) / 60000 : null;
  }
  function counter(list) {
    const m = new Map();
    list.forEach((k) => m.set(k, (m.get(k) || 0) + 1));
    return m;
  }
  const top = (map, n) => Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, n === undefined ? map.size : n);

  // ---------------- 取词 ----------------
  const STOP = new Set(`
the and for you your are with this that have has can will would our from not but all any how what when
please dear hello hi thanks thank ok yes no is it to of in on at we us be as if so me my i a an or do does
did about would could should there here they them their he she his her its was were been being am
send sent get got want need know make made use used new one two three also more most much many very
good great best nice well fine high low quality best regards regard sir madam mrs mr ms prof
inch mm cm kg g piece pieces pcs set sets bag bags box boxes carton cartons
product products price prices order orders quantity sample samples service
inquiry tm store homepage details page card workspace type idx fromuid touid
alibaba www http https com cn net org email mail tel phone mobile
about like just know think see come going back even still well now first last
next other some than then them these those been because before after again
ever every few into more most only over same such take very where which while
who why work okay per give buyer app let
que para por con los las del una uno pero como este esta esto ya muy mas
el la de en es al lo su sus me nos le les te tu mi
`.split(/\s+/).filter(Boolean));
  const WORD_RE = /[A-Za-z][A-Za-z\-]{2,}/g;
  const CJK_RE = /[\u4e00-\u9fa5]{2,}/g;
  const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
  const ENT_RE = /&[a-zA-Z#0-9]{2,8};/g;
  const HEX_RE = /^[0-9a-f]{10,}$/i;
  const SYS_NOTICE = ['翻译功能升级', '请更新app', '此消息为系统', 'Reply Card helps'];

  function extractWords(text) {
    if (!text) return [];
    const s = String(text).replace(URL_RE, ' ').replace(ENT_RE, ' ');
    const out = [];
    (s.match(WORD_RE) || []).forEach((w0) => {
      const w = w0.toLowerCase().replace(/^-+|-+$/g, '');
      if (w.length < 3 || STOP.has(w)) return;
      if (/\d/.test(w)) return;      // 带数字的多为参数名/编码噪声
      if (HEX_RE.test(w)) return;
      out.push(w);
    });
    (s.match(CJK_RE) || []).forEach((w) => out.push(w));
    return out;
  }
  const isSystemPayload = (s) => {
    const t = String(s === undefined || s === null ? '' : s).trim();
    return t.indexOf('://') >= 0 || t.startsWith('{') || t.startsWith('[') || t.indexOf('":') >= 0 || (t.indexOf('{') >= 0 && t.indexOf('}') >= 0);
  };

  // 拆「进店来源词 / 搜索关键词」：逗号分隔的关键词短句，保留短语不拆词
  function splitTerms(v) {
    return String(v === undefined || v === null ? '' : v)
      .split(/[,，;；\n]+/)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length > 1 && x.length < 40 && x !== '-');
  }

  function keywordCorpus(data) {
    const out = []; // {w, dt, country, src}
    (data.inquiry || []).forEach((x) => {
      const text = [val(x, '询盘主题'), val(x, '咨询产品')].join(' ');
      const dt = toDt(val(x, '创建时间'));
      const ctry = val(x, '国家') || '-';
      extractWords(text).forEach((w) => out.push({ w, dt, country: ctry, src: '询盘' }));
    });
    (data.chat || []).forEach((m) => {
      if (String(val(m, '角色')).indexOf('业务员') >= 0) return;   // 只看客户侧
      const c = val(m, '内容');
      if (isSystemPayload(c) || SYS_NOTICE.some((t) => String(c).indexOf(t) >= 0)) return;
      const dt = toDt(val(m, '发送时间'));
      extractWords(c).forEach((w) => out.push({ w, dt, country: '-', src: '聊天' }));
    });
    return out;
  }

  // ---------------- 今日待办 ----------------
  function home(data, at) {
    const inv = data.inquiry || [];
    const mine = data.customer || [];
    const pub = data.public_customer || [];
    const IDX = (typeof self !== 'undefined' && self.AliIdentity) ? self.AliIdentity.build(data) : null;
    const now = at ? new Date(at) : new Date();
    const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
    const inWindow = (value) => {
      const d = toDt(value);
      return !!(d && d >= windowStart && d <= now);
    };
    const newInv = inv.filter((x) => inWindow(val(x, '创建时间')));
    const stages = data.stages || {};
    const isClosed = (x) => {
      const stage = stages[val(x, '询盘ID')] || {};
      return ['已成交', '已流失', '无效询盘'].includes(stage.stage) && !!stage.evidence;
    };
    const inMine = (x) => {
      if (!IDX) return false;
      const profile = IDX.byUid.get(IDX.uidOfInquiry(x));
      return !!(profile && profile.mineCount > 0);
    };
    const uniqByName = (rows) => {
      const seen = new Set(); const out = [];
      rows.forEach((x) => {
        const uid = IDX ? IDX.uidOfInquiry(x) : fmtName(x);
        if (seen.has(uid)) return;
        seen.add(uid); out.push(x);
      });
      return out;
    };

    const todos = [];
    const CRM_MINE = 'https://i.alibaba.com/hub/alicrm/my_customer';
    const CRM_PUBLIC = 'https://i.alibaba.com/hub/alicrm/public_customer';
    const inquiryUrl = (x) => val(x, '询盘ID')
      ? 'https://message.alibaba.com/message/maDetail.htm?imInquiryId=' + encodeURIComponent(val(x, '询盘ID'))
      : 'https://message.alibaba.com/message/default.htm';
    const chatUrl = (name) => 'https://onetalk.alibaba.com/message/weblitePWA.htm'
      + (name ? ('?aliChat=' + encodeURIComponent(String(name))) : '');
    const nm = (v) => String(v || '').toLowerCase().replace(/[\s\u3000]+/g, '').replace(/[.,，。()（）"'&·-]/g, '').trim();
    const chatList = data.chat || [];
    const lastBySession = new Map();
    chatList.forEach((m) => {
      const key = nm(val(m, '会话'));
      if (!key) return;
      const at = toDt(val(m, '发送时间'));
      if (!at) return;
      const saved = lastBySession.get(key);
      if (!saved || at > saved.at) lastBySession.set(key, { row: m, at });
    });
    const chatCache = new Map();
    const lastChatOf = (name) => {
      const cacheKey = nm(name);
      if (chatCache.has(cacheKey)) return chatCache.get(cacheKey);
      const prof = IDX ? IDX.lookup(name) : null;
      let latest = null;
      if (prof && prof.chatSessions.length) {
        prof.chatSessions.forEach((session) => {
          const hit = lastBySession.get(nm(session));
          if (hit && (!latest || hit.at > latest.at)) latest = hit;
        });
      } else {
        if (!cacheKey) return null;
        latest = lastBySession.get(cacheKey) || null;
        if (!latest) lastBySession.forEach((hit, key) => {
          if ((key.includes(cacheKey) || cacheKey.includes(key)) && (!latest || hit.at > latest.at)) latest = hit;
        });
      }
      chatCache.set(cacheKey, latest ? latest.row : null);
      return latest ? latest.row : null;
    };
    const activityCache = new WeakMap();
    const activityAt = (x) => {
      if (activityCache.has(x)) return activityCache.get(x);
      const stage = stages[val(x, '询盘ID')] || {};
      const latestChat = lastChatOf(fmtName(x));
      const dates = [val(x, '创建时间'), val(x, '最新回复时间'), stage.at,
        latestChat && val(latestChat, '发送时间')].map(toDt).filter(Boolean);
      const activity = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
      activityCache.set(x, activity);
      return activity;
    };
    const recentInv = inv.filter((x) => inWindow(activityAt(x)));
    const unconverted = recentInv.filter((x) => val(x, '是否已加为客户') === '否' && !isClosed(x) && !inMine(x));
    const early = unconverted.filter((x) => !['已报价', '样品/规格确认'].includes((stages[val(x, '询盘ID')] || {}).stage));
    const hotWait = early.filter(isHotInquiry);
    const hotIds = new Set(hotWait.map((x) => val(x, '询盘ID')));
    const otherUnconv = uniqByName(early.filter((x) => !hotIds.has(val(x, '询盘ID'))));
    const hotU = uniqByName(hotWait);
    const recentCrm = (c) => ['最近联系时间', '备注时间', '最近备注时间', '创建时间']
      .some((field) => inWindow(val(c, field)));
    const riskCust = mine.filter((c) => ['y', 'Y', '是'].includes(val(c, '流失预警')) && recentCrm(c));
    const pubHot = pub.filter((c) => isHotCustomer(c) && recentCrm(c));
    const staleInv = recentInv.filter((x) => {
      if (isClosed(x) || ['已报价', '样品/规格确认'].includes((stages[val(x, '询盘ID')] || {}).stage)) return false;
      const latest = lastChatOf(fmtName(x));
      const latestAt = latest && toDt(val(latest, '发送时间'));
      const inquiryAt = toDt(val(x, '最新回复时间')) || toDt(val(x, '创建时间'));
      if (latestAt && inWindow(latestAt) && (!inquiryAt || latestAt >= inquiryAt))
        return !String(val(latest, '角色')).includes('业务员');
      return inWindow(inquiryAt) && val(x, '回复状态') !== '已回复'
        && (val(x, '回复状态') === '待回复' || toNum(val(x, '未联系天数')) > 0);
    }).sort((a, b) => activityAt(b) - activityAt(a));
    const custOf = (name) => {
      if (IDX) {
        const row = IDX.customerRowOf(name);
        if (row) return row;
      }
      return mine.find((c) => nm(val(c, '公司名称')) === nm(name) || nm(val(c, '联系人')) === nm(name)) || null;
    };
    const lastLine = (name) => {
      const m = lastChatOf(name);
      if (!m) return '暂无有效聊天记录';
      const mineSide = String(val(m, '角色')).indexOf('业务员') >= 0;
      return (mineSide ? '最后我方：' : '最后客户：') + String(val(m, '内容') || '').slice(0, 36);
    };
    const aiOfInquiry = (x) => {
      const name = fmtName(x);
      const c = custOf(name);
      return {
        interaction: lastLine(name),
        behavior: [val(x, '国家'), val(x, '来源'), '询盘等级 ' + invGrade(x), val(x, '询盘主题')].filter(Boolean).join(' · ') || '资料不足',
        value: [c && val(c, '订单数') && ('客户库订单数 ' + val(c, '订单数')), c && val(c, '年采购额') && ('年采购额 ' + val(c, '年采购额')), val(x, '订单总额($)') && ('买家平台订单额参考 ' + val(x, '订单总额($)'))].filter(Boolean).join(' · ') || '资料不足',
        background: [val(x, '公司名称') || (c && val(c, '公司名称')), c && val(c, '采购类目'), c && val(c, '经营类型')].filter(Boolean).join(' · ') || '资料不足（无公司档案）',
      };
    };
    const aiOfCustomer = (c) => {
      const name = val(c, '公司名称') || val(c, '联系人') || String(c['客户ID']);
      return {
        interaction: lastLine(name),
        behavior: [val(c, '国家/地区'), '等级 ' + custTier(c), val(c, '客户来源') || val(c, '客户分组')].filter(Boolean).join(' · ') || '资料不足',
        value: [val(c, '订单数') && ('客户库订单数 ' + val(c, '订单数')), val(c, '年采购额') && ('年采购额 ' + val(c, '年采购额')), val(c, '潜力评分') && ('潜力分 ' + val(c, '潜力评分'))].filter(Boolean).join(' · ') || '资料不足',
        background: [val(c, '采购类目'), val(c, '经营类型'), val(c, '最近备注') && ('备注 ' + String(val(c, '最近备注')).slice(0, 30))].filter(Boolean).join(' · ') || '资料不足',
      };
    };
    recentInv.filter((x) => {
      const stage = stages[val(x, '询盘ID')] || {};
      if (!['已报价', '样品/规格确认'].includes(stage.stage)) return false;
      const latest = lastChatOf(fmtName(x));
      const latestAt = latest && toDt(val(latest, '发送时间'));
      const stageAt = toDt(stage.at);
      return !(latestAt && stageAt && latestAt >= stageAt && String(val(latest, '角色')).includes('业务员'));
    })
      .sort((a, b) => String((stages[val(a, '询盘ID')] || {}).at || '').localeCompare(String((stages[val(b, '询盘ID')] || {}).at || '')))
      .slice(0, 5).forEach((x) => {
        const s = stages[val(x, '询盘ID')];
        todos.push({ level: 'P0', priorityLabel: '高优先级', key: 'stage:' + val(x, '询盘ID'), owner: val(x, '负责人') || '未分配', due: '今天',
          inquiryId: val(x, '询盘ID'),
          tag: '推进报价/样品', title: fmtName(x) + ' · ' + s.stage + '待确认下一步',
          detail: '请确认客户是否收到报价或样品，并约定一个明确的下一步。' + (s.evidence ? '上次依据：' + s.evidence.slice(0, 60) : ''),
          action: '联系客户确认', url: chatUrl(fmtName(x)), ai: aiOfInquiry(x) });
      });
    staleInv.slice(0, 5).forEach((x) => {
      todos.push({ level: 'P0', priorityLabel: '高优先级', key: IDX ? IDX.uidOfInquiry(x) : fmtName(x), owner: val(x, '负责人') || '未分配', due: '今天',
        inquiryId: val(x, '询盘ID'),
        tag: '询盘待跟进', title: fmtName(x) + ' 的近期询盘待跟进',
        detail: ['最近活动 ' + fmtDT(activityAt(x)), val(x, '国家') || '-', val(x, '询盘主题') || '-'].join(' · '),
        action: '回信息页回复', url: chatUrl(fmtName(x)), ai: aiOfInquiry(x) });
    });
    hotU.slice(0, 5).forEach((x) => {
      todos.push({ level: 'P0', priorityLabel: '高优先级', key: IDX ? IDX.uidOfInquiry(x) : fmtName(x), owner: val(x, '负责人') || '未分配', due: '今天',
        inquiryId: val(x, '询盘ID'),
        tag: '高价值待核实', title: fmtName(x) + '（等级 ' + invGrade(x) + '）的加客状态待核实',
        detail: ['询盘记录显示未加客', '询盘ID ' + (val(x, '询盘ID') || '未知'),
          '询盘时间 ' + fmtDT(toDt(val(x, '创建时间'))), val(x, '国家') || '-'].join(' · '),
        action: '打开询盘核实', url: inquiryUrl(x), ai: aiOfInquiry(x) });
    });
    if (otherUnconv.length) {
      todos.push({ level: 'P1', priorityLabel: '中优先级', key: 'batch', owner: '未分配', due: '本周',
        tag: '批量待核实', title: '还有 ' + otherUnconv.length + ' 条询盘的加客状态待核实',
        detail: '示例：' + otherUnconv.slice(0, 5).map(fmtName).join('、'), action: '去询盘页核实', url: 'https://message.alibaba.com/message/default.htm',
        ai: { interaction: '共 ' + otherUnconv.length + ' 条询盘记录显示未加客', behavior: '按国家/来源分布见「询盘线索」', value: '当前状态待核实', background: '示例：' + otherUnconv.slice(0, 3).map(fmtName).join('、') } });
    }
    riskCust.slice(0, 5).forEach((c) => {
      todos.push({ level: 'P1', priorityLabel: '中优先级', key: IDX ? IDX.uidOfName(val(c, '公司名称') || String(c['客户ID'])) : (val(c, '公司名称') || String(c['客户ID'])), owner: val(c, '负责人') || '未分配', due: '本周',
        tag: '客户流失预警', title: (val(c, '公司名称') || c['客户ID']) + ' 有流失风险',
        detail: [val(c, '国家/地区') || '-', '等级 ' + custTier(c), '最近备注 ' + (val(c, '备注时间') || '-')].join(' · '), action: '去客户页回访', url: CRM_MINE, ai: aiOfCustomer(c) });
    });
    if (pubHot.length) {
      const first = pubHot[0];
      todos.push({ level: 'P1', priorityLabel: '中优先级', key: 'public', owner: '未分配', due: '本周',
        tag: '公海捡漏', title: '公海有 ' + pubHot.length + ' 个高价值买家可领取',
        detail: '含 ' + pubHot.slice(0, 5).map((c) => (val(c, '公司名称') || c['客户ID']) + '(' + custTier(c) + ')').join('、'), action: '去公海领取', url: CRM_PUBLIC,
        ai: { interaction: '公海客户，暂无聊天记录', behavior: [val(first, '国家/地区'), '等级 ' + custTier(first), val(first, '客户来源') || val(first, '客户分组')].filter(Boolean).join(' · ') || '资料不足', value: [val(first, '订单数') && ('客户库订单数 ' + val(first, '订单数')), val(first, '年采购额') && ('年采购额 ' + val(first, '年采购额'))].filter(Boolean).join(' · ') || '资料不足', background: [val(first, '采购类目'), val(first, '经营类型')].filter(Boolean).join(' · ') || '资料不足' } });
    }
    if (!todos.length) todos.push({ level: 'P2', priorityLabel: '低优先级', key: 'none', owner: '-', due: '-', tag: '保持',
      title: '当前资料中没有最近3天新待办', detail: '若平台更新未完成，请先更新；历史客户和询盘可在「客户资产」「询盘线索」查看。', action: '', url: '' });

    const src = top(counter(newInv.map((x) => val(x, '来源') || '-')), 1);
    const converted = newInv.filter((x) => val(x, '是否已加为客户') === '是' || inMine(x)).length;
    const headline = '最近3天新增询盘 ' + newInv.length + ' 条'
      + (src.length ? '，主要来自「' + src[0][0] + '」' : '')
      + '，其中 ' + converted + ' 条已匹配或标记为客户；最近3天活动询盘中有 ' + unconverted.length + ' 条加客状态待核实。';
    return {
      asOf: fmtDT(now),
      headline,
      kpi: [
        ['P0 待办', todos.filter((t) => t.level === 'P0').length, '今天优先处理'],
        ['近3天新增询盘', newInv.length, '按创建时间，含今天'],
        ['高价值待核实', hotU.length, '高价值询盘记录显示未加客，需核实'],
        ['加客状态待核实', unconverted.length, '仅近3天活动询盘，已排除当前我的客户'],
        ['流失预警客户', riskCust.length, '我的客户里标记的流失风险'],
      ],
      identity: IDX ? IDX.stats : null,
      todos,
    };
  }

  // ---------------- 询盘线索 ----------------
  function inquiry(data) {
    const inv = data.inquiry || [];
    const IDX = (typeof self !== 'undefined' && self.AliIdentity) ? self.AliIdentity.build(data) : null;
    const addedStatus = (x) => {
      if (val(x, '是否已加为客户') === '是'
        || !!(IDX && ((IDX.byUid.get(IDX.uidOfInquiry(x)) || {}).mineCount > 0))) return '是';
      return val(x, '是否已加为客户') === '否' ? '否' : '未知';
    };
    const addedOf = (x) => addedStatus(x) === '是';
    const ch = new Map();
    const countries = [];
    const grades = [];
    inv.forEach((x) => {
      const k = val(x, '来源') || '-';
      const d = ch.get(k) || { n: 0, added: 0, hot: 0 };
      d.n++; if (addedOf(x)) d.added++; if (isHotInquiry(x)) d.hot++;
      ch.set(k, d);
      countries.push(val(x, '国家') || '-');
      grades.push(invGrade(x));
    });
    const channel = Array.from(ch.entries())
      .map(([k, v]) => [k, v.n, v.added, Math.round(v.added / Math.max(1, v.n) * 100), v.hot])
      .sort((a, b) => b[1] - a[1]);

    const rows = inv.map((x) => ({
      name: fmtName(x), country: val(x, '国家') || '-', grade: invGrade(x), source: val(x, '来源') || '-',
      created: fmtDT(toDt(val(x, '创建时间'))), added: addedOf(x), addedStatus: addedStatus(x),
      addedEvidence: (() => {
        const f = x.__fields && x.__fields['是否已加为客户'];
        return f ? [f.业务时间 && '业务 ' + f.业务时间, f.采集时间 && '采集 ' + f.采集时间, f.来源]
          .filter(Boolean).join(' · ') : '未记录字段时间';
      })(),
      wait: toNum(val(x, '未联系天数')), resp: (respMinutes(x) === null ? '' : Math.round(respMinutes(x))),
      subject: val(x, '询盘主题') || '-',
    }));
    rows.sort((a, b) => String(b.created).localeCompare(String(a.created)));          // 先新→旧
    rows.sort((a, b) => ((a.addedStatus === '否' ? 0 : a.addedStatus === '未知' ? 1 : 2)
      - (b.addedStatus === '否' ? 0 : b.addedStatus === '未知' ? 1 : 2))
      || ((['A', 'B'].indexOf(a.grade) >= 0 ? 0 : 1) - (['A', 'B'].indexOf(b.grade) >= 0 ? 0 : 1)));

    const added = inv.filter(addedOf).length;
    const hot = inv.filter(isHotInquiry).length;
    const rate = Math.round(added / Math.max(1, inv.length) * 100);
    const stages = data.stages || {};
    const wonIds = new Set((data.order || []).filter((o) => CORE.wonOrder(o))
      .map((o) => val(o, '询盘ID')).filter(Boolean));
    const won = inv.filter((x) => {
      const iid = val(x, '询盘ID');
      const stage = stages[iid];
      return wonIds.has(iid) || (stage && stage.stage === '已成交' && stage.evidence);
    }).length;
    const inquiryIds = new Set(inv.map((x) => val(x, '询盘ID')).filter(Boolean));
    const outcomeKnown = won || Object.entries(stages).some(([id, s]) => inquiryIds.has(id) && ['已流失', '无效询盘'].includes(s.stage) && s.evidence);
    const gmap = counter(grades);
    return {
      headline: '共 ' + inv.length + ' 条询盘，已加为客户 ' + added + ' 条（加客率 ' + rate + '%）；' + (outcomeKnown ? '已核实成交询盘 ' + won + ' 条。' : '成交情况待核实。'),
      kpi: [['询盘总数', inv.length, ''], ['已加为客户', added, '加客率 ' + rate + '%'],
        ['已核实成交询盘', outcomeKnown ? won : '待核实', '需要订单关联或员工核实'], ['高价值询盘', hot, '等级 L3/L4 或 A/B']],
      channel,
      country: top(counter(countries), 10),
      grade: ['L4', 'L3', 'L2', 'L1', 'L0', 'A', 'B', 'C', '-'].filter((g) => gmap.get(g)).map((g) => [g, gmap.get(g)]),
      rows: rows.slice(0, 60),
    };
  }

  // ---------------- 客户资产 ----------------
  function customers(data) {
    const mine = data.customer || [];
    const pub = data.public_customer || [];
    const stat = (rows) => ({
      total: rows.length,
      tiers: TIER_ORDER.map((t) => [t + ' ' + TIER_MEAN[t], rows.filter((c) => custTier(c) === t).length]),
      member: top(counter(rows.map((c) => val(c, '会员等级') || '-'))),
      country: top(counter(rows.map((c) => val(c, '国家/地区') || '-')), 8),
    });
    const brief = (c) => ({
      name: val(c, '公司名称') || c['客户ID'], country: val(c, '国家/地区') || '-', tier: custTier(c),
      member: val(c, '会员等级') || '-', source: val(c, '客户来源') || '-',
      note: val(c, '备注时间') || '-', created: fmtDT(toDt(val(c, '创建时间'))),
    });
    const hot = mine.filter(isHotCustomer);
    const risk = mine.filter((c) => ['y', 'Y', '是'].indexOf(val(c, '流失预警')) >= 0);
    const pubHot = pub.filter(isHotCustomer);
    return {
      headline: '我的客户 ' + mine.length + ' 个（高价值 ' + hot.length + ' 个）；公海 ' + pub.length + ' 个，其中高价值 ' + pubHot.length + ' 个可领取；流失预警 ' + risk.length + ' 个建议本周回访。',
      kpi: [['我的客户', mine.length, '已领取'], ['高价值客户', hot.length, 'L3/L4 · 金牌 · 星标'],
        ['流失预警', risk.length, '建议本周回访'], ['公海可捡', pubHot.length, '高价值待领取']],
      mine: stat(mine), pub: stat(pub),
      hot: hot.slice(0, 40).map(brief), risk: risk.slice(0, 40).map(brief), pubHot: pubHot.slice(0, 40).map(brief),
    };
  }

  // ---------------- 展会通知 ----------------
  // 按国家筛选客户，合并我的客户/公海/询盘，输出可核对的联系人与最近询盘；不自动发送。
  const COUNTRY_ALIASES = {
    portugal: 'portugal', '葡萄牙': 'portugal', pt: 'portugal',
    spain: 'spain', '西班牙': 'spain', es: 'spain',
    germany: 'germany', '德国': 'germany', de: 'germany',
    france: 'france', '法国': 'france', fr: 'france',
    italy: 'italy', '意大利': 'italy', it: 'italy',
    netherlands: 'netherlands', '荷兰': 'netherlands', nl: 'netherlands',
    poland: 'poland', '波兰': 'poland', pl: 'poland',
    unitedkingdom: 'uk', uk: 'uk', greatbritain: 'uk', england: 'uk', '英国': 'uk',
    unitedstates: 'usa', unitedstatesofamerica: 'usa', usa: 'usa', us: 'usa', '美国': 'usa',
    canada: 'canada', '加拿大': 'canada', ca: 'canada',
    mexico: 'mexico', '墨西哥': 'mexico', mx: 'mexico',
    brazil: 'brazil', '巴西': 'brazil', br: 'brazil',
    argentina: 'argentina', '阿根廷': 'argentina', ar: 'argentina',
    chile: 'chile', '智利': 'chile', cl: 'chile',
    peru: 'peru', '秘鲁': 'peru', pe: 'peru',
    colombia: 'colombia', '哥伦比亚': 'colombia', co: 'colombia',
    russia: 'russia', '俄罗斯': 'russia', ru: 'russia',
    turkey: 'turkey', '土耳其': 'turkey', tr: 'turkey',
    uae: 'uae', unitedarabemirates: 'uae', '阿联酋': 'uae', ae: 'uae',
    saudiarabia: 'saudi', '沙特阿拉伯': 'saudi', sa: 'saudi',
    india: 'india', '印度': 'india', 'in': 'india',
    pakistan: 'pakistan', '巴基斯坦': 'pakistan', pk: 'pakistan',
    vietnam: 'vietnam', '越南': 'vietnam', vn: 'vietnam',
    thailand: 'thailand', '泰国': 'thailand', th: 'thailand',
    indonesia: 'indonesia', '印度尼西亚': 'indonesia', id: 'indonesia',
    malaysia: 'malaysia', '马来西亚': 'malaysia', my: 'malaysia',
    japan: 'japan', '日本': 'japan', jp: 'japan',
    southkorea: 'korea', korea: 'korea', '韩国': 'korea', kr: 'korea',
    australia: 'australia', '澳大利亚': 'australia', au: 'australia',
    egypt: 'egypt', '埃及': 'egypt', eg: 'egypt',
    southafrica: 'southafrica', '南非': 'southafrica', za: 'southafrica',
    morocco: 'morocco', '摩洛哥': 'morocco', ma: 'morocco',
    nigeria: 'nigeria', '尼日利亚': 'nigeria', ng: 'nigeria',
    kenya: 'kenya', '肯尼亚': 'kenya', ke: 'kenya',
  };
  const COUNTRY_LABELS = {
    portugal: '葡萄牙 / Portugal', spain: '西班牙 / Spain', germany: '德国 / Germany',
    france: '法国 / France', italy: '意大利 / Italy', netherlands: '荷兰 / Netherlands',
    poland: '波兰 / Poland', uk: '英国 / United Kingdom', usa: '美国 / United States',
    canada: '加拿大 / Canada', mexico: '墨西哥 / Mexico', brazil: '巴西 / Brazil',
    argentina: '阿根廷 / Argentina', chile: '智利 / Chile', peru: '秘鲁 / Peru',
    colombia: '哥伦比亚 / Colombia', russia: '俄罗斯 / Russia', turkey: '土耳其 / Turkey',
    uae: '阿联酋 / UAE', saudi: '沙特阿拉伯 / Saudi Arabia', india: '印度 / India',
    pakistan: '巴基斯坦 / Pakistan', vietnam: '越南 / Vietnam', thailand: '泰国 / Thailand',
    indonesia: '印度尼西亚 / Indonesia', malaysia: '马来西亚 / Malaysia', japan: '日本 / Japan',
    korea: '韩国 / South Korea', australia: '澳大利亚 / Australia', egypt: '埃及 / Egypt',
    southafrica: '南非 / South Africa', morocco: '摩洛哥 / Morocco', nigeria: '尼日利亚 / Nigeria',
    kenya: '肯尼亚 / Kenya',
  };
  const countryKeyOf = (raw) => {
    const s = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!s || s === '-') return '';
    const n = s.toLowerCase().replace(/[\s\u3000._\-()（）]+/g, '');
    return COUNTRY_ALIASES[n] || n;
  };
  const countryLabelOf = (raw, key) => {
    if (!key) return '未填写';
    return COUNTRY_LABELS[key] || String(raw === undefined || raw === null ? '' : raw).trim();
  };

  function exhibition(data, country, opts) {
    const o = opts || {};
    const inv = data.inquiry || [];
    const mine = data.customer || [];
    const pub = data.public_customer || [];
    const ID = identityApi();
    const IDX = o.idx || (ID && ID.build ? ID.build(data) : null);
    if (!IDX) {
      return { country: '', countries: [], totalProfiles: 0, missingCountry: 0, matched: 0,
        withEmail: 0, withPhone: 0, hotCount: 0, rows: [], truncated: false };
    }
    const wanted = countryKeyOf(country);

    const latestInv = new Map();
    inv.forEach((x) => {
      const uid = IDX.uidOfInquiry(x);
      if (!uid) return;
      const at = toDt(val(x, '创建时间'));
      const saved = latestInv.get(uid);
      if (!saved || (at && (!saved.at || at > saved.at))) latestInv.set(uid, { row: x, at });
    });
    const mineByUid = new Map();
    mine.forEach((r) => {
      const uid = IDX.uidOfCustomer(r);
      if (uid && !mineByUid.has(uid)) mineByUid.set(uid, r);
    });
    const pubByUid = new Map();
    pub.forEach((r) => {
      const uid = IDX.uidOfCustomer(r);
      if (uid && !pubByUid.has(uid)) pubByUid.set(uid, r);
    });

    const countryCount = new Map();
    let missingCountry = 0;
    IDX.profiles.forEach((p) => {
      const key = countryKeyOf(p.country);
      if (!key) { missingCountry += 1; return; }
      const saved = countryCount.get(key);
      if (saved) saved.count += 1;
      else countryCount.set(key, { key, label: countryLabelOf(p.country, key), count: 1 });
    });
    const countries = Array.from(countryCount.values())
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    if (o.countriesOnly) {
      return {
        country: wanted ? countryLabelOf(country, wanted) : '全部国家',
        countries: countries,
        totalProfiles: IDX.profiles.length,
        missingCountry: missingCountry,
        matched: 0, withEmail: 0, withPhone: 0, hotCount: 0,
        rows: [], truncated: false,
      };
    }

    const rows = [];
    IDX.profiles.forEach((p) => {
      const mineRow = mineByUid.get(p.uid) || null;
      const pubRow = pubByUid.get(p.uid) || null;
      const invHit = latestInv.get(p.uid) || null;
      const invRow = invHit ? invHit.row : null;
      const contacts = [mineRow, pubRow, invRow].filter(Boolean);
      const pickField = (keys) => {
        for (const row of contacts) {
          for (const k of keys) {
            const v = val(row, k);
            if (v) return v;
          }
        }
        return '';
      };
      const countryRaw = p.country || (mineRow && val(mineRow, '国家/地区'))
        || (pubRow && val(pubRow, '国家/地区')) || (invRow && val(invRow, '国家')) || '';
      const key = countryKeyOf(countryRaw);
      if (wanted && key !== wanted) return;
      if (o.mineOnly && !p.mineCount) return;

      const email = pickField(['邮箱', '电子邮件']);
      const phone = pickField(['手机', '电话', '联系电话']);
      const contactName = pickField(['联系人', '客户名称']);
      const company = p.company || pickField(['公司名称']);
      const login = pickField(['登录名', '客户登录名', 'AliID', '旺旺']);
      const crmTier = (mineRow && custTier(mineRow)) || (pubRow && custTier(pubRow)) || '';
      const tier = crmTier && crmTier !== '-' ? crmTier : (invRow ? invGrade(invRow) : '-');
      const hot = !!((mineRow && isHotCustomer(mineRow)) || (pubRow && isHotCustomer(pubRow))
        || (invRow && isHotInquiry(invRow)));
      if (o.hotOnly && !hot) return;
      if (o.contactOnly && !email && !phone) return;

      const sources = [];
      if (p.mineCount) sources.push('我的客户');
      if (p.publicCount) sources.push('公海');
      if (p.inquiryIds.length) sources.push('询盘');
      rows.push({
        uid: p.uid,
        name: contactName || p.display || '未命名客户',
        company: company || '',
        country: countryLabelOf(countryRaw, key),
        countryKey: key,
        tier: tier || '-',
        member: (mineRow && val(mineRow, '会员等级')) || (pubRow && val(pubRow, '会员等级')) || '-',
        sources: sources.join(' + ') || '客户',
        email: email,
        phone: phone,
        login: login,
        inquiryId: invRow ? val(invRow, '询盘ID') : '',
        inquiryAt: invRow ? fmtDT(toDt(val(invRow, '创建时间'))) : '',
        subject: invRow ? val(invRow, '询盘主题') : '',
        product: invRow ? val(invRow, '咨询产品') : '',
        owner: invRow ? val(invRow, '负责人') : '',
        inquiryCount: p.inquiryIds.length,
        customerId: p.customerIds[0] || '',
        hot: hot,
        risk: mineRow ? ['y', 'Y', '是'].indexOf(val(mineRow, '流失预警')) >= 0 : false,
      });
    });

    rows.sort((a, b) => (b.hot ? 1 : 0) - (a.hot ? 1 : 0)
      || String(b.inquiryAt).localeCompare(String(a.inquiryAt))
      || String(a.name).localeCompare(String(b.name)));
    const limit = Math.max(0, Number(o.limit) || 0);
    return {
      country: wanted ? countryLabelOf(country, wanted) : '全部国家',
      countries: countries,
      totalProfiles: IDX.profiles.length,
      missingCountry: missingCountry,
      matched: rows.length,
      withEmail: rows.filter((r) => r.email).length,
      withPhone: rows.filter((r) => r.phone).length,
      hotCount: rows.filter((r) => r.hot).length,
      rows: limit ? rows.slice(0, limit) : rows,
      truncated: limit ? rows.length > limit : false,
    };
  }

  // ---------------- 需求词库 ----------------
  function demand(data) {
    const vis = data.visitor || [];
    const visitorState = vis.length ? 'data' : data.visitorSnapshot ? 'empty' : 'missing';
    const terms = new Map();
    const visitors = new Set();
    const withTermsVisitors = new Set();
    vis.forEach((v, i) => {
      const visitorId = val(v, '访客ID') || 'row:' + i;
      visitors.add(visitorId);
      let hit = false;
      splitTerms(val(v, '进店来源词')).concat(splitTerms(val(v, '搜索关键词'))).forEach((w) => {
        terms.set(w, (terms.get(w) || 0) + 1); hit = true;
      });
      if (hit) withTermsVisitors.add(visitorId);
    });
    const withTerms = withTermsVisitors.size;
    const chat = new Map(); const inq = new Map();
    keywordCorpus(data).forEach(({ w, src }) => {
      const m = src === '询盘' ? inq : chat;
      m.set(w, (m.get(w) || 0) + 1);
    });
    const merged = new Map(chat);
    inq.forEach((v, k) => merged.set(k, (merged.get(k) || 0) + v));
    const mergedTop = top(merged, 5).map(([w]) => w).join('、');
    const visitorText = visitorState === 'missing' ? '访客资料尚未入库，无法判断真实搜索词'
      : visitorState === 'empty' ? '访客资料已同步，资料库目前没有访客记录'
        : withTerms ? '访客里有 ' + withTerms + ' 人留下了真实搜索词（共 ' + terms.size + ' 个不同词）'
          : '已入库 ' + visitors.size + ' 位访客，但搜索词字段均为空';
    return {
      headline: visitorText + '；询盘+聊天高频词 Top5：' + (mergedTop || '-') + '。',
      visitorState,
      visitorLastImportAt: data.visitorLastImportAt || '',
      kpi: [['访客数', visitorState === 'missing' ? '未入库' : visitors.size, '资料库去重'],
        ['有搜索词的访客', visitorState === 'missing' ? '未知' : withTerms, '仅访客原始词'],
        ['RFQ 合计', visitorState === 'missing' ? '未知' : vis.reduce((s, v) => s + toNum(val(v, 'RFQ数')), 0), '访客发起'],
        ['去重搜索词', visitorState === 'missing' ? '未知' : terms.size, '买家原话']],
      searchTerms: top(terms, 40),
      inquiryWords: top(inq, 25),
      chatWords: top(chat, 25),
    };
  }

  // ---------------- 复盘报表 ----------------
  function report(data) {
    const inv = data.inquiry || [];
    const chats = data.chat || [];
    const orders = data.order || [];
    const sections = [];
    const m2 = (x) => (x === null || x === undefined || isNaN(x) ? '' : Math.round(x * 10) / 10);

    if (orders.length) {
      const confirmed = orders.filter(CORE.wonOrder);
      const amounts = new Map();
      confirmed.forEach((o) => {
        const n = CORE.amount(o['成交金额']);
        if (n === null) return;
        const currency = val(o, '币种') || '未标注币种';
        amounts.set(currency, (amounts.get(currency) || 0) + n);
      });
      sections.push({ name: '订单_已核实结果', header: ['指标', '数值'], rows: [
        ['导入订单数', orders.length],
        ['已付款或完成订单数', confirmed.length],
        ['与询盘 ID 关联的已确认订单', confirmed.filter((o) => val(o, '询盘ID')).length],
        ...Array.from(amounts, ([currency, n]) => ['已确认成交金额 · ' + currency, Math.round(n * 100) / 100]),
        ['口径', '仅对已付款或完成状态的订单按币种求和；未标币种单列，退款及部分支付需人工复核'],
      ] });
      sections.push({ name: '订单_状态分布', header: ['状态', '订单数'], rows: top(counter(orders.map((o) => val(o, '订单状态') || '未标注'))) });
    }

    const stageIds = new Set(inv.map((x) => val(x, '询盘ID')).filter(Boolean));
    const stageRows = Object.entries(data.stages || {}).filter(([id]) => stageIds.has(id));
    if (stageRows.length) sections.push({ name: '询盘_员工确认阶段', header: ['阶段', '询盘数'],
      rows: top(counter(stageRows.map(([, s]) => s.stage || '待核实'))) });

    if (inv.length) {
      const resp = []; const owners = new Map();
      inv.forEach((x) => {
        const r = respMinutes(x); if (r !== null) resp.push(r);
        const o = val(x, '负责人') || '-';
        const d = owners.get(o) || { n: 0, resp: [], added: 0, pending: 0 };
        d.n++; if (r !== null) d.resp.push(r);
        if (val(x, '是否已加为客户') === '是') d.added++;
        if (toNum(val(x, '未联系天数')) > 0) d.pending++;
        owners.set(o, d);
      });
      const pending = inv.filter((x) => toNum(val(x, '未联系天数')) > 0)
        .sort((a, b) => toNum(val(b, '未联系天数')) - toNum(val(a, '未联系天数')));
      const times = inv.map((x) => toDt(val(x, '创建时间'))).filter(Boolean).sort((a, b) => a - b);
      sections.push({ name: '询盘_总览', header: ['指标', '数值'], rows: [
        ['询盘总数', inv.length],
        ['独立客户数', new Set(inv.map((x) => val(x, '客户名称')).filter(Boolean)).size],
        ['已加为客户', inv.filter((x) => val(x, '是否已加为客户') === '是').length],
        ['金牌买家', inv.filter((x) => val(x, '金牌买家') === '是').length],
        ['订单总额($)合计', '不适用：该字段可能为买家累计金额，不可逐询盘相加'],
        ['平均响应时长(分钟)', resp.length ? m2(resp.reduce((a, b) => a + b, 0) / resp.length) : ''],
        ['待跟进(未联系>0天)', pending.length],
        ['最早询盘', times.length ? fmtDT(times[0], true) : ''],
        ['最新询盘', times.length ? fmtDT(times[times.length - 1], true) : ''],
      ] });
      sections.push({ name: '询盘_国家分布', header: ['国家', '数量'], rows: top(counter(inv.map((x) => val(x, '国家') || '-'))) });
      sections.push({ name: '询盘_来源分布', header: ['来源', '数量'], rows: top(counter(inv.map((x) => val(x, '来源') || '-'))) });
      sections.push({ name: '询盘_来源端', header: ['来源端', '数量'], rows: top(counter(inv.map((x) => val(x, '来源端') || '-'))) });
      sections.push({ name: '询盘_回复状态', header: ['回复状态', '数量'], rows: top(counter(inv.map((x) => val(x, '回复状态') || '-'))) });
      sections.push({ name: '询盘_负责人', header: ['负责人', '询盘数', '平均响应(分钟)', '加为客户数', '待跟进数'],
        rows: Array.from(owners.entries()).sort((a, b) => b[1].n - a[1].n)
          .map(([o, d]) => [o, d.n, d.resp.length ? m2(d.resp.reduce((a, b) => a + b, 0) / d.resp.length) : '', d.added, d.pending]) });
      sections.push({ name: '询盘_待跟进', header: ['未联系天数', '客户名称', '国家', '负责人', '回复状态', '创建时间', '询盘ID'],
        rows: pending.map((x) => [toNum(val(x, '未联系天数')), val(x, '客户名称'), val(x, '国家'), val(x, '负责人'), val(x, '回复状态'), fmtDT(toDt(val(x, '创建时间'))), val(x, '询盘ID')]) });
    }

    if (chats.length) {
      const seller = chats.filter((m) => String(val(m, '角色')).indexOf('业务员') >= 0).length;
      const hours = counter(chats.map((m) => { const d = toDt(val(m, '发送时间')); return d ? d.getHours() : null; }).filter((h) => h !== null));
      const sessions = new Map();
      chats.forEach((m) => {
        const k = val(m, '会话') || val(m, '__file__') || '-';
        if (!sessions.has(k)) sessions.set(k, []);
        sessions.get(k).push(m);
      });
      const sessRows = Array.from(sessions.entries()).map(([name, ms]) => {
        ms.sort((a, b) => (toDt(val(a, '发送时间')) || 0) - (toDt(val(b, '发送时间')) || 0));
        const buyer = ms.find((m) => String(val(m, '角色')).indexOf('业务员') < 0);
        let fr = '';
        if (buyer) {
          const bt = toDt(val(buyer, '发送时间'));
          const nxt = ms.find((m) => String(val(m, '角色')).indexOf('业务员') >= 0 && toDt(val(m, '发送时间')) >= bt);
          if (nxt) fr = Math.round((toDt(val(nxt, '发送时间')) - bt) / 600) / 100;
        }
        return [name, ms.length,
          ms.filter((m) => String(val(m, '角色')).indexOf('业务员') >= 0).length,
          ms.filter((m) => String(val(m, '角色')).indexOf('业务员') < 0).length,
          fr, fmtDT(toDt(val(ms[0], '发送时间')), true), fmtDT(toDt(val(ms[ms.length - 1], '发送时间')), true)];
      }).sort((a, b) => b[1] - a[1]);
      const words = new Map();
      chats.forEach((m) => {
        if (String(val(m, '角色')).indexOf('业务员') >= 0) return;
        const c = val(m, '内容');
        if (isSystemPayload(c) || SYS_NOTICE.some((t) => String(c).indexOf(t) >= 0)) return;
        extractWords(c).forEach((w) => words.set(w, (words.get(w) || 0) + 1));
      });
      sections.push({ name: '聊天_总览', header: ['指标', '数值'], rows: [
        ['会话数', sessions.size], ['消息总数', chats.length], ['业务员消息', seller], ['客户消息', chats.length - seller],
        ['业务员消息占比', (seller / Math.max(1, chats.length) * 100).toFixed(1) + '%'],
      ] });
      sections.push({ name: '聊天_会话明细', header: ['会话', '消息数', '业务员消息', '客户消息', '首响(分钟)', '开始时间', '最后时间'], rows: sessRows });
      sections.push({ name: '聊天_活跃时段', header: ['小时', '消息数'], rows: Array.from({ length: 24 }, (_, h) => [h, hours.get(h) || 0]) });
      sections.push({ name: '聊天_高频词(客户侧)', header: ['词', '次数'], rows: top(words, 30) });
    }
    return { sections, generatedAt: fmtDT(new Date(), true) };
  }

  // ---------------- 经营总览 ----------------
  // 只汇总本机已导入的六类资料；成交额按币种分开累计，订单数不等于询盘去重数。
  function storeOverview(data, at) {
    const inv = data.inquiry || [];
    const orders = data.order || [];
    const mine = data.customer || [];
    const pub = data.public_customer || [];
    const visitors = data.visitor || [];
    const now = at ? new Date(at) : new Date();
    const m2 = (x) => (x === null || x === undefined || isNaN(x) ? null : Math.round(x * 10) / 10);
    const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
    const after = (v, days) => {
      const d = toDt(v);
      if (!d || d > now) return false;
      return d.getTime() >= now.getTime() - days * 86400000;
    };
    const isReplied = (x) => {
      const s = val(x, '回复状态');
      if (!s) return !!val(x, '最新回复时间');
      return s.indexOf('已回复') >= 0 || s === '1';
    };
    const inv30 = inv.filter((x) => after(val(x, '创建时间'), 30));
    const repliedInv = inv.filter(isReplied);
    const addedInv = inv.filter((x) => val(x, '是否已加为客户') === '是');
    const pending = inv.filter((x) => toNum(val(x, '未联系天数')) > 0);
    const confirmed = orders.filter(CORE.wonOrder);

    const amounts = new Map();
    confirmed.forEach((o) => {
      const n = CORE.amount(o['成交金额']);
      if (n === null) return;
      const currency = val(o, '币种') || '未标注币种';
      amounts.set(currency, (amounts.get(currency) || 0) + n);
    });
    const gmv = Array.from(amounts, ([currency, n]) => ({ currency, amount: Math.round(n * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount);
    const gmvText = gmv.length
      ? gmv.map((x) => (x.currency === '未标注币种' ? '' : x.currency + ' ')
        + x.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })).join(' / ')
      : '0';

    const resp = inv.map((x) => respMinutes(x)).filter((n) => n !== null);
    const avgResp = resp.length ? m2(resp.reduce((a, b) => a + b, 0) / resp.length) : null;
    const visitorIds = new Set(visitors.map((v) => val(v, '访客ID')).filter(Boolean));
    const visitorTotal = visitorIds.size || visitors.length;
    const visitorWithTerms = visitors.filter((v) => val(v, '搜索关键词') || val(v, '进店来源词')).length;
    const visitorValue = (visitors.length || data.visitorSnapshot) ? visitorTotal : '未入库';

    const kpis = [
      ['近30天询盘', inv30.length, '创建时间在近30天；全部已导入 ' + inv.length + ' 条'],
      ['平台回复率', pct(repliedInv.length, inv.length) === null ? '暂无' : pct(repliedInv.length, inv.length) + '%',
        '回复状态=已回复 ' + repliedInv.length + '/' + inv.length],
      ['已加客户', addedInv.length, '占询盘 ' + (pct(addedInv.length, inv.length) === null ? '—' : pct(addedInv.length, inv.length) + '%')],
      ['已确认订单', confirmed.length, '已付款/已完成；全部订单 ' + orders.length + ' 笔'],
      ['已确认成交额', gmvText, '按币种分开累计，不跨币种相加'],
      ['平均响应', avgResp === null ? '暂无' : avgResp + ' 分钟', '创建时间→最新回复时间；' + resp.length + ' 条有完整时间'],
      ['我的客户', mine.length, '公海客户 ' + pub.length],
      ['待跟进', pending.length, '未联系天数>0，需按今日待办核实'],
      ['访客数', visitorValue, visitors.length ? '本机访客快照；有搜索词 ' + visitorWithTerms + ' 人' : '访客资料未入库或为空'],
    ];

    const funnel = [
      { key: 'inquiry', label: '询盘', count: inv.length, rate: inv.length ? 100 : null, hint: '本机已导入询盘' },
      { key: 'replied', label: '已回复', count: repliedInv.length, rate: pct(repliedInv.length, inv.length), hint: '平台回复状态=已回复' },
      { key: 'added', label: '已加客户', count: addedInv.length, rate: pct(addedInv.length, inv.length), hint: '询盘「是否已加为客户=是」' },
      { key: 'order', label: '已确认订单', count: confirmed.length, rate: pct(confirmed.length, inv.length), hint: '订单数，非询盘去重' },
    ];

    const trend = [];
    const monthKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1);
    for (let i = 5; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      trend.push({ month: monthKey(start), label: (start.getMonth() + 1) + '月', inquiries: 0, orders: 0 });
    }
    const trendIndex = new Map(trend.map((t, i) => [t.month, i]));
    inv.forEach((x) => {
      const d = toDt(val(x, '创建时间'));
      if (!d) return;
      const i = trendIndex.get(monthKey(d));
      if (i !== undefined) trend[i].inquiries++;
    });
    confirmed.forEach((o) => {
      const d = toDt(val(o, '下单时间') || val(o, '创建时间'));
      if (!d) return;
      const i = trendIndex.get(monthKey(d));
      if (i !== undefined) trend[i].orders++;
    });

    const shareRows = (list, n) => top(counter(list), n).map(([name, count]) => ({
      name, count, rate: pct(count, list.length),
    }));
    const countries = shareRows(inv.map((x) => val(x, '国家') || '-'), 6);
    const sources = shareRows(inv.map((x) => val(x, '来源') || '-'), 6);

    const quality = [];
    const addGap = (id, label, count, total, level, hint) => {
      if (count > 0) quality.push({ id, label, count, total, level, hint });
    };
    addGap('name', '询盘缺客户名', inv.filter((x) => !val(x, '客户名称')).length, inv.length, 'high',
      '无法在聊天与订单中稳定匹配客户，影响身份聚合');
    addGap('order-link', '订单未关联询盘', orders.filter((o) => !val(o, '询盘ID')).length, orders.length, 'high',
      '影响成交归因、投流回收与客户 LTV 判断');
    addGap('grade', '买家等级缺失', inv.filter((x) => !val(x, '买家等级')).length, inv.length, 'mid',
      '影响高价值询盘识别与跟进优先级');
    addGap('company', '公司名缺失', inv.filter((x) => !val(x, '公司名称')).length, inv.length, 'low',
      '影响客户去重与背景核实');
    addGap('visitor-terms', '访客缺搜索词', visitors.filter((v) => !val(v, '搜索关键词') && !val(v, '进店来源词')).length, visitors.length, 'low',
      '无法还原买家真实搜索需求');
    const LEVEL_ORDER = { high: 0, mid: 1, low: 2 };
    quality.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.count - a.count);

    const headlineParts = ['近30天新增询盘 ' + inv30.length + ' 条',
      '平台回复率 ' + (pct(repliedInv.length, inv.length) === null ? '暂无' : pct(repliedInv.length, inv.length) + '%'),
      '已加客户 ' + addedInv.length + ' 条',
      '已确认订单 ' + confirmed.length + ' 笔'];
    if (gmv.length) headlineParts.push('确认成交额 ' + gmvText);
    const topGaps = quality.filter((q) => q.level !== 'low').slice(0, 2).map((q) => q.label + ' ' + q.count);
    headlineParts.push(topGaps.length ? '优先补 ' + topGaps.join('、') : '主要资料缺口暂不明显');

    return {
      headline: headlineParts.join('；') + '。',
      kpis, funnel, trend, countries, sources, quality, gmv,
      generatedAt: fmtDT(new Date(), true),
    };
  }

  const api = { val, toNum, toDt, fmtDT, fmtName, invGrade, custTier, isHotInquiry, isHotCustomer,
    extractWords, splitTerms, keywordCorpus, home, inquiry, customers, exhibition, demand, report, storeOverview,
    TIER_ORDER, TIER_MEAN };

  if (typeof self !== 'undefined') self.AliAnalyze = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
