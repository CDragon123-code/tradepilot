// 内容脚本：在本人国际站页面注入导出面板
// 依据阿里页面自身接口（询盘 subjectList.htm；聊天 onetalk messageManager 系列），独立实现，不参考任何闭源插件代码。
(function () {
  'use strict';
  const VERSION = '1.0.0';
  console.log('[ali-export-ext] v' + VERSION + ' loaded on', location.href, 'top=', window.self === window.top);

  const API = {
    inquiryList: 'https://message.alibaba.com/message/ajax/feedback/subjectList.htm',
    // 客户信息补全链路（v0.2）：询盘摘要 → 详情页取 token → CRM 客户信息
    querySummary: 'https://message.alibaba.com/message/ajax/feedback/querySummary.htm',
    maDetail: 'https://message.alibaba.com/message/maDetail.htm',
    customerInfo: 'https://alicrm.alibaba.com/jsonp/customerPluginQueryServiceI/queryCustomerInfo.json',
    origin: 'https://message.alibaba.com',
    referer: 'https://message.alibaba.com/message/default.htm',
  };
  const PAGE_SIZE = 20; // 平台默认 20（UI 仅 20/50）
  const THROTTLE_MS = 400;     // 请求基础间隔
  const THROTTLE_JITTER = 700; // 随机抖动上限：避免固定节奏（降低被判定为脚本/爬虫的风险）

  // 买家画像列（全部来自补全接口的 buyerInfo / alicrmCustomerInfo，**零额外请求**）
  // [buyerInfo 字段, 中文列名, 取值方式]；__growthLevel 表示取 growthLevelInfo.growthLevel
  const BIZ_COLS = [
    ['businessTypes', '经营类型', 'arr'],
    ['salesTypes', '销售类型', 'arr'],
    ['preferredIndustries', '采购偏好', 'arr'],
    ['searchWords', '搜索词', 'arr'],
    ['companyWebSite', '公司网站', 'web'],
    ['loginDays', '活跃天数', 'num'],
    ['validInquiryCount', '有效询盘数', 'num'],
    ['repliedInquiryCount', '已回复询盘数', 'num'],
    ['productViewCount', '产品浏览数', 'num'],
    ['tradeSupplierCount', '合作供应商数', 'num'],
    ['potentialScore', '潜力分', 'num'],
    ['__growthLevel', '成长等级', 'lvl'],
    ['addedToBlacklistCount', '被拉黑次数', 'num'],
    ['spamInquiryMarkedBySupplierCount', '被标记垃圾询盘数', 'num'],
  ];
  const INQUIRY_HEADERS = [
    '询盘ID', '询价次数', '创建时间', '客户名称', '负责人', '公司名称', '是否已加为客户',
    '买家等级', '金牌买家', '联系电话', '电子邮件', '注册时间', '订单总额($)', '购买总金额',
    '国家', '来源', '来源端', '回复状态', '最新回复时间', '未联系天数', '处理进度',
    '询盘主题', '产品ID', '咨询产品',
    '买家等级(字母)',
  ].concat(BIZ_COLS.map((c) => c[1]));
  // 列 → 接口字段候选（真实字段名以接口实测为准）
  const INQUIRY_FIELDS = [
    ['tradeId'],                          // 询盘ID
    ['inquiryCount'],                     // 询价次数
    ['createTime'],                       // 创建时间
    ['senderName', 'buyerName', 'name'],  // 客户名称
    ['ownerName'],                        // 负责人
    ['companyName'],                      // 公司名称（需客户接口，列表无）
    ['isAddedCustomer'],                  // 是否已加为客户（需客户接口）
    ['highQualityLevelTag', 'levelTag'],  // 买家等级（需客户接口）
    ['isGoldBuyer'],                      // 金牌买家
    ['mobileNumber', 'phoneNumber'],      // 联系电话（需客户接口）
    ['email'],                            // 电子邮件（需客户接口）
    ['registerDate'],                     // 注册时间（需客户接口）
    ['totalOrderVolume'],                 // 订单总额($)（需客户接口）
    ['totalOrderCount'],                  // 购买总金额
    ['country'],                          // 国家（需客户接口）
    ['source'],                           // 来源
    ['appFrom'],                          // 来源端
    ['replyStatus'],                      // 回复状态
    ['lastestReplyTime'],                 // 最新回复时间
    ['waitDay'],                          // 未联系天数
    ['process', 'mark'],                  // 处理进度
    ['subject'],                          // 询盘主题
    ['productId'],                        // 产品ID
    ['productName'],                      // 咨询产品
    ['__levelLetter'],                    // 买家等级(字母)：由 enrichRow/applyCrmLevels 回填，接口无此字段
  ].concat(BIZ_COLS.map((c) => ['__biz_' + c[0]])); // 买家画像列：enrichRow 用 buyerInfo 回填
  const CHAT_HEADERS = ['发送时间', '角色', '发言人', '内容', '会话'];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 请求节流：基础间隔 + 随机抖动，模拟人工点击的不规则节奏
  const pace = () => sleep(THROTTLE_MS + Math.floor(Math.random() * THROTTLE_JITTER));
  const getCookie = (n) => {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  };
  const pick = (obj, keys) => {
    if (!obj) return '';
    for (const k of keys) {
      const v = obj[k];
      if (v !== undefined && v !== null && v !== '' && v !== '-') return v;
    }
    return '';
  };
  const fmtDate = (v, sep) => {
    sep = sep || '/';
    if (v === '' || v === undefined || v === null) return '';
    if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) {
      const n = Number(v);
      const d = new Date(String(v).length === 13 ? n : n * 1000);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}${sep}${p(d.getMonth() + 1)}${sep}${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
    return String(v);
  };
  const toTs = (s, endOfDay) => (s ? new Date(s + (endOfDay ? 'T23:59:59' : 'T00:00:00')).getTime() : 0);
  // 本地化映射（原始码→中文；未知码保留原值）
  // 来源端：实测原始值有 `iOS_A_26.32.0_263200` / `android` / `camel-component` / `web_weblite` 等
  const appFromToCn = (v) => {
    if (!v) return '';
    const s = String(v), l = s.toLowerCase();
    if (/^ios|iphone|ipad/.test(l)) return 'iOS端';
    if (/android/.test(l)) return '安卓端';
    if (/weblite|wap/.test(l)) return '手机网页版';
    if (/web|pc|camel/.test(l)) return '电脑端';
    return s;
  };
  // 回复状态：实测原始值为数字码（本批全 `1`）；1=已回复，0=待回复
  const REPLY_STATUS_MAP = { 0: '待回复', 1: '已回复' };
  const replyStatusCn = (v) => (v === '' || v === undefined || v === null ? '' : (REPLY_STATUS_MAP[String(v)] || String(v)));
  // 来源：实测原始码（映射项参考人工样本的中文口径，未知码保留原码）
  const SOURCE_MAP = {
    main_app_detail_sendInquiry: 'APP端详情页商机',
    main_app_miniDetail_sendInquiry: 'APP mini端详情商机',
    main_en_detail: '电脑端英文详情页',
    CONTACT_MKT_IMOpportunity: '营销商机',
  };
  const sourceCn = (v) => (v ? (SOURCE_MAP[String(v)] || String(v)) : '');
  // ctoken 不是独立 cookie：藏在 xman_us_t 等 cookie 的值里，需对整串扫描
  const getCtoken = () => {
    const m = document.cookie.match(/ctoken=([^&;]*)/);
    return m && m[1] ? decodeURIComponent(m[1]) : '';
  };
  const tokens = () => ({
    ctoken: getCtoken(),
    csrf: getCookie('XSRF-TOKEN'),
    tb: getCookie('_tb_token_'),
    xsrf: getCookie('XSRF-TOKEN'),
  });

  // 解析响应：兼容 JSON / HTML 实体转义（可能多层）/ 控制字符 / 前后杂字符 / JSONP
  function htmlUnescape(s) {
    return s.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  function decodeEntities(s) {
    try { const ta = document.createElement('textarea'); ta.innerHTML = s; return ta.value; }
    catch (e) { return htmlUnescape(s); }
  }
  const stripCtl = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  function tryParse(s) {
    try { return { ok: true, v: JSON.parse(s) }; } catch (e) { /* 继续 */ }
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i > -1 && j > i) { try { return { ok: true, v: JSON.parse(s.slice(i, j + 1)) }; } catch (e) { /* 继续 */ } }
    return { ok: false };
  }
  function parseMaybe(text) {
    const t = String(text).replace(/^\uFEFF/, '').trim();
    const cands = [t, htmlUnescape(t)];
    let d = t;
    for (let i = 0; i < 3; i++) { d = decodeEntities(d); cands.push(d); }
    cands.push(htmlUnescape(htmlUnescape(t)), stripCtl(t), stripCtl(htmlUnescape(t)), stripCtl(decodeEntities(t)));
    for (const c of cands) {
      let r = tryParse(c); if (r.ok) return r.v;
      r = tryParse(stripCtl(c)); if (r.ok) return r.v;
    }
    const m = t.match(/^[^({]*\((.*)\)\s*;?\s*$/s);
    if (m) { const r = tryParse(m[1]); if (r.ok) return r.v; }
    throw new Error('无法解析响应(len=' + t.length + '): ' + t.slice(0, 140));
  }

  // 取原始文本（供请求与解析共用）
  async function fetchRaw(url, method, headers, body) {
    try {
      const r = await fetch(url, { method, headers, body, credentials: 'include' });
      const text = await r.text();
      if (text) return text;
      throw new Error('空响应');
    } catch (e) {
      const res = await chrome.runtime.sendMessage({ type: 'proxyFetch', url, method, headers, body }).catch(() => null);
      if (!res) throw new Error('直连失败且后台代理不可用: ' + e.message);
      if (res.ok === false && res.text == null) throw new Error(res.error || e.message);
      if (!res.text) throw new Error('代理空响应');
      return res.text;
    }
  }

  async function request(url, method, headers, body) {
    return parseMaybe(await fetchRaw(url, method, headers, body));
  }

  // 询盘类接口通用请求头（列表 / querySummary 共用）
  const inquiryHeaders = (t) => ({
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest', 'Referer': API.referer, 'Origin': API.origin, 'X-XSRF-TOKEN': t.xsrf,
  });

  async function fetchInquiryPage(page, startDate, endDate) {
    const t = tokens();
    const search = {};
    let adv = false;
    if (startDate) { search.startTime = String(toTs(startDate, false)); adv = true; }
    if (endDate) { search.endTime = String(toTs(endDate, true)); adv = true; }
    const paramsJson = {
      system: 'feedback', listType: 'all', pageSize: PAGE_SIZE,
      pagination: { nextPage: page, pageSize: PAGE_SIZE },
      filter: { isShowAtm: false },
      order: { order: 'desc', orderBy: 'latest_contact_time' },
      search,
    };
    if (adv) paramsJson.isAdvanceSearch = 'true';
    const qs = new URLSearchParams({ ctoken: t.ctoken, _tb_token_: t.tb });
    const body = new URLSearchParams({ _csrf_token_: t.csrf, postId: '', params: JSON.stringify(paramsJson) });
    const res = await request(`${API.inquiryList}?${qs}`, 'POST', inquiryHeaders(t), body.toString());
    const d = res.data || {};
    let list = d.list || d.dataList || d.result || d.records || [];
    // 平台的 data.list 为「数组的数组」（按分组），需展平一层
    if (Array.isArray(list) && list.length && Array.isArray(list[0])) list = [].concat(...list);
    return { list, total: (d.pagination && d.pagination.totalCount) || d.total || d.totalCount || 0 };
  }

  // ---------------- 客户信息补全（v0.2） ----------------
  // 列索引（对应 INQUIRY_HEADERS）
  const COL = { customerName: 3, company: 5, addedCustomer: 6, level: 7, golden: 8, phone: 9, email: 10, regDate: 11, orderAmount: 12, purchaseAmount: 13, country: 14, levelLetter: 24, biz: 25 };
  const isEmptyCol = (v) => v === '' || v === undefined || v === null;
  const notNA = (v) => v !== undefined && v !== null && v !== '' && v !== '-' && v !== -1 && v !== '-1' && v !== '*';
  // 买家分层：L0 注册 / L1 潜力 / L2 小B / L3 企业类 / L4 金标（L3+ 视为优质买家）
  const L_TAG_RE = /^L[0-4]$/i;
  const L_MEAN = { L0: '注册买家', L1: '潜力买家', L2: '小B买家', L3: '企业类买家', L4: '金标买家' };
  // 同一层级的多种写法都归一（接口可能回 L3 / 企业类买家 / Platinum / gold 等）
  const TIER_ALIAS = {
    l0: 'L0', '注册买家': 'L0', standard: 'L0', standardbuyer: 'L0',
    l1: 'L1', '潜力买家': 'L1', silver: 'L1', silverbuyer: 'L1',
    l2: 'L2', '小b买家': 'L2', gold: 'L2', goldbuyer: 'L2',
    l3: 'L3', '企业类买家': 'L3', platinum: 'L3', platinumbuyer: 'L3',
    l4: 'L4', '金标买家': 'L4', probuyer: 'L4',
  };
  function tierFrom(v) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!s || s === '-' || s === '*' || s === 'null') return '';
    const up = s.toUpperCase();
    if (L_TAG_RE.test(up)) return up;                              // L0~L4
    const key = s.toLowerCase().replace(/[\s_\-\u3000·（）()]/g, '');
    if (TIER_ALIAS[key]) return TIER_ALIAS[key];                   // 英文/中文全称
    for (const k of Object.keys(TIER_ALIAS)) {                     // 形如「L3 企业类买家」
      if (/[\u4e00-\u9fa5]/.test(k) && k.length >= 3 && s.indexOf(k) >= 0) return TIER_ALIAS[k];
    }
    return '';
  }
  // 从对象里翻出层级：先看常见字段名，再看一层嵌套对象里的 level/tier/grade 字段
  // 注意 levelTag(字母 A/B/C) 经 tierFrom 会返回空 → 不会被误当成层级
  function pickLTag(o) {
    if (!o || typeof o !== 'object') return '';
    for (const k of ['highQualityLevelTag', 'qualityLevelTag', 'buyerLevelTag', 'buyerLevel', 'customerLevel',
      'levelName', 'growthLevel', 'memberLevelTag', 'levelTag']) {
      const t = tierFrom(o[k]);
      if (t) return t;
    }
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const kk of Object.keys(v)) {
          if (!/level|tier|grade/i.test(kk)) continue;
          const t = tierFrom(v[kk]);
          if (t) return t;
        }
      }
    }
    return '';
  }
  // 关联匹配用的归一化：去空白/统一小写/去常见公司后缀噪声
  const normKey = (v) => String(v === undefined || v === null ? '' : v).toLowerCase().replace(/[\s\u3000]+/g, '').replace(/[.,，。()（）"'&·-]/g, '').trim();
  // 画像取值：数组 → 顿号拼接（过滤掩码 * 与网址噪声）；数值 → 负数/空视为「无数据」；网址 → 去掉平台包裹的反引号
  const arrText = (v) => (Array.isArray(v) ? v : [v])
    .map((x) => String(x === undefined || x === null ? '' : x).trim())
    .filter((x) => x && x !== '*' && !/^`*https?:\/\//i.test(x)).join('、');
  const numText = (v) => {
    if (v === undefined || v === null || v === '') return '';
    const n = Number(v);
    return (isNaN(n) || n < 0) ? '' : String(n);
  };
  const webText = (v) => String(v === undefined || v === null ? '' : v).replace(/[`*]/g, '').trim();
  const buyerName = (b) => (!b ? '' : ((b.firstName || b.lastName) ? [b.firstName, b.lastName].filter(Boolean).join(' ') : (b.name || b.nickName || '')));
  let regionNames = null;
  const countryCn = (code) => {
    if (!code) return '';
    try {
      if (!regionNames) regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
      return regionNames.of(String(code).toUpperCase()) || String(code);
    } catch (e) { return String(code); }
  };
  const crmCache = new Map(); // accountIdEncrypt -> {buyer, crm}，同一买家只查一次

  // 对单条询盘补全客户字段：querySummary(contact) → maDetail(KHT) → alicrm(CRM)
  async function enrichRow(item, row) {
    const t = tokens();
    let contact = null;
    try {
      const qs = new URLSearchParams({ ctoken: t.ctoken, _tb_token_: t.tb });
      const body = new URLSearchParams({ _csrf_token_: t.csrf, postId: '', params: JSON.stringify({ secTradeId: item.secTradeId }) });
      const p = await request(`${API.querySummary}?${qs}`, 'POST', inquiryHeaders(t), body.toString());
      contact = (p && p.data && p.data.contact) || null;
    } catch (e) { /* 静默：补全失败不影响整表导出 */ }
    await pace(); // 补全三连请求之间也留间隔，避免连发
    if (contact) {
      if (contact.countryCode) row[COL.country] = countryCn(contact.countryCode);
      if (contact.name && isEmptyCol(row[COL.customerName])) row[COL.customerName] = contact.name;
    }
    const key = (contact && (contact.accountIdEncrypt || contact.accountId)) || item.secTradeId;
    let cust = crmCache.get(key);
    if (!cust) {
      cust = { buyer: null, crm: null };
      let kht = '';
      try {
        const html = await fetchRaw(`${API.maDetail}?imInquiryId=${encodeURIComponent(item.tradeId)}`, 'GET',
          { 'Accept': 'text/html,application/xhtml+xml', 'Referer': API.referer }, null);
        const m = String(html).match(/KHTAccessToken\s*[:=]\s*['"]([^'"]+)['"]/);
        kht = m ? m[1] : '';
      } catch (e) { /* ignore */ }
      await pace(); // maDetail → alicrm 之间留间隔
      if (kht) {
        const bid = (contact && (contact.accountIdEncrypt || contact.accountId)) || item.targetIds && item.targetIds[0];
        try {
          const qs = new URLSearchParams({ buyerAccountId: bid || '', secTradeId: item.secTradeId, secReqToken: kht, ctoken: t.ctoken, _tb_token_: t.tb });
          const p3 = await request(`${API.customerInfo}?${qs}`, 'GET',
            { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'Referer': 'https://alicrm.alibaba.com/' }, null);
          const root = (p3 && p3.data && p3.data.data) ? p3.data.data : ((p3 && p3.data) || {});
          cust.buyer = root.buyerInfo || null;
          cust.crm = root.alicrmCustomerInfo || null;
        } catch (e) { /* ignore */ }
      }
      crmCache.set(key, cust);
    }
    const b = cust.buyer || {}, c = cust.crm || {};
    const nm = buyerName(b);
    if (nm && isEmptyCol(row[COL.customerName])) row[COL.customerName] = nm;
    if (notNA(b.companyName) && isEmptyCol(row[COL.company])) row[COL.company] = b.companyName;
    // 询盘接口只给字母等级（A/B/C）→ 放「买家等级(字母)」列；
    // 「买家等级」列留给 L0~L4：接口若直接给了就用，否则由 applyCrmLevels 用客户库关联
    if (notNA(b.levelTag)) row[COL.levelLetter] = b.levelTag;
    const directL = pickLTag(b) || pickLTag(c) || pickLTag(contact);
    // 面板的「询盘增强」视图沿用字母等级展示；导出时会由 applyCrmLevels 改写成 L0~L4
    row[COL.level] = directL || (notNA(b.levelTag) ? b.levelTag : '');
    if (Object.keys(b).length && isEmptyCol(row[COL.golden])) row[COL.golden] = b.isGoldenBuyer ? '是' : '否';
    // 是否已加为客户：优先 buyerInfo 显式字段，否则看 CRM customerId 是否存在
    if ((Object.keys(b).length || Object.keys(c).length) && isEmptyCol(row[COL.addedCustomer])) {
      const added = b.isAddedCustomer === true || b.isCustomer === true || notNA(c.customerId) || notNA(b.customerId);
      row[COL.addedCustomer] = added ? '是' : '否';
    }
    const phone = notNA(c.mobileNumber) ? c.mobileNumber : (notNA(c.phoneNumber) ? c.phoneNumber : (notNA(b.mobileNumber) ? b.mobileNumber : b.phoneNumber));
    if (notNA(phone) && isEmptyCol(row[COL.phone])) row[COL.phone] = phone;
    const email = notNA(c.email) ? c.email : b.email;
    if (notNA(email) && isEmptyCol(row[COL.email])) row[COL.email] = email;
    if (notNA(b.registerDate) && isEmptyCol(row[COL.regDate])) row[COL.regDate] = fmtDate(b.registerDate);
    if (notNA(b.totalOrderVolume) && isEmptyCol(row[COL.orderAmount])) row[COL.orderAmount] = b.totalOrderVolume;
    if (notNA(c.taTotalAmount) && isEmptyCol(row[COL.purchaseAmount])) row[COL.purchaseAmount] = c.taTotalAmount;
    if (!row[COL.country] && notNA(b.country)) row[COL.country] = countryCn(b.country);
    // 买家画像列（buyerInfo / alicrmCustomerInfo 直出，零额外请求）
    BIZ_COLS.forEach(([key, , kind], i) => {
      const idx = COL.biz + i;
      const raw = (key === '__growthLevel')
        ? ((b.growthLevelInfo && b.growthLevelInfo.growthLevel) || (c.growthLevelInfo && c.growthLevelInfo.growthLevel))
        : (b[key] !== undefined && b[key] !== null && b[key] !== '' ? b[key] : c[key]);
      let v = '';
      if (kind === 'arr') v = arrText(raw);
      else if (kind === 'num') v = numText(raw);
      else if (kind === 'lvl') v = tierFrom(raw);
      else if (kind === 'web') v = webText(raw);
      if (v) row[idx] = v;
    });
    await pace();
    return row;
  }

  async function collectInquiry(startDate, endDate, onProgress, enrich, onItem) {
    const rows = [];
    for (let page = 1; ; page++) {
      const { list } = await fetchInquiryPage(page, startDate, endDate);
      const arr = Array.isArray(list) ? list : [];
      for (const item of arr) {
        const row = [];
        for (const keys of INQUIRY_FIELDS) {
          let v;
          if (keys[0] === 'productId' || keys[0] === 'productName') {
            const p = Array.isArray(item.productInfo) ? item.productInfo[0] : null;
            v = p ? (keys[0] === 'productId' ? (p.productId || p.id) : p.productName) : '';
          }
          if (v === undefined || v === '' || v === null) v = pick(item, keys);
          row.push(v === undefined || v === null ? '' : v);
        }
        row[2] = fmtDate(row[2]);
        row[11] = fmtDate(row[11]);
        row[18] = fmtDate(row[18]);
        if (!row[3] && item.sender && typeof item.sender === 'string') row[3] = item.sender;
        row[15] = sourceCn(row[15]);
        row[16] = appFromToCn(row[16]);
        row[17] = replyStatusCn(row[17]);
        rows.push({ row, item });
        if (enrich) { await enrichRow(item, row); if (onItem) onItem(rows.length); }
        // 无数据的金额/天数列，按平台口径填 0（订单总额/购买总金额/未联系天数）
        [12, 13, 19].forEach((i) => { if (isEmptyCol(row[i])) row[i] = 0; });
      }
      if (onProgress) onProgress(page, rows.length);
      if (arr.length < PAGE_SIZE) break;
      await pace();
    }
    return rows;
  }

  // ---------------- 聊天（onetalk 真实接口） ----------------
  const ONETALK_BASE = 'https://onetalk.alibaba.com/message';
  const onetalkHeaders = () => ({
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://onetalk.alibaba.com/message/messageManager.htm', 'Origin': 'https://onetalk.alibaba.com',
  });
  const onetalkPost = (url, params) => request(url, 'POST', onetalkHeaders(),
    new URLSearchParams({ params: JSON.stringify(params), _csrf: tokens().csrf }).toString());

  // 取某会话的消息历史（按 timeSlide 往前翻页），去重并只保留时间区间内
  async function collectHistory(acct, ct, startTs, endTs) {
    const out = [];
    const seen = new Set();
    let timeStamp = Date.now();
    for (let i = 0; i < 60; i++) { // 安全上限
      let r;
      try {
        r = await onetalkPost(`${ONETALK_BASE}/manager/getMessageHistoryList.htm`, {
          accountId: acct.accountId, accountIdEncrypt: acct.accountIdEncrypt,
          contactAccountId: ct.accountId, contactAccountIdEncrypt: ct.accountIdEncrypt,
          timeSlide: { timeStamp, forward: false, pageSize: PAGE_SIZE },
        });
      } catch (e) { break; }
      const list = (r.data && r.data.list) || [];
      if (!list.length) break;
      let oldest = Infinity;
      for (const m of list) {
        const ts = m.sendTime || 0;
        if (ts) oldest = Math.min(oldest, ts);
        const key = String(m.messageId || m.uuid || (ts + '|' + (m.content || '')));
        if (seen.has(key)) continue;
        seen.add(key);
        if (ts >= startTs && ts <= endTs) out.push(m);
      }
      if (list.length < PAGE_SIZE) break;
      if (!isFinite(oldest) || oldest <= startTs) break;
      timeStamp = oldest;
      await pace();
    }
    return out;
  }

  function chatRow(m, acct, ct) {
    const fromBuyer = String(m.messageType || '').toLowerCase() === 'rec';
    const role = fromBuyer ? '客户' : '业务员';
    const speaker = (fromBuyer ? (m.contact && m.contact.name) : (m.owner && m.owner.name))
      || (m.contact && m.contact.name) || acct.name || '';
    const session = (m.contact && m.contact.name) || ct.name || ct.loginId || String(ct.accountId || '');
    return [fmtDate(m.sendTime, '-'), role, speaker, String(m.content || '').replace(/\r?\n/g, ' '), session];
  }

  // 按日期取会话 → 逐个取消息，返回导出行
  async function collectChats(startDate, endDate, onProgress) {
    const startTs = toTs(startDate, false);
    const endTs = endDate ? toTs(endDate, true) : Date.now();
    const items = [];
    let accounts = [];
    try {
      const r = await onetalkPost(`${ONETALK_BASE}/manager/getSubAccountList.htm`, { companyView: false });
      accounts = (r.data && r.data.list) || [];
    } catch (e) { /* ignore */ }
    let done = 0;
    for (const acct of accounts) {
      for (let page = 1; ; page++) {
        let r;
        try {
          r = await onetalkPost(`${ONETALK_BASE}/manager/queryRecentContactList.htm`, {
            startTime: startTs, endTime: endTs,
            activeAccountId: acct.accountId, activeAccountIdEncrypt: acct.accountIdEncrypt,
            pagination: { currentPage: page, pageSize: PAGE_SIZE },
          });
        } catch (e) { break; }
        const contacts = (r.data && r.data.list) || [];
        if (!contacts.length) break;
        for (const ct of contacts) {
          const msgs = await collectHistory(acct, ct, startTs, endTs);
          for (const m of msgs) items.push({ ts: m.sendTime || 0, row: chatRow(m, acct, ct) });
          done++;
          if (onProgress) onProgress(done, items.length);
          await pace();
        }
        if (contacts.length < PAGE_SIZE) break;
        await pace();
      }
    }
    items.sort((a, b) => a.ts - b.ts); // 按发送时间升序，便于阅读/复盘
    return items.map((x) => x.row);
  }

  // ---------------- 导出 ----------------
  function downloadCSV(header, rows, filename) {
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const text = [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
    const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function blobDownload(bytes, filename, mime) {
    const blob = new Blob([bytes], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  function saveTable(header, rows, baseName, sheetName) {
    // 空单元格统一填 '-'
    const body = rows.map((r) => r.map((v) => (v === '' || v === undefined || v === null ? '-' : v)));
    if (typeof XLSX !== 'undefined' && XLSX.utils && XLSX.write) {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...body]), sheetName || 'Sheet1');
      const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
      const filename = baseName + '.xlsx';
      const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      // 优先后台/离屏下载（强制 .xlsx 文件名/类型），失败再回退到页面 blob 下载
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'download', filename, mime: MIME, data: Array.from(bytes) })
          .then((res) => {
            if (res && res.ok) resolve({ kind: 'xlsx', name: filename, ok: true, via: res.via, id: res.id });
            else { blobDownload(bytes, filename, MIME); resolve({ kind: 'xlsx', name: filename, ok: false, error: (res && res.error) || '后台无响应（已回退页面下载）' }); }
          })
          .catch((e) => { blobDownload(bytes, filename, MIME); resolve({ kind: 'xlsx', name: filename, ok: false, error: String((e && e.message) || e) }); });
      });
    }
    downloadCSV(header, body, baseName + '.csv');
    return Promise.resolve({ kind: 'csv', name: baseName + '.csv', ok: true });
  }
  // 文件名时间戳：HH.MM.SS_YYYYMMDD（与示例 `国际站询盘导出_15.56.28_20261010.xlsx` 一致）
  const nameStamp = () => {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  };
  const localStamp = () => {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  // 导出成功后把数据写入扩展的 IndexedDB（content script 在页面源下写不到扩展的库，故交给后台）
  // 失败不影响导出本身，只在控制台留一条日志
  function ingest(kind, name, header, rows) {
    try {
      chrome.runtime.sendMessage({ type: 'ingest', file: { name, kind, header, rows, mtime: localStamp(), source: 'export' } },
        (r) => { if (chrome.runtime.lastError) console.warn('[ali-export-ext] 入库失败', chrome.runtime.lastError.message); else console.log('[ali-export-ext] 入库', r); });
    } catch (e) { console.warn('[ali-export-ext] 入库异常', e); }
  }

  // 用已入库的「我的客户 / 公海客户」把询盘「买家等级」改写成 L0~L4（零额外平台请求）
  // 关联键：公司名称 → 客户名称；同名但级别不一致的键在后台已置空（宁可不填，不填错）
  async function applyCrmLevels(rows) {
    let index = new Map();
    let customers = 0;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'crmLevelLookup' });
      if (r && r.ok) { index = new Map(r.entries || []); customers = r.customers || 0; }
      else if (r && r.error) console.warn('[ali-export-ext] 客户等级索引失败', r.error);
    } catch (e) { console.warn('[ali-export-ext] 客户等级索引异常', e); }
    if (!index.size) return { ok: false, total: rows.length, hit: 0, keys: 0, customers };
    let hit = 0;
    for (const { row } of rows) {
      const cur = String(row[COL.level] || '').trim();
      if (L_TAG_RE.test(cur)) { hit++; continue; }                       // 接口直接给了 L 级 → 保留
      if (cur && cur !== '-' && isEmptyCol(row[COL.levelLetter])) row[COL.levelLetter] = cur; // 顺手把字母挪到新列
      const l = index.get(normKey(row[COL.company])) || index.get(normKey(row[COL.customerName])) || '';
      row[COL.level] = l;
      if (l) hit++;
    }
    return { ok: true, total: rows.length, hit, keys: index.size, customers };
  }

  async function exportInquiry(startDate, endDate, btn) {
    btn.disabled = true; btn.textContent = '导出中…';
    try {
      // 询盘导出默认补全客户信息（无需勾选）
      const data = await collectInquiry(startDate, endDate,
        (p, n) => { btn.textContent = `询盘 ${n} 条…`; }, true,
        (n) => { btn.textContent = `补全客户 ${n} 条…`; });
      btn.textContent = '关联买家分层…';
      const lv = await applyCrmLevels(data);
      btn.textContent = '生成文件…';
      const r = await saveTable(INQUIRY_HEADERS, data.map((d) => d.row), `国际站询盘导出_${nameStamp()}`, '询盘列表数据-自用');
      ingest('inquiry', r.name, INQUIRY_HEADERS, data.map((d) => d.row));
      const lvTip = lv.ok ? `｜买家分层 L0~L4 关联到 ${lv.hit}/${lv.total} 条（客户库索引 ${lv.keys} 键）`
        : `｜买家分层未关联（客户库为空，先导出一次「我的客户」即可）`;
      const tip = `已导出询盘 ${data.length} 条（${String(r.kind).toUpperCase()}）· 文件名：${r.name}` + lvTip + (r.ok ? '' : ` · 下载异常：${r.error}`);
      toast(tip);
      setStatus(`上次导出：${tip}` + (r.ok ? `（方式：${r.via || '页面'}）` : ''));
      console.log('[ali-export-ext] 导出完成', r, lv);
    } catch (e) {
      toast('导出失败：' + e.message, true);
      console.error(e);
    } finally {
      btn.disabled = false; btn.textContent = '导出询盘（全部）';
    }
  }

  // ---------------- 询盘增强视图（本地统计 / 筛选 / 去重 / 导出） ----------------
  // 中文国家名 → IANA 时区（用于把页面时间折算成客户当地时间；未收录的国家回退显示原时间）
  const COUNTRY_TZ = {
    '中国': 'Asia/Shanghai', '香港': 'Asia/Hong_Kong', '台湾': 'Asia/Taipei', '澳门': 'Asia/Macau',
    '印度': 'Asia/Kolkata', '日本': 'Asia/Tokyo', '韩国': 'Asia/Seoul', '越南': 'Asia/Ho_Chi_Minh',
    '泰国': 'Asia/Bangkok', '马来西亚': 'Asia/Kuala_Lumpur', '新加坡': 'Asia/Singapore', '印度尼西亚': 'Asia/Jakarta',
    '菲律宾': 'Asia/Manila', '巴基斯坦': 'Asia/Karachi', '孟加拉国': 'Asia/Dhaka', '斯里兰卡': 'Asia/Colombo',
    '尼泊尔': 'Asia/Kathmandu', '缅甸': 'Asia/Yangon', '柬埔寨': 'Asia/Phnom_Penh', '老挝': 'Asia/Vientiane',
    '蒙古': 'Asia/Ulaanbaatar', '哈萨克斯坦': 'Asia/Almaty', '乌兹别克斯坦': 'Asia/Tashkent', '阿联酋': 'Asia/Dubai',
    '沙特阿拉伯': 'Asia/Riyadh', '以色列': 'Asia/Jerusalem', '土耳其': 'Europe/Istanbul', '伊朗': 'Asia/Tehran',
    '伊拉克': 'Asia/Baghdad', '科威特': 'Asia/Kuwait', '卡塔尔': 'Asia/Qatar', '阿曼': 'Asia/Muscat',
    '约旦': 'Asia/Amman', '黎巴嫩': 'Asia/Beirut', '巴林': 'Asia/Bahrain', '也门': 'Asia/Aden',
    '阿塞拜疆': 'Asia/Baku', '格鲁吉亚': 'Asia/Tbilisi', '亚美尼亚': 'Asia/Yerevan', '阿富汗': 'Asia/Kabul',
    '俄罗斯': 'Europe/Moscow', '乌克兰': 'Europe/Kyiv', '白俄罗斯': 'Europe/Minsk', '波兰': 'Europe/Warsaw',
    '德国': 'Europe/Berlin', '法国': 'Europe/Paris', '英国': 'Europe/London', '爱尔兰': 'Europe/Dublin',
    '荷兰': 'Europe/Amsterdam', '比利时': 'Europe/Brussels', '卢森堡': 'Europe/Luxembourg', '瑞士': 'Europe/Zurich',
    '奥地利': 'Europe/Vienna', '捷克': 'Europe/Prague', '斯洛伐克': 'Europe/Bratislava', '匈牙利': 'Europe/Budapest',
    '罗马尼亚': 'Europe/Bucharest', '保加利亚': 'Europe/Sofia', '希腊': 'Europe/Athens', '意大利': 'Europe/Rome',
    '西班牙': 'Europe/Madrid', '葡萄牙': 'Europe/Lisbon', '瑞典': 'Europe/Stockholm', '挪威': 'Europe/Oslo',
    '丹麦': 'Europe/Copenhagen', '芬兰': 'Europe/Helsinki', '冰岛': 'Atlantic/Reykjavik', '爱沙尼亚': 'Europe/Tallinn',
    '拉脱维亚': 'Europe/Riga', '立陶宛': 'Europe/Vilnius', '克罗地亚': 'Europe/Zagreb', '塞尔维亚': 'Europe/Belgrade',
    '斯洛文尼亚': 'Europe/Ljubljana', '波黑': 'Europe/Sarajevo', '阿尔巴尼亚': 'Europe/Tirane', '北马其顿': 'Europe/Skopje',
    '摩尔多瓦': 'Europe/Chisinau', '塞浦路斯': 'Asia/Nicosia', '马耳他': 'Europe/Malta',
    '美国': 'America/New_York', '加拿大': 'America/Toronto', '墨西哥': 'America/Mexico_City', '巴西': 'America/Sao_Paulo',
    '阿根廷': 'America/Argentina/Buenos_Aires', '智利': 'America/Santiago', '秘鲁': 'America/Lima', '哥伦比亚': 'America/Bogota',
    '委内瑞拉': 'America/Caracas', '厄瓜多尔': 'America/Guayaquil', '玻利维亚': 'America/La_Paz', '巴拉圭': 'America/Asuncion',
    '乌拉圭': 'America/Montevideo', '危地马拉': 'America/Guatemala', '哥斯达黎加': 'America/Costa_Rica', '巴拿马': 'America/Panama',
    '洪都拉斯': 'America/Tegucigalpa', '萨尔瓦多': 'America/El_Salvador', '尼加拉瓜': 'America/Managua', '多米尼加': 'America/Santo_Domingo',
    '古巴': 'America/Havana', '牙买加': 'America/Jamaica', '波多黎各': 'America/Puerto_Rico',
    '埃及': 'Africa/Cairo', '尼日利亚': 'Africa/Lagos', '南非': 'Africa/Johannesburg', '摩洛哥': 'Africa/Casablanca',
    '阿尔及利亚': 'Africa/Algiers', '突尼斯': 'Africa/Tunis', '利比亚': 'Africa/Tripoli', '肯尼亚': 'Africa/Nairobi',
    '坦桑尼亚': 'Africa/Dar_es_Salaam', '埃塞俄比亚': 'Africa/Addis_Ababa', '加纳': 'Africa/Accra', '科特迪瓦': 'Africa/Abidjan',
    '塞内加尔': 'Africa/Dakar', '喀麦隆': 'Africa/Douala', '乌干达': 'Africa/Kampala', '津巴布韦': 'Africa/Harare',
    '赞比亚': 'Africa/Lusaka', '莫桑比克': 'Africa/Maputo', '安哥拉': 'Africa/Luanda', '苏丹': 'Africa/Khartoum',
    '澳大利亚': 'Australia/Sydney', '新西兰': 'Pacific/Auckland',
    // 常见属地 / 小地区
    '马提尼克': 'America/Martinique', '瓜德罗普': 'America/Guadeloupe', '留尼汪': 'Indian/Reunion',
    '法属圭亚那': 'America/Cayenne', '新喀里多尼亚': 'Pacific/Noumea', '斐济': 'Pacific/Fiji',
    '巴布亚新几内亚': 'Pacific/Port_Moresby', '文莱': 'Asia/Brunei', '马尔代夫': 'Indian/Maldives',
    '不丹': 'Asia/Thimphu', '法罗群岛': 'Atlantic/Faroe', '摩纳哥': 'Europe/Monaco',
  };
  const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 页面时间为北京时间(本机时区)：按该口径解析
  function parseLocalTime(str) {
    const m = String(str || '').match(/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    return isNaN(d.getTime()) ? null : d;
  }
  const tzDayKey = (ms, tz) => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); } catch (e) { return ''; }
  };
  // 返回 { text: 'MM/DD 周X HH:mm', isToday, unknown }；unknown 表示国家未收录时区
  function buyerLocal(timeStr, country) {
    const d = parseLocalTime(timeStr);
    if (!d) return null;
    const tz = COUNTRY_TZ[String(country || '').trim()];
    if (!tz) return { text: String(timeStr || '-'), isToday: false, unknown: true };
    try {
      const text = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
      return { text, isToday: tzDayKey(d.getTime(), tz) === tzDayKey(Date.now(), tz) };
    } catch (e) { return { text: String(timeStr || '-'), isToday: false, unknown: true }; }
  }

  const INV_COLS = [
    { i: 3, k: '客户名称' }, { i: 14, k: '国家' }, { i: 15, k: '来源' }, { i: 4, k: '负责人' },
    { i: 7, k: '买家等级' }, { i: 6, k: '是否已加为客户' }, { i: 2, k: '创建时间' }, { i: 21, k: '询盘主题' },
  ];
  let invViewState = null; // { data, country, dedupe, onlyStale }

  function invFiltered() {
    const s = invViewState;
    if (!s) return [];
    let rows = s.data;
    if (s.country && s.country !== '全部') rows = rows.filter((d) => String(d.row[14] || '').trim() === s.country);
    if (s.dedupe) {
      const seen = new Set();
      rows = rows.filter((d) => {
        const k = String(d.row[3] || '').trim() + '|' + String(d.row[14] || '').trim();
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
    }
    if (s.onlyStale) rows = rows.filter((d) => { const t = buyerLocal(d.row[2], d.row[14]); return t && !t.isToday; });
    return rows;
  }
  function closeInquiryView() {
    const el = document.getElementById('ali-inv-view');
    if (el) el.remove();
    invViewState = null;
  }
  function renderInquiryView() {
    const box = document.getElementById('ali-inv-view');
    if (!box || !invViewState) return;
    const all = invViewState.data;
    const tally = (i) => {
      const m = new Map();
      all.forEach((d) => { const k = String(d.row[i] || '').trim(); if (k && k !== '-') m.set(k, (m.get(k) || 0) + 1); });
      return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
    };
    const rows = invFiltered();
    const countries = new Set(all.map((d) => String(d.row[14] || '').trim()).filter((x) => x && x !== '-'));
    const customers = new Set(all.map((d) => String(d.row[3] || '').trim()).filter(Boolean));
    const fmt = (arr, n) => (arr.slice(0, n).map(([k, v]) => `${k} ${v}`).join(' · ') || '-');
    box.querySelector('#ali-inv-stats').innerHTML =
      `询盘 <b>${all.length}</b> · 客户 <b>${customers.size}</b> · 国家/地区 <b>${countries.size}</b>` +
      `<div style="margin-top:3px;">来源：${fmt(tally(15), 4)}</div>` +
      `<div>负责人：${fmt(tally(4), 4)}</div>` +
      `<div>等级：${fmt(tally(7), 6)}</div>`;
    const td = 'padding:5px 8px;border-bottom:1px solid #f3f4f6;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    box.querySelector('#ali-inv-tbody').innerHTML = rows.map((d) => {
      const t = buyerLocal(d.row[2], d.row[14]);
      const tHtml = t ? `<span style="color:${t.isToday ? '#059669' : '#dc2626'};" title="${t.unknown ? '国家未收录时区，显示原时间' : (t.isToday ? '客户当地今天' : '客户当地非今天')}">${escHtml(t.text)}${t.unknown ? ' *' : ''}</span>` : '-';
      return '<tr>' + INV_COLS.map((c) => {
        const v = String(d.row[c.i] == null ? '' : d.row[c.i]).trim() || '-';
        return `<td style="${td}" title="${escHtml(v)}">${escHtml(v)}</td>`;
      }).join('') + `<td style="${td}">${tHtml}</td></tr>`;
    }).join('');
    box.querySelector('#ali-inv-count').textContent = `筛选后 ${rows.length} / ${all.length} 条`;
    const eb = box.querySelector('#ali-inv-export');
    if (eb) eb.textContent = `导出当前筛选 (${rows.length})`;
  }
  async function exportInquiryFiltered(btn) {
    if (!invViewState) return;
    const rows = invFiltered().map((d) => d.row.slice()); // 复制一份：下面的等级改写不影响面板里的筛选视图
    if (!rows.length) { toast('当前筛选没有数据', true); return; }
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = '导出中…';
    try {
      const lv = await applyCrmLevels(rows.map((row) => ({ row })));
      const r = await saveTable(INQUIRY_HEADERS, rows, `国际站询盘导出_${nameStamp()}`, '询盘列表数据-自用');
      ingest('inquiry', r.name, INQUIRY_HEADERS, rows);
      const lvTip = lv.ok ? `｜买家分层关联到 ${lv.hit}/${lv.total} 条` : '｜买家分层未关联（客户库为空）';
      const tip = `已导出询盘 ${rows.length} 条（筛选后）· 文件名：${r.name}` + lvTip + (r.ok ? '' : ` · 下载异常：${r.error}`);
      toast(tip); setStatus(`上次导出：${tip}`);
    } catch (e) { toast('导出失败：' + e.message, true); }
    finally { btn.disabled = false; btn.textContent = label; }
  }
  async function openInquiryView(startDate, endDate, btn) {
    if (document.getElementById('ali-inv-view')) { closeInquiryView(); return; } // 再点一次关闭
    btn.disabled = true;
    const box = document.createElement('div');
    box.id = 'ali-inv-view';
    box.style.cssText = 'position:fixed;right:16px;top:56px;z-index:2147483000;width:min(900px,94vw);max-height:80vh;' +
      'display:flex;flex-direction:column;background:#fff;border:1px solid #e5e7eb;border-radius:12px;' +
      'box-shadow:0 10px 40px rgba(0,0,0,.18);font:13px/1.5 "Microsoft YaHei",sans-serif;color:#111;overflow:hidden;';
    const th = 'position:sticky;top:0;background:#f9fafb;text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;white-space:nowrap;';
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #f0f0f0;">' +
      '<b>询盘增强</b><span id="ali-inv-prog" style="color:#6b7280;font-size:12px;">正在采集…</span>' +
      '<span style="flex:1"></span><button id="ali-inv-close" style="border:0;background:#f3f4f6;border-radius:6px;padding:4px 10px;cursor:pointer;">关闭</button></div>' +
      '<div id="ali-inv-stats" style="padding:8px 14px;color:#374151;font-size:12px;border-bottom:1px solid #f7f7f7;"></div>' +
      '<div style="display:flex;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid #f0f0f0;flex-wrap:wrap;font-size:12px;">' +
      '国家 <select id="ali-inv-country" style="max-width:180px;padding:2px 4px;"></select>' +
      '<label><input type="checkbox" id="ali-inv-dedupe" checked> 去重（按客户）</label>' +
      '<label><input type="checkbox" id="ali-inv-stale"> 仅非今日</label>' +
      '<span style="color:#9ca3af;">勾选上面条件后，再点右侧按钮导出</span>' +
      '<span style="flex:1"></span><span id="ali-inv-count" style="color:#6b7280;"></span>' +
      '<button id="ali-inv-export" style="border:0;border-radius:6px;background:#2563eb;color:#fff;padding:5px 12px;cursor:pointer;">导出当前筛选</button></div>' +
      '<div style="overflow:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr>' +
      INV_COLS.map((c) => `<th style="${th}">${c.k}</th>`).join('') + `<th style="${th}">客户本地时间</th>` +
      '</tr></thead><tbody id="ali-inv-tbody"></tbody></table></div>';
    document.body.appendChild(box);
    box.querySelector('#ali-inv-close').onclick = () => closeInquiryView();
    const prog = (t) => { const el = box.querySelector('#ali-inv-prog'); if (el) el.textContent = t; };
    try {
      const data = await collectInquiry(startDate, endDate, (p, n) => prog(`已取 ${n} 条…`), true, (n) => prog(`补全客户 ${n} 条…`));
      invViewState = { data, country: '全部', dedupe: true, onlyStale: false };
      const list = Array.from(new Set(data.map((d) => String(d.row[14] || '').trim()).filter(Boolean))).sort();
      const sel = box.querySelector('#ali-inv-country');
      sel.innerHTML = '<option value="全部">全部</option>' + list.map((c) => `<option>${escHtml(c)}</option>`).join('');
      sel.onchange = () => { invViewState.country = sel.value; renderInquiryView(); };
      box.querySelector('#ali-inv-dedupe').onchange = (e) => { invViewState.dedupe = e.target.checked; renderInquiryView(); };
      box.querySelector('#ali-inv-stale').onchange = (e) => { invViewState.onlyStale = e.target.checked; renderInquiryView(); };
      box.querySelector('#ali-inv-export').onclick = (e) => exportInquiryFiltered(e.target);
      prog(`共 ${data.length} 条`);
      renderInquiryView();
    } catch (e) { prog('采集失败：' + e.message); }
    finally { btn.disabled = false; }
  }

  // ---------------- 客户导出（alicrm 客户列表） ----------------
  const CRM_API = {
    mine: 'https://alicrm.alibaba.com/eggCrmQn/crm/customerQueryServiceI/queryCustomerList.json',
    public: 'https://alicrm.alibaba.com/eggCrmQn/crm/customerQueryServiceI/queryPublicCustomerList.json',
    dict: 'https://alicrm.alibaba.com/eggCrmQn/crm/dictionaryQueryServiceI/queryDictionaryStaticMap.json',
  };
  // 客户列表分页大小：与页面原生请求一致（>10 时后端会省略 highQualityLevelTag/growthLevel，勿改）
  const CRM_PAGE_SIZE = 10;
  // 字段 → 中文表头（未列出的字段直接用原始键名，保证不丢数据）
  const CRM_LABELS = {
    customerId: '客户ID', companyName: '公司名称', countryCode: '国家/地区',
    customerGroup: '客户分组', importanceLevel: '重要程度', memberLevel: '会员等级',
    growthLevel: '成长等级', customerSources: '客户来源', follow: '跟进状态',
    saleName: '负责人', originSaleName: '原负责人', isDing: '星标客户',
    repurchase: '复购客户', willLoss: '流失预警', createDate: '创建时间', pickUpDate: '领取时间',
    taOrderCount: '订单数', annualProcurement: '年采购额', 'annualProcurementOnline.value': '年采购额(线上)',
    categorys: '采购类目', businessTypes: '经营类型', marketingGroups: '营销分组',
    okkiAiTags: 'AI标签', icbuCustomerOkkiAiAnalysisReferType: 'AI分析类型',
    'mainContact.contactName': '联系人', 'mainContact.email': '邮箱', 'mainContact.wangwangId': '旺旺',
    'mainContact.aliId': 'AliID', 'mainContact.loginId': '登录名', 'mainContact.highQualityLevelTag': '买家等级',
    'mainContact.isGoldenBuyer': '金牌买家', 'mainContact.referenceId': '参考ID',
    'recentNote.content': '最近备注', 'recentNote.noteLabel': '备注标签', 'recentNote.contentCode': '备注码',
    'recentNote.noteCode': '备注类型', 'recentNote.noteTime': '备注时间', 'recentNote.saleName': '备注人',
    'recentNote.type': '备注来源', 'recentNote.deletable': '备注可删',
    loginId: '客户登录名', marketingCustomerGroups: '营销分组(原始)', 'mainContact.blueTag': '蓝标',
    'mainContact.growthLevelInfo.growthLevel': '成长等级(标签)', 'recentNote.source': '小记来源',
    'recentNote.scoreInContent': '小记评分', 'recentNote.parentNoteCode': '上级备注码', 'recentNote.noteId': '备注ID',
    'recentNote.saleMemberSeq': '备注人序号', annualProcurementOnline: '年采购额(线上·原始)',
    customerSource: '客户来源(原始)', potentialScore: '潜在评分', openTime: '进入公海时间',
  };
  // 列顺序（存在才输出）；其余字段按原顺序追加在后面
  const CRM_ORDER = [
    'customerId', 'companyName', 'mainContact.contactName', 'countryCode',
    'customerGroup', 'importanceLevel', 'memberLevel', 'mainContact.highQualityLevelTag', 'growthLevel',
    'customerSources', 'follow', 'mainContact.email', 'mainContact.wangwangId', 'mainContact.aliId', 'mainContact.loginId',
    'saleName', 'originSaleName', 'isDing', 'repurchase', 'willLoss', 'mainContact.isGoldenBuyer', 'mainContact.blueTag',
    'createDate', 'pickUpDate', 'taOrderCount', 'annualProcurement', 'annualProcurementOnline.value',
    'categorys', 'businessTypes', 'marketingGroups', 'okkiAiTags', 'icbuCustomerOkkiAiAnalysisReferType',
    'recentNote.content', 'recentNote.source', 'recentNote.scoreInContent', 'recentNote.noteLabel', 'recentNote.noteCode', 'recentNote.noteTime', 'recentNote.saleName', 'recentNote.deletable',
  ];
  // 不导出的字段：安全令牌 / 头像 / 各种 URL / logo / 重复的原始对象
  const CRM_DROP = (k) => /secToken|avatar|url$|logo$/i.test(k) || k === 'recentNote';
  function crmHeaders() {
    return {
      'Content-Type': 'application/json;charset=UTF-8',
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': location.href,
    };
  }
  let crmDict = null; // 字典缓存 { CUSTOMER_GROUP:{code:label}, IMPORTANCE_LEVEL:{...} }
  async function loadCrmDict() {
    if (crmDict) return crmDict;
    crmDict = {};
    try {
      const qs = new URLSearchParams({ type: 'CUSTOMER_GROUP,NOTE,ANNUAL_PROCUREMENT,IMPORTANCE_LEVEL,CUSTOMER_DYNAMIC_TYPE', _tb_token_: tokens().tb });
      const j = await request(`${CRM_API.dict}?${qs}`, 'GET', crmHeaders(), null);
      const m = (j && j.data && j.data.data && j.data.data.multiDicTypeMap) || {};
      for (const t of Object.keys(m)) {
        crmDict[t] = {};
        (m[t] || []).forEach((x) => { if (x && x.code != null) crmDict[t][String(x.code)] = x.label; });
      }
    } catch (e) { /* 字典取不到就退回原始码 */ }
    return crmDict;
  }
  const dictLabel = (type, code) => ((crmDict && crmDict[type] && crmDict[type][String(code)]) || null);

  async function collectCustomers(scope, onProgress) {
    await loadCrmDict();
    const qs = new URLSearchParams({ _tb_token_: tokens().tb });
    const url = scope === 'public' ? CRM_API.public : CRM_API.mine;
    // 公海的 orderDescs 是「字符串」且按 open_time 排序（照抄页面自身请求，勿改）
    const orderDescs = scope === 'public'
      ? JSON.stringify([{ col: 'open_time', asc: false }])
      : [{ col: 'opp_gmt_modified', asc: false }];
    const items = [];
    let total = Infinity;
    for (let page = 1; page <= 200; page++) { // 安全上限 200 页
      const body = JSON.stringify({ jsonArray: '[]', orderDescs, pageNum: page, pageSize: CRM_PAGE_SIZE });
      const j = await request(`${url}?${qs}`, 'POST', crmHeaders(), body);
      const d = (j && j.data) || {};
      const arr = Array.isArray(d.data) ? d.data : [];
      if (typeof d.total === 'number') total = d.total;
      items.push(...arr);
      if (onProgress) onProgress(items.length, total);
      if (!arr.length || items.length >= total || arr.length < CRM_PAGE_SIZE) break;
      await pace();
    }
    return items;
  }
  function flattenObj(o, prefix, out) {
    Object.keys(o || {}).forEach((k) => {
      const v = o[k];
      const key = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flattenObj(v, key, out);
      else out[key] = v;
    });
    return out;
  }
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
  // 店铺会员体系（普通/高级/VIP）；memberLevel 接口码 → 中文
  const MEMBER_LEVEL = { COMMON_MEMBER: '普通会员', SENIOR_MEMBER: '高级会员' };
  function fmtIso(s) {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function crmCell(key, val) {
    if (val === null || val === undefined || val === '') return '';
    // 平台的「未填写」占位符：NA / N/A 一律视为空（导出时统一为 '-'）
    if (typeof val === 'string' && /^N\/?A$/i.test(val.trim())) return '';
    if (key === 'countryCode') return countryCn(String(val)) || String(val);
    if (key === 'customerGroup') return dictLabel('CUSTOMER_GROUP', val) || String(val);
    if (key === 'importanceLevel') return dictLabel('IMPORTANCE_LEVEL', val) || String(val);
    if (key === 'memberLevel') return MEMBER_LEVEL[String(val).trim()] || String(val);
    if (key === 'annualProcurement') return dictLabel('ANNUAL_PROCUREMENT', val) || String(val);
    if (val === true || val === 'true') return '是';
    if (val === false || val === 'false') return '否';
    const s = Array.isArray(val) ? val.join(',') : String(val);
    if (ISO_RE.test(s)) return fmtIso(s); // ISO(UTC) → 本地时间
    return s;
  }
  // 按单个时间字段过滤（值为 ISO 或 'YYYY-MM-DD HH:mm:ss'）；区间为闭区间，含首尾整天
  function filterByDateField(items, key, startDate, endDate) {
    if (!startDate && !endDate) return items;
    const s = startDate ? new Date(startDate + 'T00:00:00').getTime() : -Infinity;
    const e = endDate ? new Date(endDate + 'T23:59:59.999').getTime() : Infinity;
    return items.filter((it) => {
      const raw = it && it[key];
      if (raw === null || raw === undefined || raw === '') return false;
      const t = new Date(raw).getTime();
      return !isNaN(t) && t >= s && t <= e;
    });
  }

  async function exportCustomers(btn, scope, startDate, endDate, dateField) {
    const isPub = scope === 'public';
    const fileBase = isPub ? '公海客户' : '我的客户';
    const sheetName = isPub ? '公海客户-自用' : '我的客户-自用';
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = '采集客户…';
    try {
      const all = await collectCustomers(scope, (n, t) => { btn.textContent = `客户 ${n}/${t === Infinity ? '?' : t}…`; });
      const items = (dateField && (startDate || endDate)) ? filterByDateField(all, dateField, startDate, endDate) : all;
      if (!items.length) { toast(all.length ? '该时间范围内没有客户数据（可放宽时间）' : '没有取到客户数据', true); return; }
      const flatList = items.map((it) => flattenObj(it, '', {}));
      const present = [];
      const seen = new Set();
      flatList.forEach((f) => Object.keys(f).forEach((k) => { if (!seen.has(k) && !CRM_DROP(k)) { seen.add(k); present.push(k); } }));
      const ordered = CRM_ORDER.filter((k) => seen.has(k)).concat(present.filter((k) => CRM_ORDER.indexOf(k) < 0));
      const header = ordered.map((k) => CRM_LABELS[k] || k);
      const rows = flatList.map((f) => ordered.map((k) => crmCell(k, f[k])));
      btn.textContent = '生成文件…';
      const r = await saveTable(header, rows, `${fileBase}_${nameStamp()}`, sheetName);
      ingest(isPub ? 'public_customer' : 'customer', r.name, header, rows);
      const tip = `已导出${fileBase} ${rows.length} 条（${String(r.kind).toUpperCase()}）· 文件名：${r.name}` + (r.ok ? '' : ` · 下载异常：${r.error}`);
      toast(tip);
      setStatus(`上次导出：${tip}`);
    } catch (e) {
      toast(`导出${fileBase}失败：` + e.message, true);
      console.error(e);
    } finally { btn.disabled = false; btn.textContent = label; }
  }

  // ---------------- 访客分析导出（mydata getVisitors） ----------------
  const VISITOR_API = 'https://mydata.alibaba.com/self/.json';
  const VIS_LABELS = {
    visitorId: '访客ID', buyerCountryId: '国家/地区', buyerCountry: '国家(英文)',
    buyerTag: '买家标签', levelTag: '买家等级',
    searchKeyword: '搜索关键词', serKeywords: '进店来源词',
    totalVisitPv: '浏览量', totalVisitSellerCnt: '到访店铺次数', staySecond: '停留秒数',
    totalRfqCnt: 'RFQ数', totalMcFbCnt: '反馈数(MC)', totalMcSellerCnt: '联系卖家数(MC)',
    totalAtmFbCnt: '反馈数(ATM)', totalAtmSellerCnt: '联系卖家数(ATM)',
    isVisitHomepage: '逛过首页', isVisitProfilePage: '看过公司简介', isVisitContactPage: '看过联系方式',
    isAddInquiryCart: '加过询盘车', isClickPlaceOrder: '点过下单',
    buyerName: '买家名称', statDate: '统计日期', logTime: '记录时间', buyerRegion: '地区', visitPv: '访问PV',
    isGoldBuyer: '金牌买家', isBrandFansBuyer: '品牌粉丝买家', isOnlineRetailerBuyer: '线上零售商买家',
    isVisitCertifiedInfo: '看过认证信息', isViewContactInformation: '查看过联系方式', sendEmailCnt: '发邮件数',
    mailable: '可邮件联系', isMailable: '可邮件联系(2)', unmailableHint: '不可邮件原因', remark: '备注',
    buyerMemberId: '买家会员ID', buyerMemberSeq: '买家序号', buyerCookieId: '买家CookieID',
    buyerCompanyId: '买家公司ID', sortIndex: '排序号',
  };
  const VIS_ORDER = [
    'visitorId', 'buyerCountryId', 'buyerCountry', 'buyerTag', 'levelTag',
    'searchKeyword', 'serKeywords', 'totalVisitPv', 'totalVisitSellerCnt', 'staySecond', 'totalRfqCnt',
    'isVisitHomepage', 'isVisitProfilePage', 'isVisitContactPage', 'isAddInquiryCart', 'isClickPlaceOrder',
    'totalMcFbCnt', 'totalMcSellerCnt', 'totalAtmFbCnt', 'totalAtmSellerCnt',
  ];
  const VIS_DROP = (k) => /Img$|url$/i.test(k); // 纯样式类名 / 图片 URL，无意义
  const randHex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const visHeaders = () => ({
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': location.href,
  });
  const pickTotal = (v) => {
    for (const k of ['total', 'totalCount', 'count', 'totalSize', 'recordCount', 'totalNum']) {
      if (v && typeof v[k] === 'number') return v[k];
    }
    return null;
  };
  async function collectVisitors(startDate, endDate, onProgress) {
    const t = tokens();
    const items = [];
    let total = Infinity;
    const PS = 50;
    for (let page = 1; page <= 200; page++) { // 安全上限 200 页
      const qs = new URLSearchParams({
        action: 'CommonAction', iName: 'getVisitors', isVip: 'true',
        ctoken: t.ctoken, _tb_token_: t.tb, dmtrack_pageid: randHex(24),
      });
      qs.set(String(Math.random()), ''); // 缓存击穿（对齐页面自身的随机参数）
      const body = new URLSearchParams({
        orderBy: '', orderModel: '', pageSize: String(PS), pageNO: String(page),
        statisticsType: 'day', selected: '0', startDate: startDate || '', endDate: endDate || '',
        searchKeyword: '', buyerRegion: '', buyerCountry: '', subMemberSeq: '',
        isMcFb: 'false', isAtmFb: 'false', hasRemarks: 'false',
        statisticType: 'os', desTime: String(Date.now()),
      });
      const j = await request(`${VISITOR_API}?${qs}`, 'POST', visHeaders(), body.toString());
      const v = (j && j.value) || {};
      const arr = Array.isArray(v.data) ? v.data : [];
      const tt = pickTotal(v);
      if (tt != null) total = tt;
      items.push(...arr);
      if (onProgress) onProgress(items.length, total);
      if (!arr.length || items.length >= total || arr.length < PS) break;
      await pace();
    }
    return items;
  }
  const visCell = (key, val) => {
    if (val === null || val === undefined || val === '') return '';
    if (key === 'buyerCountryId') return countryCn(String(val)) || String(val);
    if (/^is[A-Z]/.test(key) && (val === 0 || val === 1 || val === '0' || val === '1')) return (val === 1 || val === '1') ? '是' : '否';
    if (val === true || val === 'true') return '是';
    if (val === false || val === 'false') return '否';
    return Array.isArray(val) ? val.join(',') : String(val);
  };
  async function exportVisitors(startDate, endDate, btn) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = '采集访客…';
    try {
      const items = await collectVisitors(startDate, endDate, (n, t) => { btn.textContent = `访客 ${n}/${t === Infinity ? '?' : t}…`; });
      if (!items.length) { toast('没有取到访客数据（换个日期范围试试）', true); return; }
      const flatList = items.map((it) => flattenObj(it, '', {}));
      const present = [];
      const seen = new Set();
      flatList.forEach((f) => Object.keys(f).forEach((k) => { if (!seen.has(k) && !VIS_DROP(k)) { seen.add(k); present.push(k); } }));
      const ordered = VIS_ORDER.filter((k) => seen.has(k)).concat(present.filter((k) => VIS_ORDER.indexOf(k) < 0));
      const header = ordered.map((k) => VIS_LABELS[k] || k);
      const rows = flatList.map((f) => ordered.map((k) => visCell(k, f[k])));
      btn.textContent = '生成文件…';
      const r = await saveTable(header, rows, `访客数据_${nameStamp()}`, '访客数据-自用');
      ingest('visitor', r.name, header, rows);
      const tip = `已导出访客 ${rows.length} 条（${String(r.kind).toUpperCase()}）· 文件名：${r.name}` + (r.ok ? '' : ` · 下载异常：${r.error}`);
      toast(tip);
      setStatus(`上次导出：${tip}`);
    } catch (e) {
      toast('导出访客失败：' + e.message, true);
      console.error(e);
    } finally { btn.disabled = false; btn.textContent = label; }
  }

  async function exportChat(startDate, endDate, btn) {
    btn.disabled = true; btn.textContent = '导出中…';
    try {
      const rows = await collectChats(startDate, endDate, (done, n) => { btn.textContent = `聊天 ${done} 会话 / ${n} 条…`; });
      btn.textContent = '生成文件…';
      const r = await saveTable(CHAT_HEADERS, rows, `聊天记录_${nameStamp()}`);
      ingest('chat', r.name, CHAT_HEADERS, rows);
      const tip = `已导出聊天 ${rows.length} 条（${String(r.kind).toUpperCase()}）· 文件名：${r.name}` + (r.ok ? '' : ` · 下载异常：${r.error}`);
      toast(tip);
      setStatus(`上次导出：${tip}` + (r.ok ? `（方式：${r.via || '页面'}）` : ''));
    } catch (e) {
      toast('导出失败：' + e.message, true);
      console.error(e);
    } finally {
      btn.disabled = false; btn.textContent = '导出聊天';
    }
  }

  // 面板底部常驻状态行（导出后显示目标文件名与下载方式，便于诊断）
  function setStatus(text) {
    const el = document.getElementById('ali-status');
    if (el) el.textContent = text;
  }

  // ---------------- AI 模型配置 + 聊天分析 ----------------
  const AI_CFG_KEY = 'aliAiCfg';
  const AI_PRESETS = [
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'qwen', label: '通义千问（阿里）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'glm', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { id: 'custom', label: '自定义', baseUrl: '', model: '' },
  ];
  const loadAiCfg = async () => {
    try { const o = await chrome.storage.local.get(AI_CFG_KEY); return (o && o[AI_CFG_KEY]) || null; } catch (e) { return null; }
  };
  const saveAiCfg = async (cfg) => { try { await chrome.storage.local.set({ [AI_CFG_KEY]: cfg }); } catch (e) { /* ignore */ } };
  // 自定义域名需动态申请主机权限（必须在用户手势里直接调用 request）
  async function ensureAiHost(baseUrl) {
    let origin = '';
    try { origin = new URL(baseUrl).origin + '/*'; } catch (e) { return { ok: false, error: 'Base URL 不合法' }; }
    if (!chrome.permissions) return { ok: true };
    try {
      const has = await chrome.permissions.contains({ origins: [origin] });
      if (has) return { ok: true };
    } catch (e) { return { ok: true }; } // 查不了就当已授权（预设域名本就在 host_permissions 里）
    try {
      const ok = await chrome.permissions.request({ origins: [origin] });
      return ok ? { ok: true } : { ok: false, error: '未授权访问 ' + origin };
    } catch (e) { return { ok: false, error: '该域名需手动授权：' + ((e && e.message) || e) }; }
  }
  async function callAi(messages, opts) {
    const cfg = (opts && opts.cfg) || (await loadAiCfg());
    if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.model) throw new Error('请先配置 AI 模型（点「AI 设置」）');
    const url = String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions';
    const res = await chrome.runtime.sendMessage({
      type: 'aiChat', url,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.3, stream: false }),
    });
    if (!res || !res.ok) {
      const body = String((res && res.text) || '').slice(0, 300);
      const st = res && res.status;
      const tail = body ? '｜服务商返回：' + body : '';
      if (st === 401) throw new Error('401 服务商不认这个密钥：确认「API Key」填的是密钥本身（通常 sk- 开头），且与 Base URL 属于同一家' + tail);
      if (st === 404) throw new Error('404 地址或模型名不对：Base URL 一般以 /v1 结尾，模型名要和服务商一致' + tail);
      if (st === 429) throw new Error('429 限流或余额不足' + tail);
      throw new Error('模型请求失败：' + ((res && (res.error || ('HTTP ' + st))) || '无响应') + tail);
    }
    let j = null;
    try { j = JSON.parse(res.text); } catch (e) { throw new Error('模型返回非 JSON：' + String(res.text).slice(0, 160)); }
    const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!txt) throw new Error('模型返回为空：' + JSON.stringify(j).slice(0, 160));
    return txt;
  }
  // 检测密钥：拉一次 /models。密钥无效会直接 401 —— 比"猜"快得多，也能顺便拿到正确的模型名
  async function listModels(cfg) {
    let host = '';
    try { host = new URL(cfg.baseUrl).host; } catch (e) { throw new Error('Base URL 不合法'); }
    const url = String(cfg.baseUrl).replace(/\/+$/, '') + '/models';
    const res = await chrome.runtime.sendMessage({
      type: 'aiChat', method: 'GET', url,
      headers: { 'Authorization': 'Bearer ' + cfg.apiKey },
    });
    if (!res || !res.ok) {
      const body = String((res && res.text) || '').slice(0, 200);
      const st = res && res.status;
      if (st === 401) throw new Error('密钥无效：' + host + ' 不认这个密钥 —— 到该平台重新生成一个再粘贴（注意别跨家混用，如 DeepSeek 的 key 配通义的地址）' + (body ? '｜' + body : ''));
      throw new Error('检测失败：HTTP ' + st + (body ? '｜' + body : ''));
    }
    let j = null;
    try { j = JSON.parse(res.text); } catch (e) { throw new Error('返回非 JSON：' + String(res.text).slice(0, 120)); }
    return ((j && j.data) || []).map((m) => m && m.id).filter(Boolean);
  }
  async function openAiSettings() {
    closeFeaturePanels('ali-ai-box');
    const old = document.getElementById('ali-ai-box');
    if (old) { old.remove(); return; }
    const cur = (await loadAiCfg()) || AI_PRESETS[0];
    const box = document.createElement('div');
    box.id = 'ali-ai-box';
    box.style.cssText = 'position:fixed;right:16px;top:56px;z-index:2147483001;width:min(430px,92vw);background:#fff;' +
      'border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.18);padding:14px;' +
      'font:13px/1.6 "Microsoft YaHei",sans-serif;color:#111;';
    box.innerHTML =
      '<div style="display:flex;align-items:center;margin-bottom:6px;"><b style="flex:1;">AI 模型配置</b>' +
      '<button id="ali-ai-close" style="border:0;background:#f3f4f6;border-radius:6px;padding:3px 8px;cursor:pointer;">关闭</button></div>' +
      '<div id="ali-ai-cur" style="margin-bottom:9px;color:#6b7280;font-size:11.5px;line-height:1.5;word-break:break-all;"></div>' +
      '<div style="margin-bottom:8px;">预设<select id="ali-ai-preset" style="width:100%;padding:4px;box-sizing:border-box;">' +
      AI_PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('') + '</select></div>' +
      '<div style="margin-bottom:8px;">Base URL<input id="ali-ai-url" style="width:100%;padding:5px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;">' +
      '<div style="color:#9ca3af;font-size:11px;">服务商接口地址，如 https://api.deepseek.com/v1</div></div>' +
      '<div style="margin-bottom:8px;">API Key<input id="ali-ai-key" type="password" placeholder="sk-..." style="width:100%;padding:5px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;">' +
      '<div style="color:#9ca3af;font-size:11px;">密钥本身，通常以 sk- 开头（<b>不是</b>网址）</div></div>' +
      '<div style="margin-bottom:10px;">模型名<input id="ali-ai-model" list="ali-ai-models" style="width:100%;padding:5px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;">' +
      '<datalist id="ali-ai-models"></datalist>' +
      '<div style="color:#9ca3af;font-size:11px;">如 deepseek-chat / qwen-plus（点「检测密钥」可拉取该家的可用模型名）</div></div>' +
      '<div style="display:flex;gap:8px;">' +
      '<button id="ali-ai-save" style="flex:1;border:0;border-radius:8px;background:#2563eb;color:#fff;padding:7px;cursor:pointer;">保存</button>' +
      '<button id="ali-ai-test" style="flex:1;border:1px solid #d1d5db;border-radius:8px;background:#fff;padding:7px;cursor:pointer;">测试连接</button>' +
      '<button id="ali-ai-check" style="flex:1;border:1px solid #d1d5db;border-radius:8px;background:#fff;padding:7px;cursor:pointer;">检测密钥</button></div>' +
      '<button id="ali-ai-copy" style="width:100%;margin-top:6px;border:1px solid #bfdbfe;border-radius:8px;background:#eff6ff;color:#1d4ed8;padding:6px;cursor:pointer;">复制配置（备份／换电脑用）</button>' +
      '<div id="ali-ai-msg" style="margin-top:8px;color:#6b7280;font-size:12px;word-break:break-all;">Key 只存在本机（chrome.storage.local），不会上传。</div>';
    document.body.appendChild(box);
    const $ = (id) => box.querySelector('#' + id);
    const presetOf = (id) => AI_PRESETS.find((p) => p.id === id) || AI_PRESETS[0];
    const matched = AI_PRESETS.find((p) => p.baseUrl && p.baseUrl === cur.baseUrl);
    $('ali-ai-preset').value = matched ? matched.id : 'custom';
    $('ali-ai-url').value = cur.baseUrl || '';
    $('ali-ai-key').value = cur.apiKey || '';
    $('ali-ai-model').value = cur.model || '';
    // 「当前生效」自查行：Key 若被填成网址，这里会直接标红（最常见 401 原因）
    const maskKey = (k) => (!k ? '未填' : (k.length > 10 ? k.slice(0, 6) + '…' + k.slice(-4) : '已填'));
    const curLine = () => {
      const k = ($('ali-ai-key').value || '').trim();
      let html = '当前生效：' + ($('ali-ai-url').value || '未填') + ' · 模型 ' + ($('ali-ai-model').value || '未填') + ' · Key ' + maskKey(k);
      if (/^https?:\/\//i.test(k)) html += '<br><span style="color:#b91c1c;">⚠️ API Key 里是网址 —— 密钥（sk- 开头）填 API Key，网址填 Base URL，否则会一直 401</span>';
      $('ali-ai-cur').innerHTML = html;
    };
    curLine();
    ['ali-ai-url', 'ali-ai-key', 'ali-ai-model'].forEach((id) => { $(id).oninput = curLine; });
    $('ali-ai-preset').onchange = () => {
      const p = presetOf($('ali-ai-preset').value);
      if (p.baseUrl) { $('ali-ai-url').value = p.baseUrl; $('ali-ai-model').value = p.model; }
    };
    $('ali-ai-close').onclick = () => box.remove();
    const readForm = () => ({ baseUrl: $('ali-ai-url').value.trim(), apiKey: $('ali-ai-key').value.trim(), model: $('ali-ai-model').value.trim() });
    $('ali-ai-save').onclick = async () => {
      const cfg = readForm();
      if (!cfg.baseUrl || !cfg.model) { $('ali-ai-msg').textContent = 'Base URL 和模型名必填'; return; }
      if (/^https?:\/\//i.test(cfg.apiKey)) {
        $('ali-ai-msg').innerHTML = '<span style="color:#b91c1c;">API Key 里填的是网址：请把密钥（通常 sk- 开头）填到「API Key」，把网址填到「Base URL」</span>';
        return;
      }
      const perm = await ensureAiHost(cfg.baseUrl);
      if (!perm.ok) { $('ali-ai-msg').textContent = perm.error; return; }
      await saveAiCfg(cfg);
      curLine();
      $('ali-ai-msg').textContent = '已保存 ✅ 建议点「测试连接」验证一下';
      toast('AI 模型配置已保存');
    };
    $('ali-ai-test').onclick = async () => {
      const cfg = readForm();
      $('ali-ai-msg').textContent = '测试中…';
      try {
        const perm = await ensureAiHost(cfg.baseUrl);
        if (!perm.ok) throw new Error(perm.error);
        const t = await callAi([{ role: 'user', content: '请只回复两个字：你好' }], { cfg });
        $('ali-ai-msg').textContent = '连接成功：' + String(t).slice(0, 60);
      } catch (e) { $('ali-ai-msg').textContent = '失败：' + e.message; }
    };
    // 检测密钥：命中 401 就能确定是密钥问题，同时把该家的可用模型名拉出来可选
    $('ali-ai-check').onclick = async () => {
      const cfg = readForm();
      $('ali-ai-msg').textContent = '检测中…';
      try {
        const perm = await ensureAiHost(cfg.baseUrl);
        if (!perm.ok) throw new Error(perm.error);
        const models = await listModels(cfg);
        $('ali-ai-models').innerHTML = models.map((m) => '<option value="' + m + '"></option>').join('');
        const hit = models.indexOf(cfg.model) >= 0;
        $('ali-ai-msg').innerHTML = '<span style="color:#047857;">密钥有效 ✅ 该家共 ' + models.length + ' 个模型：'
          + models.slice(0, 10).join(' / ') + (models.length > 10 ? ' …' : '') + '</span>'
          + (hit ? '' : '<br><span style="color:#b45309;">当前模型「' + cfg.model + '」不在列表里，改成上面其中一个再保存</span>');
      } catch (e) {
        $('ali-ai-msg').innerHTML = '<span style="color:#b91c1c;">' + e.message + '</span>';
      }
    };
    // 复制配置（纯本地剪贴板，不走网络）：用于备份 / 换电脑时粘贴
    $('ali-ai-copy').onclick = () => {
      const cfg = readForm();
      const text = JSON.stringify(cfg, null, 2);
      const done = () => { $('ali-ai-msg').textContent = '已复制 ✅ 可粘到别处备份（数据看板「设置」与这里共用同一份配置）'; };
      navigator.clipboard.writeText(text).then(done).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { $('ali-ai-msg').textContent = '复制失败，请手动复制：' + text; }
        ta.remove();
      });
    };
  }

  // ---------------- AI 聊天分析（流式对话） ----------------
  // 流式走后台长连接 Port：内容脚本直连模型会撞 CORS / 私网限制，sendMessage 又是一次性的
  function openAiStream(messages, onDelta, cfg) {
    const port = chrome.runtime.connect({ name: 'aiStream' });
    let full = '';
    let settled = false;
    const promise = new Promise((resolve, reject) => {
      port.onMessage.addListener((m) => {
        if (!m || settled) return;
        if (m.type === 'delta') { full += m.text; onDelta(m.text); }
        else if (m.type === 'done') { settled = true; try { port.disconnect(); } catch (e) { /* ignore */ } resolve(full); }
        else if (m.type === 'error') { settled = true; try { port.disconnect(); } catch (e) { /* ignore */ } reject(new Error(m.error)); }
      });
      port.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true;
        if (full) resolve(full); else reject(new Error('连接中断（后台被回收或网络异常）'));
      });
    });
    port.postMessage({
      type: 'aiStream',
      url: String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.3, stream: true }),
    });
    return { promise, abort: () => { try { port.postMessage({ type: 'abort' }); } catch (e) { /* ignore */ } } };
  }

  // 系统噪声（卡片链接 / JSON 载荷 / 平台公告）——不进模型上下文，省 token 也更准
  function isChatNoise(s) {
    const t = String(s || '').trim();
    if (!t) return true;
    if (/^https?:\/\//i.test(t)) return true;
    if (t.indexOf('workspace.alibaba.com/card') >= 0) return true;
    if (t.indexOf('":') >= 0) return true;
    if (t.charAt(0) === '{' || t.charAt(0) === '[') return true;
    if (t.indexOf('翻译功能升级') >= 0 || t.indexOf('Reply Card helps') >= 0) return true;
    return false;
  }

  // 聊天行 → 会话分组（行结构：0=发送时间 1=角色 2=发言人 3=内容 4=会话）
  // 紧凑结构（便于持久化）：sessions = [{name, count, msgs:[{t, mine, sys, c}]}]
  function groupChatRows(rows) {
    const bySess = new Map();
    for (const r of rows) {
      const s = String(r[4] || '未知会话');
      if (!bySess.has(s)) bySess.set(s, []);
      const c = String(r[3] || '').replace(/\s+/g, ' ');
      bySess.get(s).push({
        t: String(r[0] || ''),
        mine: String(r[1] || '').indexOf('业务员') >= 0,
        sys: isChatNoise(c),
        c,
      });
    }
    return Array.from(bySess.entries()).map(([name, ms]) => {
      ms.sort((a, b) => a.t.localeCompare(b.t));
      return { name, count: ms.length, msgs: ms };
    }).sort((a, b) => b.count - a.count);
  }

  // 交给模型的上下文：范围 = 全部会话概览 / 单个会话
  function buildChatContext(sessions, scope) {
    const head = '【数据说明】以下是业务员本人阿里国际站账号导出的真实聊天记录。';
    const real = (s) => s.msgs.filter((m) => !m.sys);
    if (scope && scope.indexOf('session:') === 0) {
      const name = scope.slice(8);
      const s = sessions.find((x) => x.name === name);
      if (!s) return head + '（未找到会话 ' + name + '）';
      const ms = real(s).slice(-60);
      return [head + '会话：' + name + '（共 ' + s.count + ' 条'
        + (ms.length ? '，下面给最近 ' + ms.length + ' 条有效对话）' : '，均为系统卡片消息，无有效文本）')]
        .concat(ms.map((m) => m.t + (m.mine ? ' 我：' : ' 客户：') + m.c.slice(0, 240))).join('\n');
    }
    const total = sessions.reduce((n, x) => n + x.count, 0);
    const out = [head + '共 ' + sessions.length + ' 个会话 / ' + total + ' 条消息。',
      '【会话清单（按消息数排序，最多 30 个）】'];
    sessions.slice(0, 30).forEach((s) => {
      const rs = real(s);
      const first = rs.find((m) => !m.mine) || rs[0] || { c: '' };
      const last = rs[rs.length - 1] || { t: '' };
      out.push('- [' + s.name + '] ' + s.count + ' 条｜' + ((rs[0] || {}).t || '') + ' ~ ' + last.t + '｜客户首条：' + first.c.slice(0, 90));
    });
    sessions.slice(0, 4).forEach((s) => {
      const ms = real(s).slice(-12);
      if (!ms.length) return;
      out.push('', '=== 会话：' + s.name + '（最近 ' + ms.length + ' 条）===');
      ms.forEach((m) => out.push(m.t + (m.mine ? ' 我：' : ' 客户：') + m.c.slice(0, 200)));
    });
    return out.join('\n');
  }

  const AI_HIST_KEY = 'aliChatAnalysis';   // 对话记录持久化：下次打开直接恢复，不重新开始

  // 功能面板互斥：同一时间只保留一个，避免 AI 分析面板盖住婉拒面板
  function closeFeaturePanels(exceptId) {
    ['ali-ai-box', 'ali-dt-box', 'ali-expo-box'].forEach((id) => {
      if (exceptId && id === exceptId) return;
      const el = document.getElementById(id);
      if (el) el.remove();
    });
  }

  async function openChatAnalysis(startDate, endDate) {
    closeFeaturePanels('ali-ai-box');
    const old = document.getElementById('ali-ai-box');
    if (old) { old.remove(); return; }
    const cfg = await loadAiCfg();
    if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.model) { toast('请先点「AI 设置」配置模型', true); return; }
    const box = document.createElement('div');
    box.id = 'ali-ai-box';
    box.style.cssText = 'position:fixed;right:16px;top:48px;z-index:2147483001;width:min(720px,96vw);height:min(780px,90vh);' +
      'display:flex;flex-direction:column;background:#fff;border:1px solid #e5e7eb;border-radius:12px;' +
      'box-shadow:0 10px 40px rgba(0,0,0,.18);font:13px/1.6 "Microsoft YaHei",sans-serif;color:#111;overflow:hidden;';
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:7px;padding:9px 12px;border-bottom:1px solid #f0f0f0;">' +
      '<b style="white-space:nowrap;">AI 聊天分析</b>' +
      '<span id="ali-ai-prog" style="color:#6b7280;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">准备中…</span>' +
      '<span style="flex:1"></span>' +
      '<button id="ali-ai-toggle" style="border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;white-space:nowrap;">收起 ▴</button>' +
      '<button id="ali-ai-copy2" style="border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;">复制</button>' +
      '<button id="ali-ai-exp" style="border:0;background:#4f46e5;color:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;">导出</button>' +
      '<button id="ali-ai-close2" style="border:0;background:#f3f4f6;border-radius:6px;padding:3px 8px;cursor:pointer;">关闭</button></div>' +
      '<div id="ali-ai-body" style="flex:1;min-height:0;display:flex;flex-direction:column;">' +
      '<div style="display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid #f5f5f5;background:#fafafa;">' +
      '<span style="color:#6b7280;font-size:12px;white-space:nowrap;">分析范围</span>' +
      '<select id="ali-ai-scope" style="flex:1;min-width:110px;padding:4px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;"></select>' +
      '<span id="ali-ai-ctx" style="color:#9ca3af;font-size:11px;white-space:nowrap;"></span>' +
      '<button id="ali-ai-again" style="border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;white-space:nowrap;">重新分析</button>' +
      '<button id="ali-ai-recollect" style="border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;white-space:nowrap;">重新采集</button>' +
      '<button id="ali-ai-wipe" style="border:1px solid #fca5a5;background:#fff;color:#b91c1c;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;white-space:nowrap;">清空记录</button></div>' +
      '<div id="ali-ai-log" style="flex:1;overflow:auto;padding:12px 14px;background:#fff;"></div>' +
      '<div style="border-top:1px solid #f0f0f0;padding:8px 12px;display:flex;gap:8px;align-items:flex-end;">' +
      '<textarea id="ali-ai-in" placeholder="继续追问，例如：这个客户该怎么回？（Enter 发送，Shift+Enter 换行）" ' +
      'style="flex:1;min-height:54px;max-height:140px;padding:8px;border:1px solid #d1d5db;border-radius:8px;font:12.5px/1.6 inherit;resize:vertical;box-sizing:border-box;"></textarea>' +
      '<button id="ali-ai-send" style="border:0;background:#2563eb;color:#fff;border-radius:8px;padding:8px 13px;cursor:pointer;white-space:nowrap;">发送</button>' +
      '<button id="ali-ai-stop" style="border:1px solid #d1d5db;background:#fff;border-radius:8px;padding:8px 11px;cursor:pointer;white-space:nowrap;" disabled>停止</button></div>' +
      '</div>' +
      '<div id="ali-ai-mini" style="display:none;padding:7px 12px;color:#6b7280;font-size:12px;"></div>';
    document.body.appendChild(box);
    const $ = (id) => box.querySelector('#' + id);
    const log = $('ali-ai-log');
    const prog = (t) => { const el = $('ali-ai-prog'); if (el) el.textContent = t; };

    let sessions = [];
    let hist = [];
    let busy = false;
    let collapsed = false;
    let cur = null;

    const rounds = () => hist.filter((m) => m.role === 'assistant').length;
    const scopeLabel = () => (($('ali-ai-scope').value || '').indexOf('session:') === 0)
      ? ('会话「' + $('ali-ai-scope').value.slice(8) + '」') : '全部会话概览';
    const addMsg = (role, text) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:10px;';
      const meta = document.createElement('div');
      meta.textContent = role === 'user' ? '我' : 'AI';
      meta.style.cssText = 'font-size:11px;color:#9ca3af;margin-bottom:2px;';
      const body = document.createElement('div');
      body.textContent = text || '';
      body.style.cssText = 'white-space:pre-wrap;word-break:break-word;padding:8px 11px;border-radius:9px;font-size:12.5px;line-height:1.66;' +
        (role === 'user' ? 'background:#eff6ff;color:#1e3a8a;' : 'background:#f7f8fa;border:1px solid #eef1f4;');
      wrap.appendChild(meta); wrap.appendChild(body);
      log.appendChild(wrap);
      log.scrollTop = log.scrollHeight;
      return body;
    };
    const renderHist = () => { log.innerHTML = ''; hist.forEach((m) => addMsg(m.role, m.content)); };
    const fillScope = (want) => {
      const total = sessions.reduce((n, s) => n + s.count, 0);
      $('ali-ai-scope').innerHTML = [['', '全部会话概览（' + sessions.length + ' 个会话 / ' + total + ' 条）']]
        .concat(sessions.slice(0, 200).map((s) => ['session:' + s.name, '会话 · ' + s.name + '（' + s.count + ' 条）']))
        .map(([v, t]) => '<option value="' + String(v).replace(/"/g, '&quot;') + '">' + String(t).replace(/</g, '&lt;') + '</option>').join('');
      if (want) {
        const has = Array.prototype.some.call($('ali-ai-scope').options, (o) => o.value === want);
        $('ali-ai-scope').value = has ? want : '';
      }
    };
    const refreshCtx = () => {
      $('ali-ai-ctx').textContent = sessions.length ? ('约 ' + buildChatContext(sessions, $('ali-ai-scope').value).length + ' 字数据') : '';
    };
    const saveState = async () => {
      try {
        await chrome.storage.local.set({ [AI_HIST_KEY]: {
          ts: localStamp(), range: [startDate || '', endDate || ''],
          scope: $('ali-ai-scope').value, collapsed, hist, sessions,
        } });
      } catch (e) { /* 存不下也不影响本次使用 */ }
    };
    const loadState = async () => {
      try { const o = await chrome.storage.local.get(AI_HIST_KEY); return o && o[AI_HIST_KEY]; } catch (e) { return null; }
    };
    const setCollapsed = (v) => {
      collapsed = !!v;
      $('ali-ai-body').style.display = collapsed ? 'none' : 'flex';
      $('ali-ai-mini').style.display = collapsed ? 'block' : 'none';
      $('ali-ai-toggle').textContent = collapsed ? '展开 ▾' : '收起 ▴';
      box.style.height = collapsed ? 'auto' : 'min(780px,90vh)';
      box.style.width = collapsed ? '330px' : 'min(720px,96vw)';
      if (collapsed) {
        $('ali-ai-mini').textContent = rounds()
          ? ('已保留 ' + rounds() + ' 轮对话 · 点「展开」继续追问') : '点「展开」开始分析';
      }
    };
    const setBtns = () => {
      $('ali-ai-send').disabled = busy;
      $('ali-ai-send').textContent = busy ? '生成中…' : '发送';
      $('ali-ai-stop').disabled = !busy;
      $('ali-ai-again').disabled = busy;
      $('ali-ai-recollect').disabled = busy;
    };

    const ask = async (text) => {
      text = String(text || '').trim();
      if (!text || busy || !sessions.length) return;
      hist.push({ role: 'user', content: text });
      addMsg('user', text);
      const body = addMsg('assistant', '生成中…');
      busy = true; setBtns();
      let full = '';
      try {
        const sys = '你是资深外贸业务顾问，服务在阿里国际站开店的中国供应商。'
          + '只依据下面提供的真实聊天记录回答，不要编造；数据不足时说明还缺什么。中文、结论先行，话术要能直接用。\n\n'
          + '当前分析范围：' + scopeLabel() + '\n\n' + buildChatContext(sessions, $('ali-ai-scope').value);
        cur = openAiStream([{ role: 'system', content: sys }].concat(hist.slice(-12)), (d) => {
          if (!full) body.textContent = '';
          full += d; body.textContent += d; log.scrollTop = log.scrollHeight;
        }, cfg);
        await cur.promise;
        if (full) hist.push({ role: 'assistant', content: full });
        prog('完成 ✅（' + rounds() + ' 轮）');
      } catch (e) {
        if (full) hist.push({ role: 'assistant', content: full });
        else { body.textContent = '失败：' + e.message; body.style.color = '#b91c1c'; }
        prog('失败：' + e.message);
      } finally {
        busy = false; cur = null; setBtns(); saveState();
        if (collapsed) { $('ali-ai-mini').textContent = '已保留 ' + rounds() + ' 轮对话 · 点「展开」继续追问'; }
      }
    };
    const runAnalysis = () => {
      hist = [];
      renderHist();
      saveState();
      prog('分析中…');
      ask('先做整体分析：逐个会话给出【客户与需求摘要 / 意向等级(高·中·低)及理由 / 关键需求与痛点 / 风险与异议 / 下一步跟进建议】，'
        + '最后给出本周重点跟进客户清单（按优先级排序）与 2-3 条话术改进建议。');
    };
    const conversationText = () => hist.map((m) => (m.role === 'user' ? '我：' : 'AI：') + m.content).join('\n\n');

    const collectAndAnalyze = async () => {
      try {
        prog('采集聊天记录…');
        const rows = await collectChats(startDate, endDate, (done, n) => prog(`聊天 ${done} 会话 / ${n} 条…`));
        if (!rows.length) { prog('该时间段没有聊天记录'); return; }
        sessions = groupChatRows(rows);
        fillScope('');
        refreshCtx();
        prog('已采集 ' + rows.length + ' 条，开始分析…');
        runAnalysis();
      } catch (e) {
        prog('采集失败（需在聊天页操作）：' + e.message);
      }
    };

    $('ali-ai-toggle').onclick = () => { setCollapsed(!collapsed); saveState(); };
    $('ali-ai-close2').onclick = () => { if (cur) cur.abort(); saveState(); box.remove(); };
    $('ali-ai-scope').onchange = () => { refreshCtx(); saveState(); };
    $('ali-ai-again').onclick = () => { if (!busy && sessions.length) runAnalysis(); };
    $('ali-ai-recollect').onclick = () => { if (!busy) collectAndAnalyze(); };
    $('ali-ai-wipe').onclick = async () => {
      if (busy) return;
      hist = []; sessions = []; renderHist(); fillScope(''); refreshCtx();
      try { await chrome.storage.local.remove(AI_HIST_KEY); } catch (e) { /* ignore */ }
      prog('已清空，可点「重新采集」');
    };
    $('ali-ai-stop').onclick = () => { if (cur) cur.abort(); };
    $('ali-ai-copy2').onclick = () => {
      const v = conversationText();
      if (!v) { toast('还没有内容', true); return; }
      navigator.clipboard.writeText(v).then(() => toast('已复制对话')).catch(() => toast('复制失败', true));
    };
    $('ali-ai-exp').onclick = async (e) => {
      const v = hist.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n\n');
      if (!v) { toast('还没有分析结果', true); return; }
      const b = e.target; b.disabled = true;
      try {
        const r = await saveTable(['分析报告'], v.split('\n').map((l) => [l]), `AI聊天分析_${nameStamp()}`, 'AI分析-自用');
        toast(`已导出（${String(r.kind).toUpperCase()}）· ${r.name}`);
      } catch (err) { toast('导出失败：' + err.message, true); }
      finally { b.disabled = false; }
    };
    const submit = () => { const t = $('ali-ai-in').value; $('ali-ai-in').value = ''; ask(t); };
    $('ali-ai-send').onclick = submit;
    $('ali-ai-in').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } };
    setBtns();

    // 有历史记录 → 直接恢复，不重新采集 / 不重新分析
    const saved = await loadState();
    if (saved && saved.hist && saved.hist.length && saved.sessions && saved.sessions.length) {
      hist = saved.hist;
      sessions = saved.sessions;
      fillScope(saved.scope);
      renderHist();
      refreshCtx();
      setCollapsed(!!saved.collapsed);
      prog('已恢复 ' + (saved.ts || '上次') + ' 的对话（' + rounds() + ' 轮）｜数据范围 ' + ((saved.range || []).join(' ~ ') || '—'));
      return;
    }
    await collectAndAnalyze();
  }

  // ---------------- UI ----------------
  function toast(msg, isErr) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:2147483001;
      background:${isErr ? '#e8463a' : '#1f2937'};color:#fff;padding:10px 18px;border-radius:8px;
      font:13px/1.5 "Microsoft YaHei",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:70vw;`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), isErr ? 6000 : 3000);
  }
  function todayStr(offset) {
    const d = new Date(Date.now() + (offset || 0) * 86400000);
    return d.toISOString().slice(0, 10);
  }

  // ---------------- 跨页面路由（统一工作台：点功能 → 跳到对应页 → 落地再点一次执行） ----------------
  const PENDING_KEY = 'aliPendingExport';
  // 工作台功能表：url=目标页地址（null=不限页面）；to=目标页显示名；date=需要时间范围；fields=客户类可选时间字段
  // group='tool' 的功能收纳在「更多工具」里
  const MSG_PAGE = 'https://message.alibaba.com/message/default.htm';
  const CHAT_PAGE = 'https://onetalk.alibaba.com/message/messageManager.htm#/';
  const WORKBENCH = [
    { id: 'inquiry', label: '询盘导出', url: MSG_PAGE, to: '询盘页', date: true, hint: '导出询盘列表（自动补全客户信息）' },
    { id: 'invview', label: '询盘增强', url: MSG_PAGE, to: '询盘页', date: true, hint: '先采集，再按国家/去重筛选后导出' },
    { id: 'chat', label: '聊天导出', url: CHAT_PAGE, to: '聊天页', date: true, hint: '导出指定时间段的聊天记录' },
    { id: 'aianalysis', label: '聊天分析（AI）', url: CHAT_PAGE, to: '聊天页', date: true, hint: '流式分析该时间段聊天，可实时追问' },
    { id: 'crmmine', label: '客户导出 · 我的客户', url: 'https://i.alibaba.com/hub/alicrm/my_customer', to: '我的客户列表', date: true, fields: [['createDate', '创建时间'], ['pickUpDate', '领取时间']] },
    { id: 'crmpub', label: '客户导出 · 公海', url: 'https://i.alibaba.com/hub/alicrm/public_customer', to: '公海客户列表', date: true, fields: [['createDate', '创建时间'], ['openTime', '进入公海时间']] },
    { id: 'visitors', label: '访客导出', url: 'https://data.alibaba.com/marketing/visitor', to: '访客页', date: true, hint: '单次范围建议不超过 30 天' },
    { id: 'aicfg', label: 'AI 设置（模型）', url: null, group: 'tool' },
  ];
  const fnById = (id) => WORKBENCH.find((f) => f.id === id) || null;
  // 页面归一化：只比 host + path（忽略 hash / query / 末尾斜杠）
  const pageKey = (u) => {
    try { const x = new URL(u, location.href); return x.host + x.pathname.replace(/\/+$/, ''); } catch (e) { return ''; }
  };
  const onTarget = (fn) => {
    if (!fn || !fn.url) return true;
    const t = pageKey(fn.url); const c = pageKey(location.href);
    return c === t || c.indexOf(t + '/') === 0; // 相等或位于该页面子路径下
  };

  async function runAction(id, start, end, dateField, btn) {
    switch (id) {
      case 'inquiry': return exportInquiry(start, end, btn);
      case 'invview': return openInquiryView(start, end, btn);
      case 'chat': return exportChat(start, end, btn);
      case 'aianalysis': return openChatAnalysis(start, end);
      case 'crmmine': return exportCustomers(btn, 'mine', start, end, dateField);
      case 'crmpub': return exportCustomers(btn, 'public', start, end, dateField);
      case 'visitors': return exportVisitors(start, end, btn);
      case 'aicfg': return openAiSettings();
    }
  }

  const stashPending = async (payload) => {
    try { await chrome.storage.local.set({ [PENDING_KEY]: Object.assign({ ts: Date.now() }, payload) }); } catch (e) { /* ignore */ }
  };
  const peekPending = async () => {
    try { const o = await chrome.storage.local.get(PENDING_KEY); return (o && o[PENDING_KEY]) || null; } catch (e) { return null; }
  };
  const clearPending = async () => {
    try { await chrome.storage.local.remove(PENDING_KEY); } catch (e) { /* ignore */ }
  };
  // 跳到目标页后：回填时间/功能并展开面板，**不自动执行**，等用户再点一次「执行导出」
  async function maybeAutoRun() {
    const p = await peekPending();
    if (!p) return;
    if (Date.now() - (p.ts || 0) > 5 * 60 * 1000) { await clearPending(); return; } // 超时作废
    const fn = fnById(p.action);
    if (!fn || !onTarget(fn)) return;
    await clearPending();
    expandPanel();
    fillForm(p);
    toast(`已切换到「${fn.label}」所在页面，点「执行导出」开始`);
  }

  let wbSelected = 'inquiry'; // 当前选中的功能

  // 高亮选中项，并按功能切换「时间字段/时间范围」的显隐与提示
  function selectFn(id) {
    wbSelected = id;
    const box = document.getElementById('ali-export-panel');
    if (!box) return;
    const fn = fnById(id) || {};
    box.querySelectorAll('[data-fn]').forEach((el) => {
      const on = el.getAttribute('data-fn') === id;
      el.style.background = on ? '#eff6ff' : '#fff';
      el.style.borderColor = on ? '#93c5fd' : '#e5e7eb';
      el.style.fontWeight = on ? '600' : '400';
    });
    const wrap = box.querySelector('#ali-datefield-wrap');
    const sel = box.querySelector('#ali-datefield');
    if (wrap && sel) {
      if (fn.fields && fn.fields.length) {
        const keep = sel.value;
        sel.innerHTML = fn.fields.map((f) => `<option value="${f[0]}">${f[1]}</option>`).join('');
        if (fn.fields.some((f) => f[0] === keep)) sel.value = keep;
        wrap.style.display = 'flex';
      } else { wrap.style.display = 'none'; }
    }
    const needDate = !!(fn.date || (fn.fields && fn.fields.length));
    const dr = box.querySelector('#ali-date-row'); if (dr) dr.style.display = needDate ? 'flex' : 'none';
    const qr = box.querySelector('#ali-quick-row'); if (qr) qr.style.display = needDate ? 'flex' : 'none';
    const hint = box.querySelector('#ali-fn-hint');
    if (hint) hint.textContent = '当前功能：' + (fn.label || '') + '｜' + (fn.hint || '')
      + ((fn.url && !onTarget(fn)) ? `（将跳转到「${fn.to}」，到达后需再点一次「执行导出」）` : '');
    const run = box.querySelector('#ali-btn-run');
    if (run) run.textContent = fn.group === 'tool' ? '执行' : '执行导出';
  }

  function fillForm(p) {
    const si = document.getElementById('ali-start'); const ei = document.getElementById('ali-end');
    if (si && p.start) si.value = p.start;
    if (ei && p.end) ei.value = p.end;
    if (p.action) selectFn(p.action);
    if (p.dateField) { const sel = document.getElementById('ali-datefield'); if (sel) sel.value = p.dateField; }
  }

  function mountPanel() {
    if (document.getElementById('ali-export-panel')) return;
    const box = document.createElement('div');
    box.id = 'ali-export-panel';
    box.style.cssText = `position:fixed;left:16px;top:80px;z-index:2147483000;background:#fff;
      border:1px solid #e5e7eb;border-radius:12px;padding:14px;box-shadow:0 6px 24px rgba(0,0,0,.12);
      font:13px "Microsoft YaHei",sans-serif;width:300px;max-height:88vh;overflow:auto;box-sizing:border-box;`;
    const fnBtn = (f) => `<button data-fn="${f.id}" style="width:100%;text-align:left;padding:7px 10px;margin-bottom:6px;
      border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer;font-size:12px;color:#1f2937;">${f.label}${(f.url && !onTarget(f)) ? ` <span style="color:#9ca3af;font-weight:400;">→${f.to}</span>` : ''}</button>`;
    const qb = 'flex:1;padding:4px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:11px;color:#374151;';
    const main = WORKBENCH.filter((f) => f.group !== 'tool');
    const tools = WORKBENCH.filter((f) => f.group === 'tool');
    box.innerHTML = `
      <div style="display:flex;align-items:center;margin-bottom:10px;">
        <span style="font-weight:600;color:#111;flex:1;">外贸智能助手 · 工作台<span style="font-weight:400;color:#9ca3af;font-size:11px;"> v${VERSION}</span></span>
        <button id="ali-collapse" style="border:0;background:#f3f4f6;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;color:#374151;">收起</button>
      </div>
      <div id="ali-date-row" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
        <input id="ali-start" type="date" value="${todayStr(-6)}" style="flex:1;min-width:0;padding:5px;border:1px solid #d1d5db;border-radius:6px;">
        <span style="color:#9ca3af;">~</span>
        <input id="ali-end" type="date" value="${todayStr(0)}" style="flex:1;min-width:0;padding:5px;border:1px solid #d1d5db;border-radius:6px;">
      </div>
      <div id="ali-quick-row" style="display:flex;gap:6px;margin-bottom:8px;">
        <button data-quick="1" style="${qb}">今天</button>
        <button data-quick="7" style="${qb}">近7天</button>
        <button data-quick="30" style="${qb}">近30天</button>
        <button data-quick="all" style="${qb}">全部</button>
      </div>
      <div id="ali-datefield-wrap" style="display:none;align-items:center;gap:6px;margin-bottom:8px;">
        <span style="color:#6b7280;font-size:11px;white-space:nowrap;">按</span>
        <select id="ali-datefield" style="flex:1;padding:4px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;"></select>
        <span style="color:#6b7280;font-size:11px;white-space:nowrap;">筛选</span>
      </div>
      <div id="ali-here" style="color:#6b7280;font-size:11px;margin-bottom:6px;word-break:break-all;">当前页：<b>${escHtml(location.host + location.pathname)}</b><br>带 <b>→</b> 的功能会先跳到目标页</div>
      <div id="ali-fns">${main.map(fnBtn).join('')}</div>
      <div id="ali-fn-hint" style="color:#6b7280;font-size:11px;line-height:1.5;margin:4px 0 8px;min-height:14px;"></div>
      <button id="ali-btn-run" style="width:100%;padding:9px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer;font-weight:600;">执行导出</button>
      <div id="ali-status" style="margin-top:8px;color:#374151;font-size:11px;line-height:1.5;word-break:break-all;"></div>
      <button id="ali-btn-platform" style="width:100%;margin-top:10px;padding:8px;border:1px solid #bfdbfe;border-radius:8px;background:#eff6ff;color:#1d4ed8;cursor:pointer;font-size:12px;">打开数据看板 ↗</button>
      <div style="margin-top:4px;color:#9ca3af;font-size:10.5px;text-align:center;">导出成功会自动入库 · 数据只在本机浏览器</div>
      <details style="margin-top:10px;">
        <summary style="cursor:pointer;color:#6b7280;font-size:12px;">更多工具</summary>
        <div style="margin-top:8px;">${tools.map(fnBtn).join('')}</div>
      </details>
      <div style="margin-top:8px;color:#9ca3af;font-size:11px;">仅导出本人账号数据 · 时间范围越久越慢</div>
    `;
    document.body.appendChild(box);
    const start = () => { const el = document.getElementById('ali-start'); return el ? el.value : ''; };
    const end = () => { const el = document.getElementById('ali-end'); return el ? el.value : ''; };
    const dateField = () => { const el = document.getElementById('ali-datefield'); return el ? el.value : ''; };

    box.querySelectorAll('[data-fn]').forEach((el) => { el.onclick = () => selectFn(el.getAttribute('data-fn')); });
    box.querySelectorAll('[data-quick]').forEach((el) => {
      el.onclick = () => {
        const si = document.getElementById('ali-start'); const ei = document.getElementById('ali-end');
        const v = el.getAttribute('data-quick');
        if (v === 'all') { si.value = ''; ei.value = ''; return; } // 清空 = 不限时间（导出全部）
        const n = parseInt(v, 10) || 1;
        si.value = todayStr(-(n - 1));
        ei.value = todayStr(0);
      };
    });
    document.getElementById('ali-collapse').onclick = () => collapsePanel();
    document.getElementById('ali-btn-platform').onclick = () => {
      chrome.runtime.sendMessage({ type: 'openDashboard' }, () => {
        if (chrome.runtime.lastError) toast('打开看板失败：' + chrome.runtime.lastError.message, true);
      });
    };
    document.getElementById('ali-btn-run').onclick = async (e) => {
      const btn = e.target;
      const fn = fnById(wbSelected);
      if (!fn) return;
      const needJump = !onTarget(fn);
      console.log('[ali-export-ext] run', fn.id, 'url=', location.href, 'target=', fn.url, 'needJump=', needJump);
      const payload = { action: fn.id, start: start(), end: end(), dateField: dateField() };
      if (needJump) { // 不在目标页 → 跳转到该功能对应的页面（落地后再点一次才开始）
        let target = fn.url;
        await stashPending(payload);
        toast(`正在跳转到「${fn.to}」，到达后请再点「执行导出」`);
        location.href = target;
        return;
      }
      await runAction(fn.id, payload.start, payload.end, payload.dateField, btn);
      selectFn(wbSelected); // 还原主按钮文案（导出函数内部会改写它）
    };
    selectFn(wbSelected);
  }

  // 侧边入口（默认只显示这个：logo + 名字，点了才展开完整面板）
  function mountDock() {
    if (document.getElementById('ali-dock') || document.getElementById('ali-export-panel')) return;
    const d = document.createElement('div');
    d.id = 'ali-dock';
    d.style.cssText = `position:fixed;left:0;top:80px;z-index:2147483000;width:64px;padding:10px 6px;
      background:#fff;border:1px solid #e5e7eb;border-left:0;border-radius:0 12px 12px 0;
      box-shadow:0 6px 20px rgba(0,0,0,.12);cursor:pointer;text-align:center;user-select:none;
      font:12px/1.3 "Microsoft YaHei",sans-serif;color:#1f2937;`;
    d.innerHTML =
      '<img src="' + chrome.runtime.getURL('assets/icon-48.png') + '" width="26" height="26" alt="" ' +
      'style="display:block;margin:0 auto 6px;border-radius:7px;">' +
      '<div style="font-weight:600;">智能助手</div>';
    d.onclick = () => expandPanel();
    document.body.appendChild(d);
  }
  function expandPanel() {
    const d = document.getElementById('ali-dock');
    if (d) d.remove();
    if (!document.getElementById('ali-export-panel')) mountPanel();
  }
  function collapsePanel() {
    const p = document.getElementById('ali-export-panel');
    if (p) p.remove();
    mountDock();
  }
  function ensurePanel() {
    if (!document.body) return;
    mountDock(); // 默认只留侧边入口，点开才展开面板
    if (!window.__aliAutoRan) { window.__aliAutoRan = true; maybeAutoRun(); }
    if (!window.__aliExportWatcher) {
      window.__aliExportWatcher = setInterval(() => {
        if (document.body && !document.getElementById('ali-export-panel') && !document.getElementById('ali-dock')) mountDock();
      }, 3000);
    }
  }
  if (document.body) ensurePanel();
  else {
    document.addEventListener('DOMContentLoaded', ensurePanel);
    const t = setInterval(() => { if (document.body) { clearInterval(t); ensurePanel(); } }, 500);
    setTimeout(() => clearInterval(t), 20000);
  }
})();
