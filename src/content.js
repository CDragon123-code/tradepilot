// 内容脚本：在本人国际站页面注入导出面板
// 依据阿里页面自身接口（询盘 subjectList.htm；聊天 onetalk messageManager 系列），独立实现，不参考任何闭源插件代码。
(function () {
  'use strict';
  const VERSION = '0.21.18';
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
  // 列 → 接口字段候选（真实字段名以自检结果为准）
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
  const toTs = (s, endOfDay) => {
    if (!s) return 0;
    if (typeof s === 'number') return s;
    return new Date(String(s) + (endOfDay ? 'T23:59:59' : 'T00:00:00')).getTime();
  };
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

  // 取原始文本（供自检与解析共用）
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
  const rawProfiles = new WeakMap(); // 行对象 -> 原始 buyer/crm（不进导出、不入库，避免体积膨胀）

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
    // 缺少 CRM customerId 不能证明「未加客」；只有平台明确返回 false 才写「否」。
    if ((Object.keys(b).length || Object.keys(c).length) && isEmptyCol(row[COL.addedCustomer])) {
      const added = b.isAddedCustomer === true || b.isCustomer === true || notNA(c.customerId) || notNA(b.customerId);
      const absent = b.isAddedCustomer === false || b.isCustomer === false || c.isAddedCustomer === false;
      if (added || absent) row[COL.addedCustomer] = added ? '是' : '否';
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
    // 原始买家档案 / CRM 记录挂在 WeakMap 上（导出、入库都不会带上，AI 背调按行读取）
    rawProfiles.set(row, { buyer: b, crm: c, contact: contact || null });
    await pace();
    return row;
  }

  // 单条询盘 → 行数组（列序与 INQUIRY_HEADERS 一致，不含补全与兜底填 0）
  function inquiryRowOf(item) {
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
    if (row[6] === true || row[6] === 'true') row[6] = '是';
    if (row[6] === false || row[6] === 'false') row[6] = '否';
    row[11] = fmtDate(row[11]);
    row[18] = fmtDate(row[18]);
    if (!row[3] && item.sender && typeof item.sender === 'string') row[3] = item.sender;
    row[15] = sourceCn(row[15]);
    row[16] = appFromToCn(row[16]);
    row[17] = replyStatusCn(row[17]);
    return row;
  }

  async function collectInquiry(startDate, endDate, onProgress, enrich, onItem, maxPages, enrichLimit, startPage) {
    const rows = [];
    const firstPage = Number(startPage) || 1;
    for (let page = firstPage; page < firstPage + (maxPages || Infinity); page++) {
      const { list } = await fetchInquiryPage(page, startDate, endDate);
      const arr = Array.isArray(list) ? list : [];
      for (const item of arr) {
        const row = inquiryRowOf(item);
        rows.push({ row, item });
        if (enrich && (!enrichLimit || rows.length <= enrichLimit)) { await enrichRow(item, row); if (onItem) onItem(rows.length); }
        // 金额缺失保持未知；只有未联系天数可按现有导出口径补 0。
        if (isEmptyCol(row[19])) row[19] = 0;
      }
      if (onProgress) onProgress(page, rows.length);
      if (arr.length < PAGE_SIZE) break;
      if (maxPages && page >= firstPage + maxPages - 1) {
        rows.truncated = true;
        rows.nextPage = page + 1;
      }
      await pace();
    }
    return rows;
  }

  // 增量按列表的最近联系时间翻页；按创建日期筛选会漏掉旧询盘的新回复。
  async function collectRecentInquiry(since, onProgress, startPage) {
    const rows = [];
    const maxPages = 30;
    const firstPage = Number(startPage) || 1;
    for (let page = firstPage; page < firstPage + maxPages; page++) {
      const { list } = await fetchInquiryPage(page, '', '');
      const arr = Array.isArray(list) ? list : [];
      let hasRecentOrUnknown = false;
      for (const item of arr) {
        const activity = self.AliPlatformJob.inquiryActivity(item);
        if (activity && activity < since) continue;
        hasRecentOrUnknown = true;
        const row = inquiryRowOf(item);
        rows.push({ row, item });
        if (rows.length <= 50) await enrichRow(item, row);
        if (isEmptyCol(row[19])) row[19] = 0;
      }
      if (onProgress) onProgress(page, rows.length);
      if (arr.length < PAGE_SIZE || !hasRecentOrUnknown) break;
      if (page === firstPage + maxPages - 1) {
        rows.truncated = true;
        rows.nextPage = page + 1;
      }
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
  async function collectChats(startDate, endDate, onProgress, maxContacts) {
    const startTs = toTs(startDate, false);
    const endTs = endDate ? toTs(endDate, true) : Date.now();
    const items = [];
    let accounts = [];
    try {
      const r = await onetalkPost(`${ONETALK_BASE}/manager/getSubAccountList.htm`, { companyView: false });
      accounts = (r.data && r.data.list) || [];
    } catch (e) { throw new Error('无法读取聊天账号，请确认已登录 OneTalk：' + e.message); }
    if (!accounts.length) throw new Error('未找到聊天账号，请确认已登录 OneTalk');
    let done = 0;
    let truncated = false;
    outer: for (const acct of accounts) {
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
          if (maxContacts && done >= maxContacts) { truncated = true; break outer; }
          await pace();
        }
        if (contacts.length < PAGE_SIZE) break;
        await pace();
      }
    }
    items.sort((a, b) => a.ts - b.ts); // 按发送时间升序，便于阅读/复盘
    const rows = items.map((x) => x.row);
    rows.truncated = truncated;
    return rows;
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
    // 空单元格按外贸侠口径填 '-'
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

  // ---------------- 订单（信保订单列表） ----------------
  // 接口来自订单页自身：GET biz.alibaba.com/list/ajax/ta/mainv2.json?json=...&_tb_token_=...&ctoken=...
  // 只读、串行分页、每页 50 条并加随机间隔，避免与合作方接口形成高频请求。
  const ORDER_PAGE = 'https://biz.alibaba.com/ta/list/scene/mainList.htm';
  const API_ORDER = 'https://biz.alibaba.com/list/ajax/ta/mainv2.json';
  const ORDER_HEADERS = [
    '订单ID', '订单状态', '平台状态', '成交金额', '币种', '下单时间', '客户名称', '公司名称', '买家ID', '国家/地区',
    '业务员', '产品数', '产品总数量', '产品小计', '运费', '已付金额', '运输方式', '订单类型', '业务类型', '产品明细', '询盘ID', '订单链接',
  ];
  // 平台状态 → 本机口径（data-core.wonOrder 只认「已付款 / 已完成 / 交易成功」）
  const ORDER_STATUS_MAP = {
    '订单完成': '已完成', '待买家确认收货': '已付款', '发货中': '已付款', '待卖家接单': '待确认',
    '待买家付款': '待买家付款', '订单关闭': '已关闭', '交易关闭': '已关闭', '退款申请处理中': '退款中',
  };

  function orderAuth() {
    const c = document.cookie || '';
    const pickCookie = (name) => {
      const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
      return m ? m[1] : '';
    };
    const tb = pickCookie('_tb_token_');
    const xm = pickCookie('xman_us_t');
    const ct = (xm.match(/(?:^|&)ctoken=([^&]*)/) || [, ''])[1];
    return { tb: tb, ct: ct };
  }

  function orderQuery(page, size, start, end) {
    const req = {
      simpleFilter: 'simpleFilter@all', orderStatus: null, tradeType: null, recentCreateTime: null, recentShipmentTime: null,
      createDateFilter: { from: start || null, to: end || null },
      shipmentTimeFilter: { from: null, to: null }, orderAmountFilter: { from: null, to: null },
      operator: { loginId: null, accountId: null }, currency: null, bizSource: null, buyerCountry: null, buyerShippingCountry: null,
      fulfillmentChannel: null, orderDraftRole: null, shippingMethod: null, fuzzySearchValue: null, orderBy: null,
      promotionFilter: null, orderServiceFilter: null, acceptPoFilter: null, orderFinancingFilter: null, productTypeFilter: null,
      searchAliCarrierCode: false, pagination: { currentPage: page, pageSize: size },
    };
    return { requests: req, pagination: { currentPage: page, pageSize: size }, responseModel: 'V2', requestEnvironment: { operator: { role: 'seller' } } };
  }

  async function fetchOrderPage(page, size, start, end) {
    const a = orderAuth();
    if (!a.tb) throw new Error('读取不到 _tb_token_，请确认已登录并停留在订单页');
    const url = API_ORDER + '?json=' + encodeURIComponent(JSON.stringify(orderQuery(page, size, start, end)))
      + '&_tb_token_=' + encodeURIComponent(a.tb) + (a.ct ? ('&ctoken=' + encodeURIComponent(a.ct)) : '');
    // 直连（同源订单页）时浏览器自动带 Cookie / Referer；降级到后台代理时不传受限头
    const j = await request(url, 'GET', { Accept: 'application/json, text/plain, */*' });
    if (!j || Number(j.code) !== 200) throw new Error((j && (j.message || j.msg)) || '订单接口返回异常');
    const pd = (j.data && j.data.pageData) || {};
    return { pagination: pd.pagination || {}, rows: pd.data || [] };
  }

  async function collectOrders(start, end, onProgress) {
    const size = 50;
    const first = await fetchOrderPage(1, size, start, end);
    const totalPage = Math.min(100, Math.max(1, Number(first.pagination.totalPage) || 1));
    let rows = first.rows.slice();
    if (onProgress) onProgress(1, totalPage, rows.length);
    for (let p = 2; p <= totalPage; p++) {
      await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 800)));
      const r = await fetchPageWithRetry(p, size, start, end);
      rows = rows.concat(r.rows);
      if (onProgress) onProgress(p, totalPage, rows.length);
    }
    return { rows: rows, total: Number(first.pagination.totalRecord) || rows.length, totalPage: totalPage };
  }

  async function fetchPageWithRetry(page, size, start, end) {
    let last = null;
    for (let i = 0; i < 2; i++) {
      try { return await fetchOrderPage(page, size, start, end); }
      catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 + i * 1500)); }
    }
    throw last || new Error('订单第 ' + page + ' 页采集失败');
  }

  // 订单没有平台询盘ID：用本地已入库询盘按 客户名/公司名 做弱匹配，命中就填，供参考
  const orderNorm = (v) => {
    if (self.AliIdentity && self.AliIdentity.normalize) return self.AliIdentity.normalize(v);
    return String(v === undefined || v === null ? '' : v).toLowerCase()
      .replace(/[\s\u3000]+/g, '').replace(/[.,，。()（）"'&·\-]/g, '').trim();
  };
  async function orderInquiryIndex() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'inquiryIndex' });
      if (!r || !r.ok || !Array.isArray(r.list)) return [];
      return r.list.map((x) => ({
        id: String(x.id || ''),
        keys: (x.names || []).map(orderNorm).filter((k) => k && k.length >= 3),
        t: String(x.t || ''),
      })).filter((x) => x.id && x.keys.length);
    } catch (e) {
      console.warn('[ali-export-ext] 询盘索引不可用', e);
      return [];
    }
  }
  function matchOrderInquiry(name, company, idx) {
    const q = [name, company].map(orderNorm).filter((k) => k && k.length >= 3);
    if (!q.length || !idx.length) return '';
    let best = '', bestScore = 0, bestT = '';
    for (const it of idx) {
      for (const k of it.keys) {
        for (const t of q) {
          const score = k === t ? 2 : ((k.indexOf(t) >= 0 || t.indexOf(k) >= 0) ? 1 : 0);
          if (score > bestScore || (score === bestScore && score > 0 && it.t > bestT)) {
            bestScore = score; best = it.id; bestT = it.t;
          }
        }
      }
    }
    return best;
  }

  function orderRowOf(o, idx) {
    const b = o.baseInfo || {};
    const buyer = o.buyer || {};
    const pi = o.paymentInfo || {};
    const info = o.productInfo || {};
    const view = o.shipmentInfoView || {};
    const st = o.statusAction || {};
    const raw = String((st.status && st.status.displayName) || '');
    const amt = (x) => (x && Number.isFinite(Number(x.number)) ? Number(x.number) : '');
    const products = info.products || [];
    const detail = products.map((p) => String(p.name || '') + ' × ' + String((p.quantity && p.quantity.number) || '') + String(p.unit || '')).join('；').slice(0, 800);
    let link = String((st.detailUrl || b.detailUrl || ''));
    if (link.indexOf('//') === 0) link = 'https:' + link;
    return [
      b.id || '', ORDER_STATUS_MAP[raw] || raw, raw, amt(pi.totalAmount), pi.currency || '', b.createTime || '',
      buyer.fullName || '', buyer.companyName || '', buyer.aliId || '',
      (view.shippingCountry && view.shippingCountry.name) || '', b.merchandiser || (o.seller && o.seller.fullName) || '',
      info.productCount || '', info.productTotalNum || '',
      amt(pi.itemSubtotalAmount), amt(pi.shippingFeeAmount), amt(pi.advanceAmount),
      (view.shippingType && (view.shippingType.mcmsValue || view.shippingType.original)) || '',
      b.onlineType === 'ONLINE' ? '线上' : (b.orderCreateType || ''),
      b.businessType === 'trade_assurance' ? '信保订单' : (b.businessType || ''),
      detail, matchOrderInquiry(buyer.fullName, buyer.companyName, idx || []), link,
    ];
  }

  async function exportOrders(start, end, btn) {
    btn.disabled = true; btn.textContent = '采集订单…';
    try {
      const data = await collectOrders(start, end, (p, tp, n) => { btn.textContent = `订单 ${p}/${tp} 页 · ${n} 条…`; });
      if (!data.rows.length) { toast('该范围内没有订单'); return; }
      btn.textContent = '关联询盘…';
      const idx = await orderInquiryIndex();
      btn.textContent = '生成文件…';
      const rows = data.rows.map((o) => orderRowOf(o, idx));
      const r = await saveTable(ORDER_HEADERS, rows, `国际站订单导出_${nameStamp()}`, '订单列表数据-自用');
      ingest('order', r.name, ORDER_HEADERS, rows);
      const done = rows.filter((x) => x[1] === '已完成').length;
      const paid = rows.filter((x) => x[1] === '已付款').length;
      const linked = rows.filter((x) => x[20]).length;
      const tip = `已导出订单 ${rows.length} 条（已完成 ${done}、已付款 ${paid}；询盘关联 ${linked}/${rows.length}）· 文件名：${r.name}` + (r.ok ? '' : ` · 下载异常：${r.error}`);
      toast(tip);
      setStatus(`上次导出：${tip}`);
      console.log('[ali-export-ext] 订单导出完成', r);
    } catch (e) {
      toast('订单导出失败：' + e.message, true);
      console.error(e);
    } finally {
      btn.disabled = false; btn.textContent = '导出订单';
    }
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
      if (page === 200) items.truncated = true;
      await pace();
    }
    items.expectedTotal = Number.isFinite(total) ? total : null;
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

  function customerTable(items) {
    const flatList = items.map((it) => flattenObj(it, '', {}));
    const present = [];
    const seen = new Set();
    flatList.forEach((f) => Object.keys(f).forEach((k) => { if (!seen.has(k) && !CRM_DROP(k)) { seen.add(k); present.push(k); } }));
    const ordered = CRM_ORDER.filter((k) => seen.has(k)).concat(present.filter((k) => CRM_ORDER.indexOf(k) < 0));
    return { header: ordered.map((k) => CRM_LABELS[k] || k), rows: flatList.map((f) => ordered.map((k) => crmCell(k, f[k]))) };
  }
  async function exportCustomers(btn, scope, startDate, endDate, dateField) {
    const isPub = scope === 'public';
    const fileBase = isPub ? '公海客户' : '我的客户';
    const sheetName = isPub ? '公海客户-自用' : '我的客户-自用';
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = '采集客户…';
    try {
      const all = await collectCustomers(scope, (n, t) => { btn.textContent = `客户 ${n}/${t === Infinity ? '?' : t}…`; });
      // 客户 / 公海按全量快照采集：日期筛选只影响导出文件，不能影响入库，否则客户库会残缺
      const items = all;
      if (!items.length) { toast('没有取到客户数据', true); return; }
      const { header, rows } = customerTable(items);
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
  async function collectVisitors(startDate, endDate, onProgress, startPage, maxPages) {
    const t = tokens();
    const items = [];
    let total = Infinity;
    const PS = 50;
    const firstPage = Number(startPage) || 1;
    const limit = Number(maxPages) || 200;
    for (let page = firstPage; page < firstPage + limit; page++) { // 单段有明确安全上限
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
      const v = j && j.value;
      if (!v || !Array.isArray(v.data)) throw new Error('访客接口未返回列表，请确认已登录且有访客数据权限');
      const arr = v.data;
      const tt = pickTotal(v);
      if (tt != null) total = tt;
      items.push(...arr);
      if (onProgress) onProgress(items.length, total);
      if (!arr.length || page * PS >= total || arr.length < PS) break;
      if (page === firstPage + limit - 1) {
        items.truncated = true;
        items.nextPage = page + 1;
      }
      await pace();
    }
    items.expectedTotal = Number.isFinite(total) ? total : null;
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
  function visitorTable(items) {
    const flatList = items.map((it) => flattenObj(it, '', {}));
    const present = [];
    const seen = new Set();
    flatList.forEach((f) => Object.keys(f).forEach((k) => { if (!seen.has(k) && !VIS_DROP(k)) { seen.add(k); present.push(k); } }));
    const ordered = VIS_ORDER.filter((k) => seen.has(k)).concat(present.filter((k) => VIS_ORDER.indexOf(k) < 0));
    return { header: ordered.length ? ordered.map((k) => VIS_LABELS[k] || k) : ['访客ID'],
      rows: flatList.map((f) => ordered.map((k) => visCell(k, f[k]))) };
  }
  async function exportVisitors(startDate, endDate, btn) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = '采集访客…';
    try {
      const items = await collectVisitors(startDate, endDate, (n, t) => { btn.textContent = `访客 ${n}/${t === Infinity ? '?' : t}…`; });
      if (!items.length) { toast('没有取到访客数据（换个日期范围试试）', true); return; }
      const { header, rows } = visitorTable(items);
      btn.textContent = '生成文件…';
      const r = await saveTable(header, rows, `访客数据_${nameStamp()}`, '访客数据-自用');
      ingest('visitor', r.name, header, rows);
      const tip = `已导出访客 ${rows.length} 条（${String(r.kind).toUpperCase()}）· 文件名：${r.name}`
        + (items.truncated ? ' · 达到页数上限，可能仍有未导出的访客' : '') + (r.ok ? '' : ` · 下载异常：${r.error}`);
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

  // 首次安装与后续刷新共用现有只读采集器，直接写入扩展资料库，不依赖下载文件。
  function latestBusinessTime(header, rows, kind) {
    const names = {
      inquiry: ['最新回复时间', '创建时间'], chat: ['发送时间'],
      customer: ['最近联系时间', 'opp_gmt_modified', '备注时间', '创建时间'],
      public_customer: ['最近联系时间', 'opp_gmt_modified', '备注时间', '进入公海时间', '创建时间'],
      order: ['下单时间'], visitor: ['统计日期'],
    }[kind] || [];
    const indexes = names.map((name) => header.indexOf(name)).filter((index) => index >= 0);
    let latest = 0;
    (rows || []).forEach((row) => indexes.forEach((index) => {
      const raw = String(row[index] || '').trim();
      const time = /^\d{10,13}$/.test(raw)
        ? Number(raw) * (raw.length === 10 ? 1000 : 1)
        : new Date(raw.replace(' ', 'T')).getTime();
      if (Number.isFinite(time) && time > latest) latest = time;
    }));
    return latest ? new Date(latest).toISOString() : '';
  }
  async function collectForWorkspace(kind, full, options) {
    options = options || {};
    const since = Number(options.sinceMs) || Date.now() - 2 * 60 * 60 * 1000;
    if (window.self !== window.top) throw new Error('只在平台主页面采集');
    const host = location.hostname;
    const expected = { customer: 'i.alibaba.com', public_customer: 'i.alibaba.com',
      inquiry: 'message.alibaba.com', chat: 'onetalk.alibaba.com', order: 'biz.alibaba.com',
      visitor: 'data.alibaba.com' }[kind];
    if (!expected || host !== expected) throw new Error('页面与采集类型不匹配');
    let lastProgress = 0;
    const progress = (message) => {
      if (Date.now() - lastProgress < 1200) return;
      lastProgress = Date.now();
      chrome.runtime.sendMessage({ type: 'platformCollectProgress', kind, message }).catch(() => {});
    };
    let header = [], rows = [], truncated = false, nextPage = 0, coverageGap = false, expectedTotal = null;
    if (kind === 'customer' || kind === 'public_customer') {
      const items = await collectCustomers(kind === 'customer' ? 'mine' : 'public', (n, t) => progress('已读取 ' + n + '/' + (t === Infinity ? '?' : t) + ' 位客户'));
      truncated = !!items.truncated; expectedTotal = items.expectedTotal;
      if (kind === 'customer' && !items.length) throw new Error('未取到我的客户，请确认已登录并有客户管理权限');
      ({ header, rows } = customerTable(items));
      if (kind === 'public_customer' && !items.length) header = ['客户ID'];
    } else if (kind === 'inquiry') {
      const found = full
        ? await collectInquiry('', '', (page, n) => progress('已读取 ' + page + ' 页 / ' + n + ' 条询盘'),
          true, (n) => progress('已补全 ' + n + ' 条客户信息'), 100, 100,
          Number(options.startPage) || 1)
        : await collectRecentInquiry(since,
          (page, n) => progress('已检查最近活动 ' + page + ' 页 / ' + n + ' 条询盘'),
          Number(options.startPage) || 1);
      truncated = !!found.truncated;
      nextPage = Number(found.nextPage) || 0;
      await applyCrmLevels(found);
      header = INQUIRY_HEADERS; rows = found.map((x) => x.row);
    } else if (kind === 'chat') {
      rows = await collectChats(full ? todayStr(-89) : since, '',
        (sessions, n) => progress('已读取 ' + sessions + ' 个会话 / ' + n + ' 条消息'), 400);
      truncated = !!rows.truncated;
      header = CHAT_HEADERS;
    } else if (kind === 'order') {
      const orderStart = full ? '' : options.reconcile ? todayStr(-179)
        : new Date(since).toLocaleDateString('sv-SE');
      const result = await collectOrders(orderStart, '',
        (page, pages, n) => progress('已读取 ' + page + '/' + pages + ' 页 / ' + n + ' 条订单'));
      expectedTotal = result.total;
      const index = await orderInquiryIndex();
      header = ORDER_HEADERS; rows = result.rows.map((x) => orderRowOf(x, index));
      truncated = result.totalPage >= 100 && result.total > result.rows.length;
    } else if (kind === 'visitor') {
      const earliest = Date.now() - 29 * 86400000;
      coverageGap = !full && since < earliest;
      const start = full ? todayStr(-29) : new Date(Math.max(since, earliest)).toLocaleDateString('sv-SE');
      const items = await collectVisitors(start, todayStr(0),
        (n, total) => progress('已读取 ' + n + '/' + (total === Infinity ? '?' : total) + ' 位访客'),
        Number(options.startPage) || 1, 40);
      ({ header, rows } = visitorTable(items));
      expectedTotal = items.expectedTotal;
      truncated = !!items.truncated;
      nextPage = Number(items.nextPage) || 0;
    }
    if (!rows.length && !['public_customer', 'visitor'].includes(kind)) return { ok: true, kind, rows: 0, skipped: true,
      truncated, coverageGap, expectedTotal, latestBusinessAt: '' };
    const latestBusinessAt = latestBusinessTime(header, rows, kind);
    const result = await chrome.runtime.sendMessage({ type: 'ingest', file: {
      name: '平台自动采集_' + kind + '_' + nameStamp(), kind, header, rows,
      mtime: localStamp(), source: 'platform-auto', workspace: options.workspace,
      accountFingerprint: options.accountFingerprint,
    } });
    if (!result || !result.ok) throw new Error(result && result.error || '写入本机资料库失败');
    return { ok: true, kind, rows: rows.length, skipped: !!result.skipped, truncated,
      nextPage, coverageGap, expectedTotal, latestBusinessAt };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !['platformCollectPing', 'platformCollectRun', 'platformAccountProbe'].includes(msg.type)) return;
    if (msg.type === 'platformCollectPing') { sendResponse({ ok: true }); return; }
    if (msg.type === 'platformAccountProbe') {
      if (window.self !== window.top || location.hostname !== 'onetalk.alibaba.com') {
        sendResponse({ ok: false, error: '账号核实只能在 OneTalk 主页面执行' }); return;
      }
      onetalkPost(`${ONETALK_BASE}/manager/getSubAccountList.htm`, { companyView: false })
        .then((r) => self.AliPlatformJob.accountFingerprint(r && r.data && r.data.list))
        .then((identity) => sendResponse({ ok: true, ...identity }))
        .catch((e) => sendResponse({ ok: false, error: '无法核实当前卖家账号：' + e.message }));
      return true;
    }
    self.AliPlatformJob.start(msg, sendResponse, collectForWorkspace, chrome.storage.local);
  });

  // ---------------- 自检 ----------------
  async function runDiagnostics(btn) {
    const out = [];
    const log = (...a) => out.push(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' '));
    btn.disabled = true; btn.textContent = '自检中…';
    try {
      const t = tokens();
      log('[COOKIE_NAMES]', document.cookie.split(';').map((s) => s.split('=')[0].trim()).filter(Boolean).join(','));
      log('[TOKENS]', { ctoken: !!t.ctoken, csrf: !!t.csrf, tb: !!t.tb });
      const paramsJson = {
        system: 'feedback', listType: 'all', pageSize: 5,
        pagination: { nextPage: 1, pageSize: 5 }, filter: { isShowAtm: false },
        order: { order: 'desc', orderBy: 'latest_contact_time' }, search: {},
      };
      const qs = new URLSearchParams({ ctoken: t.ctoken, _tb_token_: t.tb });
      const body = new URLSearchParams({ _csrf_token_: t.csrf, postId: '', params: JSON.stringify(paramsJson) });
      const hdrs = {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest', 'Referer': API.referer, 'Origin': API.origin, 'X-XSRF-TOKEN': t.xsrf,
      };
      let raw = '';
      try {
        raw = await fetchRaw(`${API.inquiryList}?${qs}`, 'POST', hdrs, body.toString());
        log('[INQUIRY_OK] len=' + raw.length);
      } catch (e) { log('[INQUIRY_FAIL]', e.message); }
      if (raw) {
        log('[RESP_HEAD]', raw.slice(0, 260));
        log('[RESP_TAIL]', raw.slice(-180));
        let parsed = null;
        try { parsed = parseMaybe(raw); } catch (e) { log('[PARSE_FAIL]', e.message); }
        if (parsed) {
          const d = parsed.data || {};
          log('[INQUIRY_CODE]', parsed.code, parsed.message || parsed.msg || '');
          log('[DATA_KEYS]', Object.keys(d).join(','));
          let list = d.list || d.dataList || d.result || d.records || [];
          if (Array.isArray(list) && list.length && Array.isArray(list[0])) list = [].concat(...list);
          log('[LIST_LEN]', Array.isArray(list) ? list.length : String(list));
          const it = Array.isArray(list) ? list[0] : null;
          if (it) {
            log('[ITEM0_KEYS]', Object.keys(it).join(','));
            log('[ITEM0_SAMPLE]', JSON.stringify(it).slice(0, 400));
          }
        }
      }
    } catch (e) { log('[FATAL]', e.message); }
    const text = out.join('\n');
    console.log('%c[ali-export-ext 自检]', 'color:#2563eb;font-weight:bold');
    console.log(text);
    showDiag(text);
    btn.disabled = false; btn.textContent = '自检接口';
  }
  function showDiag(text) {
    const wrap = document.getElementById('ali-diag-wrap');
    const ta = document.getElementById('ali-diag');
    if (wrap && ta) { ta.value = text; wrap.style.display = 'block'; ta.scrollTop = 0; }
  }
  // 面板底部常驻状态行（导出后显示目标文件名与下载方式，便于诊断）
  function setStatus(text) {
    const el = document.getElementById('ali-status');
    if (el) el.textContent = text;
  }

  // ---------------- 客户信息探针（v0.2 真机自检） ----------------
  // 链路：询盘列表 → querySummary.htm(secTradeId) → maDetail.htm(KHTAccessToken) → alicrm queryCustomerInfo.json
  async function probeCustomer(btn) {
    const out = [];
    const log = (...a) => out.push(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' '));
    btn.disabled = true; btn.textContent = '探测中…';
    try {
      const t = tokens();
      const { list } = await fetchInquiryPage(1);
      const all = Array.isArray(list) ? list : [];
      const item = all.find((x) => x && x.secTradeId) || all[0] || null;
      if (!item) { log('[NO_ITEM]', '第一页无可用询盘'); }
      else {
        log('[ITEM_ID]', JSON.stringify({ tradeId: item.tradeId, secTradeId: item.secTradeId, targetIds: item.targetIds }));
        log('[ITEM_LOC]', JSON.stringify({ source: item.source, appFrom: item.appFrom, replyStatus: item.replyStatus, process: item.process, mark: item.mark, waitDay: item.waitDay }));
        // 1) querySummary.htm —— 询盘摘要（含 contact：accountId / countryCode / accountIdEncrypt 等）
        const qs1 = new URLSearchParams({ ctoken: t.ctoken, _tb_token_: t.tb });
        const body1 = new URLSearchParams({ _csrf_token_: t.csrf, postId: '', params: JSON.stringify({ secTradeId: item.secTradeId }) });
        let raw1 = '';
        try { raw1 = await fetchRaw(`${API.querySummary}?${qs1}`, 'POST', inquiryHeaders(t), body1.toString()); log('[SUM_OK] len=' + raw1.length); }
        catch (e) { log('[SUM_FAIL]', e.message); }
        let contact = null;
        if (raw1) {
          log('[SUM_HEAD]', raw1.slice(0, 400));
          try {
            const p = parseMaybe(raw1);
            const data = (p && p.data) || {};
            log('[SUM_DATA_KEYS]', Object.keys(data).join(','));
            contact = data.contact || null;
            log('[CONTACT]', JSON.stringify(contact));
            log('[SUM_META]', JSON.stringify({ source: data.source, mark: data.mark, process: data.process, feedbackType: data.feedbackType, messageType: data.messageType, orderRole: data.orderRole }));
          } catch (e) { log('[SUM_PARSE_FAIL]', e.message); }
        }
        // 2) maDetail.htm —— 详情页（取 window.KHTAccessToken）
        let kht = '';
        try {
          const html = await fetchRaw(`${API.maDetail}?imInquiryId=${encodeURIComponent(item.tradeId)}`, 'GET',
            { 'Accept': 'text/html,application/xhtml+xml', 'Referer': API.referer }, null);
          const m = String(html).match(/KHTAccessToken\s*[:=]\s*['"]([^'"]+)['"]/);
          kht = m ? m[1] : '';
          log('[KHT]', kht ? 'ok len=' + kht.length : '未找到 KHTAccessToken');
        } catch (e) { log('[MADETAIL_FAIL]', e.message); }
        // 3) alicrm queryCustomerInfo.json —— 客户信息（响应为 data.data 两层；多候选 buyerAccountId 逐个试）
        if (kht) {
          const c = contact || {};
          const cands = [
            ['contact.accountIdEncrypt', c.accountIdEncrypt],
            ['contact.buyerAccountId', c.buyerAccountId],
            ['contact.accountId', c.accountId],
            ['contact.loginId', c.loginId],
            ['contact.extSecAccountId', c.extSecAccountId],
          ].filter((x) => x[1]);
          if (!cands.length) log('[CRM_NO_CAND]', 'contact 中无可用 buyerAccountId');
          for (const [label, bid] of cands) {
            const qs3 = new URLSearchParams({ buyerAccountId: bid, secTradeId: item.secTradeId, secReqToken: kht, ctoken: t.ctoken, _tb_token_: t.tb });
            try {
              const raw3 = await fetchRaw(`${API.customerInfo}?${qs3}`, 'GET',
                { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'Referer': 'https://alicrm.alibaba.com/' }, null);
              let root = {};
              try {
                const p3 = parseMaybe(raw3);
                root = (p3 && p3.data && p3.data.data) ? p3.data.data : ((p3 && p3.data) || p3 || {});
              } catch (e) { log('[CRM_PARSE_FAIL]', label, e.message); }
              const bi = root.buyerInfo || {};
              const ci = root.alicrmCustomerInfo || {};
              const has = (Object.keys(bi).length || Object.keys(ci).length);
              log(`[CRM ${label}=${bid}] len=${raw3.length} 命中=${has ? '是' : '否'}`);
              if (has) {
                log('[BUYERINFO_KEYS]', Object.keys(bi).join(','));
                log('[BUYERINFO_OK]', JSON.stringify(bi).slice(0, 1500));
                log('[ALICRM_KEYS]', Object.keys(ci).join(','));
                log('[ALICRM_OK]', JSON.stringify(ci).slice(0, 1500));
                // 专找「是否已加为客户」相关候选字段
                const pick = (o) => Object.keys(o).filter((k) => /customer|added|add_|addTo|pool|crm|relation|cooperat|isAdd|customerStatus/i.test(k))
                  .map((k) => k + '=' + JSON.stringify(o[k])).join(', ') || '(无)';
                log('[STATUS_CAND]', 'buyerInfo → ' + pick(bi) + ' || alicrmCustomerInfo → ' + pick(ci));
                // 专找「买家分层 L0~L4」候选字段：确认询盘接口是否其实直接带 L 级（若有则无需靠客户库关联）
                const pickL = (o) => Object.keys(o).filter((k) => /level|tier|grade|quality|rank/i.test(k))
                  .map((k) => k + '=' + JSON.stringify(o[k])).join(', ') || '(无)';
                log('[LEVEL_CAND]', 'buyerInfo → ' + pickL(bi) + ' || alicrmCustomerInfo → ' + pickL(ci));
                // 归一后的结论：接口到底能不能直接给出 L0~L4（能就不用靠客户库关联了）
                log('[LEVEL_RESOLVE]', 'pickLTag(buyerInfo)=' + (pickLTag(bi) || '(空)')
                  + ' | pickLTag(alicrm)=' + (pickLTag(ci) || '(空)')
                  + ' | buyerInfo.highQualityLevelTag=' + JSON.stringify(bi.highQualityLevelTag)
                  + ' | buyerInfo.levelTag=' + JSON.stringify(bi.levelTag));
              } else if (label === cands[0][0]) {
                log('[CRM_RAW]', raw3.slice(0, 300));
              }
            } catch (e) { log(`[CRM_FAIL ${label}]`, e.message); }
            await pace();
          }
        } else {
          log('[CRM_SKIP]', '无 KHTAccessToken，跳过 CRM 查询');
        }
      }
    } catch (e) { log('[FATAL]', e.message); }
    const text = out.join('\n');
    console.log('%c[ali-export-ext 客户接口探针]', 'color:#7c3aed;font-weight:bold');
    console.log(text);
    showDiag(text);
    btn.disabled = false; btn.textContent = '客户接口自检';
  }

  // ---------------- 聊天接口自检（v0.2 真机） ----------------
  // 真实链路：getSubAccountList → queryRecentContactList(日期区间) → getMessageHistoryList
  async function probeChat(btn) {
    const out = [];
    const log = (...a) => out.push(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' '));
    btn.disabled = true; btn.textContent = '探测中…';
    try {
      const t = tokens();
      const BASE = 'https://onetalk.alibaba.com/message';
      const H = {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://onetalk.alibaba.com/message/messageManager.htm', 'Origin': 'https://onetalk.alibaba.com',
      };
      const post = (url, params) => request(url, 'POST', H, new URLSearchParams({ params: JSON.stringify(params), _csrf: t.csrf }).toString());
      const now = Date.now();
      const from = now - 30 * 86400000;
      // 1) 子账号
      let accts = [];
      try {
        const r = await post(`${BASE}/manager/getSubAccountList.htm`, { companyView: false });
        accts = (r.data && r.data.list) || [];
        log('[SUB] count=' + accts.length, JSON.stringify(accts[0] || null).slice(0, 300));
      } catch (e) { log('[SUB_FAIL]', e.message); }
      const acct = accts[0];
      if (!acct) { log('[NO_ACCT]', '无子账号，停止'); }
      else {
        // 2) 会话列表（近 30 天）
        let contacts = [];
        try {
          const r = await post(`${BASE}/manager/queryRecentContactList.htm`, {
            startTime: from, endTime: now, activeAccountId: acct.accountId, activeAccountIdEncrypt: acct.accountIdEncrypt,
            pagination: { currentPage: 1, pageSize: 20 },
          });
          contacts = (r.data && r.data.list) || [];
          log('[CONTACTS] count=' + contacts.length + ' dataKeys=' + Object.keys(r.data || {}).join(','));
          log('[CONTACT0]', JSON.stringify(contacts[0] || null).slice(0, 400));
        } catch (e) { log('[CONTACTS_FAIL]', e.message); }
        const ct = contacts[0];
        if (ct) {
          // 3) 消息历史
          try {
            const r = await post(`${BASE}/manager/getMessageHistoryList.htm`, {
              accountId: acct.accountId, accountIdEncrypt: acct.accountIdEncrypt,
              contactAccountId: ct.accountId, contactAccountIdEncrypt: ct.accountIdEncrypt,
              timeSlide: { timeStamp: now, forward: false, pageSize: 20 },
            });
            const list = (r.data && r.data.list) || [];
            log('[MSGS] len=' + list.length + ' dataKeys=' + Object.keys(r.data || {}).join(','));
            if (list[0]) { log('[MSG0_KEYS]', Object.keys(list[0]).join(',')); log('[MSG0]', JSON.stringify(list[0]).slice(0, 1500)); }
            if (list[1]) { log('[MSG1]', JSON.stringify(list[1]).slice(0, 700)); }
          } catch (e) { log('[MSGS_FAIL]', e.message); }
        }
      }
    } catch (e) { log('[FATAL]', e.message); }
    const text = out.join('\n');
    console.log('%c[ali-export-ext 聊天接口探针]', 'color:#0e7490;font-weight:bold');
    console.log(text);
    showDiag(text);
    btn.disabled = false; btn.textContent = '聊天接口自检';
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

  // 给智能体（WorkBuddy / Codex / 豆包）的接入信息 + 可直接粘贴的提示词
  const buildMcpOnboarding = (syncText) => `【阿里国际站外贸助手 · MCP 接入信息】

1) 服务地址
   HTTP（WorkBuddy / 豆包等）：http://127.0.0.1:39272/mcp
   stdio（Codex / Claude 桌面）：在 agent-daemon 目录执行  node mcp-server.js --no-http
   启动服务：双击 agent-daemon\\run-mcp.cmd（关闭窗口即停止）

2) 数据同步
   扩展「AI 设置 → 本地 MCP → 同步到 MCP」（只同步已导出的数据）
   本次：${syncText || '尚未同步'}

3) 可用工具（9）
   sync_status、customer_search、customer_profile、inquiry_list、chat_search、chat_get、site_fetch、company_search、stats

4) 可直接粘贴给智能体的提示词 ↓
--------------------------------------------------
你是我的外贸业务助手。数据来自我本机同步的 MCP 服务 ali-trade-mcp，全部是已导出的询盘/客户/聊天/访客记录。不要编造，所有数字和结论必须来自工具返回。

接入后先调用 sync_status，确认数据量；如果条数是 0，提醒我先在扩展里点「同步到 MCP」。

任务路由：
- 客户背调：customer_search 定位客户 → customer_profile 取客户库/询盘/聊天/成交判断 → 资料里有官网就调用 site_fetch 抓官网；没有官网就 company_search 检索公司背景 → 输出「已知事实（标来源）/ 合理推断（附依据与置信度）/ 仍未知」。
- 未加为客户或待回复客户：inquiry_list(onlyUnconverted=true) + customer_profile 判断最后一条消息方向 → 仅用最近3个本机自然日（含今天）发生的询盘、回复、聊天或阶段变化生成「今日待办」（最多 10 条）；旧询盘与累计未联系天数不能单独触发今日任务。按买家等级、意图强度和最近业务活动排序；我追问某个客户时再展开。加为客户不等于成交。
- 常规分析：用 stats / inquiry_list / chat_search 做汇总，结论先行，列出关键数字和下一步动作。

硬性规则：
- 价格、交期、认证、库存必须标「【需人工确认】」，只给建议不写具体数字；禁止编造公司规模、年采购量；工具里没有就写「资料不足」。
- 仅有已确认订单或员工填写核实依据的机会阶段才能称为已成交；买家累计金额、客户库订单数仅作线索。售后问题单独标注。
- 每条结论标注数据来源（客户库 / 询盘 / 聊天 / 官网 / 网络检索）。
- 中文回答；给客户的话术用客户语言，默认英文。

先回复「已接入 ali-trade-mcp，共 9 个工具；当前数据：…」，然后等我的任务指令。
--------------------------------------------------`;

  // ---------------- AI 待办卡片（结构化 JSON → 看板同款卡片） ----------------
  const parseTodoJson = (text) => {
    const s = String(text || '').replace(/```json/gi, '```').replace(/```/g, '');
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      const o = JSON.parse(s.slice(a, b + 1));
      return (o && Array.isArray(o.cards)) ? o : null;
    } catch (e) { return null; }
  };
  const todoToText = (o) => {
    const lines = [];
    if (o.summary) lines.push(o.summary);
    (o.cards || []).forEach((c, i) => {
      lines.push((i + 1) + '. [' + (c.priority || '') + '] ' + (c.customer || '') + '｜' + (c.reason || '')
        + '｜今天动作：' + (c.action || '') + '｜' + (c.due || '') + '｜' + (c.confirm || ''));
    });
    if (o.gaps && o.gaps.length) lines.push('数据缺口：' + o.gaps.join('；'));
    if (o.risks && o.risks.length) lines.push('风险：' + o.risks.join('；'));
    return lines.join('\n');
  };
  function ensureTodoCss() {
    if (document.getElementById('ali-todo-css')) return;
    const st = document.createElement('style');
    st.id = 'ali-todo-css';
    st.textContent = `
#ali-ai-box .atd-wrap{display:flex;flex-direction:column;gap:8px;white-space:normal}
#ali-ai-box .atd-sum{font-size:12.5px;color:#4b5563;background:#f8fafc;border:1px solid #eef1f4;border-radius:8px;padding:8px 10px}
#ali-ai-box .atd-card{background:#fff;border:1px solid #e8e5f3;border-radius:12px;padding:10px 12px;box-shadow:0 1px 4px rgba(76,29,149,.06)}
#ali-ai-box .atd-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
#ali-ai-box .atd-chip{font-size:11.5px;padding:2px 7px;border-radius:7px;font-weight:600;border:1px solid transparent}
#ali-ai-box .atd-chip.high{background:#fee2e2;color:#b91c1c;border-color:#fecaca}
#ali-ai-box .atd-chip.mid{background:#fef3c7;color:#b45309;border-color:#fde68a}
#ali-ai-box .atd-chip.tag{background:#f3e8ff;color:#7c3aed;border-color:#ddd6fe}
#ali-ai-box .atd-chip.act{background:#eff6ff;color:#2563eb;border-color:#bfdbfe}
#ali-ai-box .atd-title{font-size:13.5px;font-weight:700;color:#111827;margin-bottom:5px}
#ali-ai-box .atd-kv{display:grid;grid-template-columns:66px 1fr;gap:3px 8px;font-size:12px;color:#4b5563;margin-bottom:4px}
#ali-ai-box .atd-kv .k{color:#9ca3af}
#ali-ai-box .atd-foot{display:flex;gap:12px;margin-top:6px;align-items:center}
#ali-ai-box .atd-link{font-size:12px;color:#7c3aed;cursor:pointer}
#ali-ai-box .atd-btn{margin-left:auto;text-decoration:none;background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;padding:5px 10px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer}
#ali-ai-box .atd-ai{margin-top:8px;border:1.5px solid #c4b5fd;border-radius:10px;padding:8px 10px;background:#faf8ff}
#ali-ai-box .atd-ai-head{font-weight:800;color:#4c1d95;font-size:12.5px;margin-bottom:4px}
#ali-ai-box .atd-ai-row{font-size:12px;color:#374151;margin:2px 0}
#ali-ai-box .atd-script{margin-top:6px;font-size:12px;color:#374151}
#ali-ai-box .atd-script pre{white-space:pre-wrap;background:#f8fafc;border:1px solid #eef1f4;border-radius:8px;padding:7px;font-size:12px;margin:4px 0 0}
#ali-ai-box .atd-note{margin-top:8px;font-size:12px;color:#6b7280}`;
    document.head.appendChild(st);
  }
  function renderTodoCards(obj, container) {
    ensureTodoCss();
    container.innerHTML = '';
    container.style.whiteSpace = 'normal';
    const wrap = document.createElement('div');
    wrap.className = 'atd-wrap';
    if (obj.summary) {
      const s = document.createElement('div');
      s.className = 'atd-sum';
      s.textContent = obj.summary;
      wrap.appendChild(s);
    }
    (obj.cards || []).forEach((c, i) => {
      const card = document.createElement('div');
      card.className = 'atd-card';
      const chips = document.createElement('div');
      chips.className = 'atd-chips';
      const chip = (txt, cls) => {
        if (!txt) return;
        const sp = document.createElement('span');
        sp.className = 'atd-chip ' + cls;
        sp.textContent = txt;
        chips.appendChild(sp);
      };
      chip(c.priorityLabel || c.priority, (c.priority === 'P0' ? 'high' : 'mid'));
      chip(c.tag, 'tag');
      chip(c.action, 'act');
      card.appendChild(chips);
      const title = document.createElement('div');
      title.className = 'atd-title';
      title.textContent = (i + 1) + '. ' + (c.customer || '客户');
      card.appendChild(title);
      const kv = (k, v) => {
        if (!v) return;
        const row = document.createElement('div');
        row.className = 'atd-kv';
        const kk = document.createElement('span');
        kk.className = 'k';
        kk.textContent = k;
        const vv = document.createElement('div');
        vv.textContent = v;
        row.appendChild(kk); row.appendChild(vv);
        card.appendChild(row);
      };
      kv('推荐理由', c.reason);
      kv('截止日期', c.due || '今天');
      kv('跟进人', c.owner || '未分配');
      kv('需确认', c.confirm || '价格/交期/认证【需人工确认】');
      const foot = document.createElement('div');
      foot.className = 'atd-foot';
      if (c.script) {
        const cp = document.createElement('span');
        cp.className = 'atd-link';
        cp.textContent = '复制话术';
        cp.onclick = () => navigator.clipboard.writeText(c.script)
          .then(() => toast('话术已复制')).catch(() => toast('复制失败，请手动复制', true));
        foot.appendChild(cp);
      }
      const go = document.createElement('a');
      go.className = 'atd-btn';
      const target = String(c.customer || '').replace(/[（(].*?[）)]/g, '').trim();
      go.href = 'https://onetalk.alibaba.com/message/weblitePWA.htm'
        + (target ? ('?aliChat=' + encodeURIComponent(target) + '&aliAiFocus=' + encodeURIComponent(target)) : '');
      go.target = '_blank';
      go.rel = 'noopener';
      go.textContent = '去信息页回复 →';
      go.addEventListener('click', async (event) => {
        event.preventDefault();
        try {
          const focusCard = { customer: target, script: c.script || '', reason: c.reason || '',
            interaction: c.interaction || '', behavior: c.behavior || '', value: c.value || '',
            background: c.background || '', at: Date.now() };
          const workspace = await activeAiWorkspace();
          await chrome.storage.local.set({
            [aiPanelKey(workspace)]: true,
            [aiFocusCardKey(workspace, target)]: focusCard,
          });
          const opened = await chrome.runtime.sendMessage({ type: 'openAiChat', customer: target });
          if (!opened || !opened.ok) throw new Error('打开聊天页失败');
        } catch (e) { window.open(go.href, '_blank', 'noopener'); }
      });
      foot.appendChild(go);
      card.appendChild(foot);
      const aiPairs = [['客户互动总结', c.interaction], ['国际站行为&偏好洞察', c.behavior], ['客户价值与趋势', c.value], ['背调分析', c.background]];
      if (aiPairs.some((x) => x[1])) {
        const box = document.createElement('div');
        box.className = 'atd-ai';
        const h = document.createElement('div');
        h.className = 'atd-ai-head';
        h.textContent = 'AI 客户分析';
        box.appendChild(h);
        aiPairs.forEach(([k, v]) => {
          if (!v) return;
          const row = document.createElement('div');
          row.className = 'atd-ai-row';
          const b = document.createElement('b');
          b.textContent = k + '：';
          row.appendChild(b);
          row.appendChild(document.createTextNode(v));
          box.appendChild(row);
        });
        card.appendChild(box);
      }
      if (c.script) {
        const d = document.createElement('details');
        d.className = 'atd-script';
        const sm = document.createElement('summary');
        sm.textContent = '查看跟进话术';
        const pre = document.createElement('pre');
        pre.textContent = c.script;
        d.appendChild(sm); d.appendChild(pre);
        card.appendChild(d);
      }
      wrap.appendChild(card);
    });
    const note = (title, list) => {
      if (!list || !list.length) return;
      const n = document.createElement('div');
      n.className = 'atd-note';
      n.textContent = title + '：' + list.join('；');
      wrap.appendChild(n);
    };
    note('数据缺口', obj.gaps);
    note('风险', obj.risks);
    container.appendChild(wrap);
  }
  const TODO_JSON_RULES = '【输出格式：严格 JSON，不要 markdown 代码块、不要多余文字】\n'
    + '{"summary":"一句话总览","cards":[{"priority":"P0","priorityLabel":"高优先级","customer":"客户名","tag":"询盘待跟进",'
    + '"action":"今天要做的动作","reason":"为什么现在跟（≤30字）","due":"今天","owner":"跟进人，未知填未分配",'
    + '"confirm":"价格、交期【需人工确认】","interaction":"客户互动总结","behavior":"国际站行为&偏好洞察",'
    + '"value":"客户价值与趋势","background":"背调分析","script":"60-90 词英文跟进话术"}],'
    + '"gaps":["数据缺口，最多3条"],"risks":["风险，最多3条"]}\n'
    + '规则：最多 10 张卡；仅按已确认订单或员工核实依据判断成交；'
    + '优先待回复、待确认报价或样品结果的客户；价格/交期/认证/库存标【需人工确认】，不写具体数字；'
    + '资料不足写「资料不足」，禁止编造；script 经员工审核后才可发送。';

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
      'border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.18);padding:14px;max-height:90vh;overflow:auto;' +
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
      '<div style="border-top:1px dashed #e5e7eb;margin-top:12px;padding-top:10px;">' +
      '<b style="font-size:12.5px;">本地 MCP</b><span style="color:#9ca3af;font-size:11px;">（同步已导出数据，供 Codex / WorkBuddy 等调用）</span>' +
      '<div style="color:#6b7280;font-size:11px;margin:2px 0 6px;">只同步已入库的导出数据：询盘 / 我的客户 / 公海 / 聊天 / 访客；分析与评估仍以导出数据为准</div>' +
      '<div style="display:flex;gap:6px;">' +
      '<button id="ali-kb-mcp" style="flex:1;border:1px solid #a7f3d0;background:#ecfdf5;color:#047857;border-radius:6px;padding:5px;cursor:pointer;font-size:12px;">同步到 MCP</button>' +
      '<button id="ali-kb-mcp-info" style="border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:5px 8px;cursor:pointer;font-size:12px;white-space:nowrap;">接入信息</button></div>' +
      '<div id="ali-kb-mcp-out" style="display:none;margin-top:6px;">' +
      '<textarea id="ali-kb-mcp-text" readonly style="width:100%;height:130px;padding:6px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;font:11.5px/1.55 Consolas,monospace;resize:vertical;"></textarea>' +
      '<button id="ali-kb-mcp-copy" style="width:100%;margin-top:4px;border:1px solid #bfdbfe;background:#eff6ff;color:#1d4ed8;border-radius:6px;padding:5px;cursor:pointer;font-size:12px;">复制接入提示词</button></div>' +
      '<div id="ali-kb-msg" style="margin-top:6px;color:#6b7280;font-size:11.5px;word-break:break-all;"></div></div>' +
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
    // 本地 MCP：只同步已导出数据（不再维护公司知识库 / WorkBuddy 任务派发）
    const kbMsg = (t, ok) => {
      const el = $('ali-kb-msg');
      el.textContent = t;
      el.style.color = ok ? '#15803d' : '#b45309';
    };
    let lastMcpParts = '';
    const showMcpInfo = (parts) => {
      const text = buildMcpOnboarding(parts);
      $('ali-kb-mcp-text').value = text;
      $('ali-kb-mcp-out').style.display = 'block';
      return text;
    };
    const copyMcpText = (text) => {
      navigator.clipboard.writeText(text).then(() => toast('接入提示词已复制')).catch(() => {
        const ta = $('ali-kb-mcp-text');
        if (ta) { ta.focus(); ta.select(); }
        toast('已选中接入信息，按 Ctrl+C 复制', true);
      });
    };
    $('ali-kb-mcp-info').onclick = () => {
      const text = showMcpInfo(lastMcpParts || '尚未同步（先运行 run-mcp.cmd，再点「同步到 MCP」）');
      copyMcpText(text);
      kbMsg('接入信息已生成并复制，可直接粘贴到 WorkBuddy / 豆包', true);
    };
    $('ali-kb-mcp-copy').onclick = () => {
      const text = $('ali-kb-mcp-text').value || showMcpInfo(lastMcpParts || '尚未同步');
      copyMcpText(text);
    };
    $('ali-kb-mcp').onclick = async () => {
      kbMsg('同步到本地 MCP…', false);
      try {
        const r = await chrome.runtime.sendMessage({ type: 'syncToMcp' });
        if (!r || !r.ok) throw new Error((r && r.error) || '同步失败');
        lastMcpParts = (r.results || []).filter((x) => x.count)
          .map((x) => x.kind + ' ' + x.count + ' 条').join(' / ');
        const text = showMcpInfo(lastMcpParts || '已同步（当前没有可同步的数据）');
        copyMcpText(text);
        kbMsg('已同步：' + (lastMcpParts || '（无数据）') + ' · 已复制接入提示词', true);
        toast('已同步并复制接入提示词');
      } catch (e) {
        lastMcpParts = '同步失败：' + ((e && e.message) || e);
        showMcpInfo(lastMcpParts);
        kbMsg('同步失败：' + ((e && e.message) || e) + '（先运行 run-mcp.cmd）', false);
      }
    };
  }

  // ---------------- AI 聊天分析（流式对话） ----------------
  // 流式走后台长连接 Port：内容脚本直连模型会撞 CORS / 私网限制，sendMessage 又是一次性的
  function openAiStream(messages, onDelta, cfg) {
    const port = chrome.runtime.connect({ name: 'aiStream' });
    let full = '';
    let settled = false;
    let keep = null;
    let watch = null;
    let lastDataAt = Date.now();
    const stopTimers = () => {
      if (keep) { clearInterval(keep); keep = null; }
      if (watch) { clearInterval(watch); watch = null; }
    };
    const promise = new Promise((resolve, reject) => {
      port.onMessage.addListener((m) => {
        if (!m || settled) return;
        if (m.type === 'delta') {
          lastDataAt = Date.now();
          full += m.text; onDelta(m.text);
        } else if (m.type === 'done') {
          settled = true; stopTimers();
          try { port.disconnect(); } catch (e) { /* ignore */ }
          resolve(full);
        } else if (m.type === 'error') {
          settled = true; stopTimers();
          try { port.disconnect(); } catch (e) { /* ignore */ }
          reject(new Error(m.error));
        }
      });
      port.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true; stopTimers();
        if (full) resolve(full);
        else reject(new Error('连接中断（后台被回收或网络异常）'));
      });
    });
    // 心跳：每 12 秒发一次消息，避免 MV3 后台在等待首个 token 时被回收
    keep = setInterval(() => {
      if (settled) return;
      try { port.postMessage({ type: 'ping' }); } catch (e) { stopTimers(); }
    }, 12000);
    // 看门狗：90 秒没有新内容就主动中止，避免界面一直“生成中”
    watch = setInterval(() => {
      if (settled) return;
      if (Date.now() - lastDataAt > 90000) {
        settled = true; stopTimers();
        try { port.postMessage({ type: 'abort' }); } catch (e) { /* ignore */ }
        try { port.disconnect(); } catch (e) { /* ignore */ }
        reject(new Error('生成超时（90 秒没有新内容），请稍后重试或缩小区间'));
      }
    }, 10000);
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
      '【会话清单（按消息数排序，列出全部 ' + Math.min(sessions.length, 200) + ' 个）】'];
    sessions.slice(0, 200).forEach((s) => {
      const rs = real(s);
      const first = rs.find((m) => !m.mine) || rs[0] || { c: '' };
      const last = rs[rs.length - 1] || { t: '' };
      out.push('- [' + s.name + '] ' + s.count + ' 条｜' + ((rs[0] || {}).t || '') + ' ~ ' + last.t + '｜客户首条：' + first.c.slice(0, 90));
    });
    // 近期原文只给消息量最大的 8 个会话，其余按清单判断（避免上下文过长）
    const excerpt = sessions.slice(0, 8);
    if (excerpt.length) out.push('', '【以下为消息量最大的 ' + excerpt.length + ' 个会话的近期原文】');
    excerpt.forEach((s) => {
      const ms = real(s).slice(-10);
      if (!ms.length) return;
      out.push('', '=== 会话：' + s.name + '（最近 ' + ms.length + ' 条）===');
      ms.forEach((m) => out.push(m.t + (m.mine ? ' 我：' : ' 客户：') + m.c.slice(0, 200)));
    });
    return out.join('\n');
  }

  // ---------------- 已导入询盘的待跟进客户 ----------------
  // 只读本机资料；仅用已确认订单或员工核实阶段判定成交。
  const FOLLOWUP_SCOPE = 'untouched';
  const FOLLOWUP_MAX = 20;        // 单次最多分析 20 位（控制上下文长度）
  const realMsgs = (s) => (s ? s.msgs.filter((m) => !m.sys && !isChatNoise(m.c)) : []);

  // 询盘客户 → 会话：先精确匹配，再退化到包含匹配（同名/公司名不完整的情况）
  function matchSession(sessions, name, company) {
    const keys = [normKey(name), normKey(company)].filter(Boolean);
    if (!keys.length) return null;
    let loose = null;
    for (const s of sessions || []) {
      const sk = normKey(s.name);
      if (!sk) continue;
      if (keys.indexOf(sk) >= 0) return s;
      if (!loose) {
        const hit = keys.some((k) => k.length >= 3 && sk.length >= 3 && (sk.indexOf(k) >= 0 || k.indexOf(sk) >= 0));
        if (hit && Math.min(sk.length, keys[0].length) >= 4) loose = s;
      }
    }
    return loose;
  }

  async function buildFollowupTargets(startDate, endDate, sessions, onProgress) {
    const result = await chrome.runtime.sendMessage({ type: 'localFollowupData' });
    if (!result || !result.ok) throw new Error((result && result.error) || '本机资料读取失败，请先在工作台导入文件');
    const data = result.data || {};
    const now = new Date();
    const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
    const parseActivity = (value) => {
      if (!value) return null;
      const date = new Date(String(value).replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/, '$1T$2'));
      return Number.isFinite(date.getTime()) ? date : null;
    };
    const inWindow = (value) => { const date = parseActivity(value); return !!(date && date >= windowStart && date <= now); };
    const begin = String(startDate || '').slice(0, 10);
    const finish = String(endDate || '').slice(0, 10);
    const stages = data.stages || {};
    const recentSessions = (sessions || []).filter((s) => {
      const real = realMsgs(s);
      const last = real[real.length - 1];
      return !!(last && !last.mine && inWindow(last.t));
    });
    const recentAt = new Map();
    const items = (data.inquiry || []).filter((r) => {
      const iid = String(r['询盘ID'] || '').trim();
      const session = matchSession(recentSessions, r['客户名称'] || r['联系人'], r['公司名称']);
      const real = realMsgs(session);
      const last = real[real.length - 1];
      const activity = [r['创建时间'], r['最新回复时间'], (stages[iid] || {}).at, last && last.t]
        .map(parseActivity).filter(Boolean).sort((a, b) => b - a)[0];
      if (!activity || !inWindow(activity)) return false;
      const day = [activity.getFullYear(), String(activity.getMonth() + 1).padStart(2, '0'), String(activity.getDate()).padStart(2, '0')].join('-');
      if ((begin && day < begin) || (finish && day > finish)) return false;
      recentAt.set(r, activity);
      return true;
    }).sort((a, b) => {
      const priority = (r) => String(r['回复状态'] || '') === '待回复' ? 1 : 0;
      return priority(b) - priority(a) || recentAt.get(b) - recentAt.get(a);
    });
    const crmRows = (data.customer || []).concat(data.public_customer || []);
    const crmByKey = new Map();
    crmRows.forEach((r) => {
      [r['公司名称'], r['联系人']].map(normKey).filter(Boolean).forEach((key) => {
        if (!crmByKey.has(key)) crmByKey.set(key, r);
      });
    });
    const wonIds = new Set((data.order || [])
      .filter((r) => /^(?:已付款|已完成|交易成功|paid|completed|finished)$/i.test(String(r['订单状态'] || '').trim()))
      .map((r) => String(r['询盘ID'] || '').trim()).filter(Boolean));
    const seen = new Set();
    const targets = [];
    let excluded = 0;
    for (const row of items) {
      if (targets.length >= FOLLOWUP_MAX) break;
      const iid = String(row['询盘ID'] || '').trim();
      const stage = stages[iid] || {};
      if (wonIds.has(iid) || (stage.stage === '已成交' && stage.evidence)) { excluded++; continue; }
      if (['已流失', '无效询盘'].includes(stage.stage) && stage.evidence) continue;
      const name = String(row['客户名称'] || row['联系人'] || '').trim();
      const company = String(row['公司名称'] || '').trim();
      if (!name && !company) continue;
      const dedup = normKey(company) || normKey(name);
      if (seen.has(dedup)) continue;
      const session = matchSession(sessions, name, company);
      const real = realMsgs(session);
      const lastReal = real[real.length - 1];
      const crm = crmByKey.get(normKey(company)) || crmByKey.get(normKey(name)) || {};
      seen.add(dedup);
      targets.push({
        name: name || company, company, country: String(row['国家'] || row['国家/地区'] || ''),
        level: String(row['买家等级'] || ''), golden: String(row['金牌买家'] || ''),
        added: String(row['是否已加为客户'] || ''), subject: String(row['询盘主题'] || ''),
        product: String(row['咨询产品'] || ''), createdAt: String(row['创建时间'] || ''),
        recentAt: recentAt.get(row).toLocaleString(), replyStatus: String(row['回复状态'] || ''),
        orderAmount: String(row['订单总额($)'] || '未知'), purchaseAmount: String(row['购买总金额'] || '未知'),
        crmOrders: String(crm['订单数'] || '未知'),
        profile: {
          company: company || String(crm['公司名称'] || ''),
          website: String(crm['公司网站'] || row['公司网站'] || ''),
          onboardingType: String(row['经营类型'] || ''),
          onboardingPref: String(row['采购偏好'] || ''),
          businessTypes: String(crm['经营类型'] || ''),
          preferred: String(crm['采购类目'] || ''),
          searchWords: String(row['搜索词'] || ''),
          crmOwner: String(crm['负责人'] || row['负责人'] || ''),
          crmFollow: String(crm['跟进状态'] || ''),
          crmNote: String(crm['最近备注'] || '').slice(0, 80),
        },
        session, hasChat: !!session && real.length > 0, lastMine: !!(lastReal && lastReal.mine),
        site: '', siteNote: '', search: [],
      });
    }
    if (onProgress) onProgress('已从本机资料筛选 ' + items.length + ' 条询盘，待跟进 ' + targets.length + ' 位');
    return { targets, total: items.length, excludedConverted: excluded, crmCustomers: crmRows.length };
  }

  // 交给模型的待跟进资料：询盘字段 + 客户画像 + 聊天摘录
  function buildFollowupContext(f) {
    const head = '【数据说明】以下为已导入本机的询盘、客户和聊天资料；未导入的最新平台变化可能缺失。只排除了有订单关联或员工核实依据的成交询盘。';
    const out = [head + '本次扫描询盘 ' + f.total + ' 条，筛出待跟进 ' + f.targets.length + ' 位'
      + '（已排除有成交依据 ' + f.excludedConverted + ' 条；客户库 ' + f.crmCustomers + ' 条）'];
    f.targets.forEach((t, i) => {
      const tags = [t.country, t.level, t.golden === '是' ? '金牌买家' : '', t.added === '是' ? '已加为客户' : '未加客户']
        .filter(Boolean).join(' / ') || '未知';
      out.push('');
      out.push('客户' + (i + 1) + '：' + t.name + (t.company && t.company !== t.name ? '（' + t.company + '）' : ''));
      out.push('国家/等级：' + tags);
      out.push('询盘：' + (t.subject || '无主题') + '｜产品：' + (t.product || '未知') + '｜创建：' + (t.createdAt || '未知')
        + '｜最近业务活动：' + t.recentAt + '｜回复状态：' + (t.replyStatus || '未知'));
      const p = t.profile || {};
      const facts = [
        p.onboardingType && ('入驻经营类型 ' + p.onboardingType),
        p.onboardingPref && ('入驻采购偏好 ' + p.onboardingPref),
        p.businessTypes && ('经营类型 ' + p.businessTypes),
        p.salesTypes && ('销售类型 ' + p.salesTypes),
        p.preferred && ('采购偏好 ' + p.preferred),
        p.searchWords && ('搜索词 ' + p.searchWords),
        p.registerDate && ('注册 ' + p.registerDate),
        p.loginDays && ('活跃 ' + p.loginDays + ' 天'),
        p.validInquiry && ('有效询盘 ' + p.validInquiry + (p.repliedInquiry ? '（已回复 ' + p.repliedInquiry + '）' : '')),
        p.validRfq && ('有效 RFQ ' + p.validRfq),
        p.productViews && ('产品浏览 ' + p.productViews),
        p.suppliers && ('合作供应商 ' + p.suppliers),
        p.buyerOrders && ('平台订单 ' + p.buyerOrders + ' 笔'),
        p.buyerOrderVolume && ('平台订单额 ' + p.buyerOrderVolume),
        p.highQuality && ('高质量标签 ' + p.highQuality),
        p.growth && ('成长等级 ' + p.growth),
      ].filter(Boolean).join('；');
      if (facts) out.push('背调（买家档案）：' + facts);
      const crmFacts = [
        p.crmGroup && ('分组 ' + p.crmGroup),
        p.crmImportance && ('重要程度 ' + p.crmImportance),
        p.crmFollow && ('跟进 ' + p.crmFollow),
        p.crmOwner && ('负责人 ' + p.crmOwner),
        p.annualProcurement && ('年采购额 ' + p.annualProcurement),
        p.taOrders && ('成交订单 ' + p.taOrders),
        p.taAmount && ('成交金额 ' + p.taAmount),
        p.lastBuy && ('最近成交 ' + p.lastBuy),
        p.repurchase && '复购客户',
        p.willLoss && '流失预警',
        p.potentialScore && ('潜力分 ' + p.potentialScore),
        p.crmNote && ('备注 ' + p.crmNote),
      ].filter(Boolean).join('；');
      if (crmFacts) out.push('背调（CRM）：' + crmFacts);
      if (p.recentRfq) out.push('近期 RFQ：' + p.recentRfq);
      if (p.recentProducts) out.push('近期询价产品：' + p.recentProducts);
      if (t.site) out.push('官网摘要：' + t.site);
      else if (p.website) out.push('公司官网：' + p.website + (t.siteNote ? '（' + t.siteNote + '）' : '（未抓到内容）'));
      if (t.search && t.search.length) {
        out.push('网络检索：' + t.search.slice(0, 4).map((x) => (x.title || '').slice(0, 70) + (x.snippet ? '｜' + x.snippet.slice(0, 110) : '')).join(' ｜ '));
      }
      out.push('交易线索：客户库订单数 ' + t.crmOrders + '｜买家平台累计订单额($) ' + t.orderAmount
        + '｜买家资料购买总金额 ' + t.purchaseAmount + '。这些累计字段不代表本店已成交订单。');
      if (t.hasChat) {
        out.push('聊天：' + (t.lastMine ? '最后一条是我方发的，客户尚未回复；摘录最近有效消息：' : '最后一条是客户发的，请优先核对是否需要我方回复；摘录最近有效消息：'));
        realMsgs(t.session).slice(-8).forEach((m) => out.push('  ' + m.t + (m.mine ? ' 我：' : ' 客户：') + m.c.slice(0, 200)));
      } else {
        out.push('聊天：本机该时间段没有匹配记录；可能尚未导入、会话名未关联或尚未进入对话。');
      }
    });
    return out.join('\n');
  }

  function buildFollowupSys(f) {
    return '你是资深外贸跟进顾问，服务一家阿里国际站供应商。\n'
      + '目标：先用平台资料做客户/公司背调，再给针对性跟进策略和一条高回复率消息。\n\n'
      + '【硬性规则】\n'
      + '1. 只分析下面名单里的客户；不得用买家累计金额或“已加为客户”推断本店成交。\n'
      + '1a. 今日待办只基于最近3个本机自然日（含今天）的业务活动；不要根据旧询盘或累计未联系天数生成任务。平台未同步时提示员工先更新并核实客户是否仍存在。\n'
      + '2. 事实与推断分开：资料里有明确字段的才算「已知事实」，并标注来源（买家档案 / CRM / 官网 / 网络检索 / 聊天 / 询盘）；由事实推导的算「合理推断」，必须写依据和置信度（高/中/低）。官网摘要和网络检索可能过期，只作线索。\n'
      + '3. 价格、交期、认证、库存必须标「【需人工确认】」，只给核实后的话术骨架，不写具体数字；业务员核实后才能发给客户。资料不足写「资料不足」，禁止编造公司规模、年采购量、员工人数。\n'
      + '4. 重点放在待回复、待确认报价和样品结果的客户；成交结论必须有订单或员工核实依据。\n'
      + '5. 每张卡的动作必须可直接执行（发 PI、催地址、确认色号、发参数表）。\n'
      + '6. script 要求 60-90 词、客户语言（默认英文）、像真人、含一个容易回答的问题；价格/交期/认证标【需人工确认】。\n'
      + '7. 资料不足写「资料不足」，禁止编造公司规模、年采购量、员工人数。\n\n'
      + buildFollowupContext(f);
  }

  const AI_HIST_KEY = 'aliChatAnalysis';   // 对话记录持久化：下次打开直接恢复，不重新开始
  const AI_PANEL_OPEN_KEY = 'aliAiPanelOpen';
  const AI_FOCUS_CARD_KEY = 'aliAiFocusCard';
  const activeAiWorkspace = async () => String((await chrome.storage.local.get('aliActiveWorkspace')).aliActiveWorkspace || 'default');
  const aiStateKey = (workspace, focus) => AI_HIST_KEY + ':' + encodeURIComponent(workspace)
    + (focus ? ':' + encodeURIComponent(focus) : '');
  const aiFocusCardKey = (workspace, focus) => AI_FOCUS_CARD_KEY + ':' + encodeURIComponent(workspace)
    + ':' + encodeURIComponent(focus);
  const aiPanelKey = (workspace) => AI_PANEL_OPEN_KEY + ':' + encodeURIComponent(workspace);
  const platformSyncAt = async (workspace) => (await self.AliSyncState.load(chrome.storage.local, workspace)).syncAtMs;

  // 其他操作面板互斥；右侧 AI 客户助手独立保留，便于边看分析边回复。
  function closeFeaturePanels(exceptId) {
    ['ali-dt-box', 'ali-expo-box'].forEach((id) => {
      if (exceptId && id === exceptId) return;
      const el = document.getElementById(id);
      if (el) el.remove();
    });
  }

  async function openChatAnalysis(startDate, endDate) {
    closeFeaturePanels('ali-ai-box');
    const old = document.getElementById('ali-ai-box');
    if (old) return;
    const cfg = await loadAiCfg();
    const cfgReady = !!(cfg && cfg.baseUrl && cfg.apiKey && cfg.model);
    const focusName = await currentAiFocusName();
    const workspace = await activeAiWorkspace();
    const stateKey = aiStateKey(workspace, focusName);
    const focusCardKey = aiFocusCardKey(workspace, focusName);
    const focusSaved = focusName ? await chrome.storage.local.get(focusCardKey).catch(() => ({})) : {};
    const focusCard = focusSaved[focusCardKey] && focusSaved[focusCardKey].customer === focusName
      ? focusSaved[focusCardKey] : null;
    const box = document.createElement('div');
    box.id = 'ali-ai-box';
    box.style.cssText = 'position:fixed;right:12px;top:12px;z-index:2147483001;width:min(430px,45vw);height:calc(100vh - 24px);' +
      'display:flex;flex-direction:column;background:#fff;border:1px solid #e5e7eb;border-radius:12px;' +
      'box-shadow:0 10px 40px rgba(0,0,0,.18);font:13px/1.6 "Microsoft YaHei",sans-serif;color:#111;overflow:hidden;';
    box.innerHTML =
      '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:9px 12px;border-bottom:1px solid #f0f0f0;">' +
      '<b style="white-space:nowrap;">AI 客户助手 · 聊天分析</b>' +
      '<span id="ali-ai-prog" style="color:#6b7280;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">准备中…</span>' +
      '<span style="flex:1"></span>' +
      '<button id="ali-ai-toggle" style="border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;white-space:nowrap;">收起 ▴</button>' +
      '<button id="ali-ai-copy2" style="border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;">复制</button>' +
      '<button id="ali-ai-settings" style="border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;">AI 设置</button>' +
      '<button id="ali-ai-exp" style="border:0;background:#4f46e5;color:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;">导出</button>' +
      '<button id="ali-ai-close2" style="border:0;background:#f3f4f6;border-radius:6px;padding:3px 8px;cursor:pointer;">关闭</button></div>' +
      '<div id="ali-ai-focus" style="display:none;padding:9px 12px;border-bottom:1px solid #dbeafe;background:#eff6ff;"></div>' +
      '<div id="ali-ai-body" style="flex:1;min-height:0;display:flex;flex-direction:column;">' +
      '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid #f5f5f5;background:#fafafa;">' +
      '<span style="color:#6b7280;font-size:12px;white-space:nowrap;">分析范围</span>' +
      '<select id="ali-ai-scope" style="flex:1;min-width:110px;padding:4px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;"></select>' +
      '<span id="ali-ai-ctx" style="color:#9ca3af;font-size:11px;white-space:nowrap;"></span>' +
      '<button id="ali-ai-again" style="border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;white-space:nowrap;">重新分析</button>' +
      '<button id="ali-ai-perm" style="display:none;border:1px solid #f59e0b;background:#fffbeb;color:#b45309;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;white-space:nowrap;">授权抓官网</button>' +
      '<button id="ali-ai-recollect" style="border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;white-space:nowrap;">重新采集</button>' +
      '<button id="ali-ai-wipe" style="border:1px solid #fca5a5;background:#fff;color:#b91c1c;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;white-space:nowrap;">清空记录</button></div>' +
      '<div id="ali-ai-log" style="flex:1;overflow:auto;padding:12px 14px;background:#fff;"></div>' +
      '<div style="padding:4px 12px;color:#9ca3af;font-size:11px;border-top:1px solid #f0f0f0;">AI 仅辅助：价格、交期、认证等需人工核实后再发送给客户</div>' +
      '<div style="border-top:1px solid #f0f0f0;padding:8px 12px;display:flex;gap:8px;align-items:flex-end;">' +
      '<textarea id="ali-ai-in" placeholder="继续追问，例如：这个客户该怎么回？（Enter 发送，Shift+Enter 换行）" ' +
      'style="flex:1;min-height:54px;max-height:140px;padding:8px;border:1px solid #d1d5db;border-radius:8px;font:12.5px/1.6 inherit;resize:vertical;box-sizing:border-box;"></textarea>' +
      '<button id="ali-ai-send" style="border:0;background:#2563eb;color:#fff;border-radius:8px;padding:8px 13px;cursor:pointer;white-space:nowrap;">发送</button>' +
      '<button id="ali-ai-stop" style="border:1px solid #d1d5db;background:#fff;border-radius:8px;padding:8px 11px;cursor:pointer;white-space:nowrap;" disabled>停止</button></div>' +
      '</div>' +
      '<div id="ali-ai-mini" style="display:none;padding:7px 12px;color:#6b7280;font-size:12px;"></div>';
    document.body.appendChild(box);
    const sideHandle = document.getElementById('ali-ai-sidecar-handle');
    if (sideHandle) sideHandle.style.display = 'none';
    const $ = (id) => box.querySelector('#' + id);
    if (focusName) {
      const focus = $('ali-ai-focus');
      focus.style.display = 'block';
      const title = document.createElement('b');
      title.textContent = '当前客户 · ' + focusName;
      focus.appendChild(title);
      const facts = [focusCard && focusCard.reason, focusCard && focusCard.interaction,
        focusCard && focusCard.behavior, focusCard && focusCard.value, focusCard && focusCard.background].filter(Boolean);
      if (facts.length) {
        const detail = document.createElement('div');
        detail.style.cssText = 'max-height:110px;overflow:auto;color:#40536b;font-size:11px;margin-top:4px;white-space:pre-wrap;';
        detail.textContent = facts.join(' · ');
        focus.appendChild(detail);
      }
      if (focusCard && focusCard.script) {
        const copy = document.createElement('button');
        copy.type = 'button'; copy.textContent = '复制已生成话术';
        copy.style.cssText = 'margin-top:6px;padding:4px 8px;border:1px solid #b6cff2;border-radius:6px;background:#fff;color:#1753ab;cursor:pointer;';
        copy.onclick = () => navigator.clipboard.writeText(focusCard.script)
          .then(() => toast('话术已复制，请核对后发送')).catch(() => toast('复制失败', true));
        focus.appendChild(copy);
      }
      const caution = document.createElement('div');
      caution.style.cssText = 'margin-top:5px;color:#66788e;font-size:11px;';
      caution.textContent = '分析依据为已导入资料；发送前请核对聊天窗口中的最新消息。';
      focus.appendChild(caution);
    }
    chrome.storage.local.set({ [aiPanelKey(workspace)]: true }).catch(() => {});
    const log = $('ali-ai-log');
    const prog = (t) => { const el = $('ali-ai-prog'); if (el) el.textContent = t; };

    let sessions = [];
    let hist = [];
    let busy = false;
    let collapsed = false;
    let cur = null;
    let followupCache = null;   // 本机待跟进名单缓存（按时间范围）
    let followupKey = '';

    const rounds = () => hist.filter((m) => m.role === 'assistant').length;
    const scopeLabel = () => {
      const v = $('ali-ai-scope').value || '';
      if (v === FOLLOWUP_SCOPE) return '待跟进询盘客户（本机资料）';
      return v.indexOf('session:') === 0 ? ('会话「' + v.slice(8) + '」') : '全部会话概览';
    };
    const addMsg = (role, text) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:10px;';
      const meta = document.createElement('div');
      meta.textContent = role === 'user' ? '我' : 'AI';
      meta.style.cssText = 'font-size:11px;color:#9ca3af;margin-bottom:2px;';
      const body = document.createElement('div');
      const todo = role === 'assistant' ? parseTodoJson(text) : null;
      if (todo) {
        body.style.cssText = 'padding:8px 11px;border-radius:9px;background:#f7f8fa;border:1px solid #eef1f4;';
        renderTodoCards(todo, body);
      } else {
        body.textContent = text || '';
        body.style.cssText = 'white-space:pre-wrap;word-break:break-word;padding:8px 11px;border-radius:9px;font-size:12.5px;line-height:1.66;' +
          (role === 'user' ? 'background:#eff6ff;color:#1e3a8a;' : 'background:#f7f8fa;border:1px solid #eef1f4;');
      }
      wrap.appendChild(meta); wrap.appendChild(body);
      log.appendChild(wrap);
      log.scrollTop = log.scrollHeight;
      return body;
    };
    const renderHist = () => { log.innerHTML = ''; hist.forEach((m) => addMsg(m.role, m.content)); };
    const fillScope = (want) => {
      const total = sessions.reduce((n, s) => n + s.count, 0);
      if (focusName) {
        $('ali-ai-scope').innerHTML = sessions.length
          ? '<option value="session:' + sessions[0].name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') + '">当前客户会话 · ' + sessions[0].name.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '（' + total + ' 条）</option>'
          : '<option value="">未匹配到该客户的聊天记录</option>';
        return;
      }
      const fuLabel = followupCache
        ? ('待跟进询盘客户 · 本机资料（' + followupCache.targets.length + ' 位）')
        : '待跟进询盘客户 · 本机资料';
      $('ali-ai-scope').innerHTML = [
        ['', '全部会话概览（' + sessions.length + ' 个会话 / ' + total + ' 条）'],
        [FOLLOWUP_SCOPE, fuLabel],
      ].concat(sessions.slice(0, 200).map((s) => ['session:' + s.name, '会话 · ' + s.name + '（' + s.count + ' 条）']))
        .map(([v, t]) => '<option value="' + String(v).replace(/"/g, '&quot;') + '">' + String(t).replace(/</g, '&lt;') + '</option>').join('');
      if (want) {
        const has = Array.prototype.some.call($('ali-ai-scope').options, (o) => o.value === want);
        $('ali-ai-scope').value = has ? want : '';
      }
    };
    const focusScope = () => {
      const match = focusName ? matchSession(sessions, focusName, '') : null;
      return match ? 'session:' + match.name : '';
    };
    const refreshCtx = () => {
      if ($('ali-ai-scope').value === FOLLOWUP_SCOPE) {
        $('ali-ai-ctx').textContent = followupCache
          ? ('已筛出 ' + followupCache.targets.length + ' 位待跟进')
          : '点「重新分析」按询盘+客户资料筛选';
        return;
      }
      $('ali-ai-ctx').textContent = sessions.length ? ('约 ' + buildChatContext(sessions, $('ali-ai-scope').value).length + ' 字数据') : '';
    };
    const saveState = async () => {
      try {
        await chrome.storage.local.set({ [stateKey]: {
          ts: localStamp(), range: [startDate || '', endDate || ''],
          scope: $('ali-ai-scope').value, focusName, collapsed, hist, sessions,
          todoRulesVersion: 3, syncAtMs: Number(await platformSyncAt(workspace) || 0),
        } });
      } catch (e) { /* 存不下也不影响本次使用 */ }
    };
    const loadState = async () => {
      try { const o = await chrome.storage.local.get(stateKey); return o && o[stateKey]; } catch (e) { return null; }
    };
    const setCollapsed = (v) => {
      collapsed = !!v;
      $('ali-ai-body').style.display = collapsed ? 'none' : 'flex';
      $('ali-ai-mini').style.display = collapsed ? 'block' : 'none';
      $('ali-ai-toggle').textContent = collapsed ? '展开 ▾' : '收起 ▴';
      box.style.height = collapsed ? 'auto' : 'calc(100vh - 24px)';
      box.style.width = collapsed ? 'min(330px, calc(100vw - 24px))' : 'min(430px, calc(100vw - 24px))';
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

    // 官网抓取已改走本地 MCP，不再需要浏览器域名授权；该按钮保留但始终隐藏
    const updatePermBtn = async () => {
      const el = $('ali-ai-perm');
      if (el) el.style.display = 'none';
    };

    // 本机待跟进名单按需读取并缓存（同一时间范围只读取一次）
    const ensureFollowup = async () => {
      const key = new Date().toDateString() + '~' + (startDate || '') + '~' + (endDate || '');
      if (followupCache && followupKey === key) return followupCache;
      prog('筛选本机待跟进询盘…');
      const f = await buildFollowupTargets(startDate, endDate, sessions, (m) => prog(m));
      followupCache = f;
      followupKey = key;
      fillScope(FOLLOWUP_SCOPE);
      refreshCtx();
      updatePermBtn();
      return f;
    };

    const ask = async (text, jsonMode) => {
      text = String(text || '').trim();
      if (!text || busy) return;
      if (!cfgReady) { prog('请先在 AI 设置中配置模型，再打开右侧助手'); return; }
      if (focusName && !focusScope()) { prog('未匹配到该客户的本机聊天记录，请先导入或更新聊天资料'); return; }
      const untouch = $('ali-ai-scope').value === FOLLOWUP_SCOPE;
      if (!untouch && !sessions.length) return;
      hist.push({ role: 'user', content: text });
      addMsg('user', text);
      const body = addMsg('assistant', '生成中…');
      busy = true; setBtns();
      let full = '';
      let sys = '';
      try {
        if (untouch) {
          const f = await ensureFollowup();
          if (!f.targets.length) {
            const msg = '该时间段没有筛出待跟进客户。请检查询盘、聊天是否已导入，以及日期和阶段是否正确。';
            body.textContent = msg; body.style.color = '#b45309';
            hist.push({ role: 'assistant', content: msg });
            prog('没有待跟进客户');
            return;
          }
          prog('已筛出 ' + f.targets.length + ' 位，生成跟进话术…');
          sys = buildFollowupSys(f);
        } else if (focusName) {
          const cardContext = focusCard ? [focusCard.reason, focusCard.interaction, focusCard.behavior,
            focusCard.value, focusCard.background, focusCard.script].filter(Boolean).join('；').slice(0, 2500) : '';
          sys = '你是外贸业务员的客户回复助手。当前客户：' + focusName + '。只分析下面这一位客户的本机聊天记录，不得借用其他客户资料。'
            + '先区分已知事实、推断和待核实事项；聊天记录有日期，旧消息不得当成最新状态。'
            + '给出客户当前需求、可能阻碍、下一步动作，以及一段可供员工核对后发送的英文回复草稿。'
            + '价格、交期、认证、库存等须标【需人工确认】，没有依据不得填写具体数字；不得自动发送。'
            + (cardContext ? '工作台曾生成的参考卡片（仅作线索，须以聊天原文核实）：' + cardContext + '\n\n' : '')
            + buildChatContext(sessions, $('ali-ai-scope').value);
        } else {
          sys = '你是该公司的外贸业务员助手，基于已导出的聊天记录与询盘数据做分析。'
            + '只依据下面提供的真实聊天记录回答，不要编造；数据不足时说明还缺什么。中文、结论先行，话术要能直接用。'
            + '价格、交期、认证、库存等敏感信息必须标「【需人工确认】」，不要写具体数字，业务员核实后再发给客户。'
            + '仅以订单或员工核实依据判定成交；优先分析待回复、待确认报价和样品结果的客户。'
            + '会话清单已列出全部会话；只有前 8 个带近期原文摘录，其余请按清单判断并说明信息不足，不要说“数据未提供”。\n\n'
            + '当前分析范围：' + scopeLabel() + '\n\n' + buildChatContext(sessions, $('ali-ai-scope').value);
        }
        if (jsonMode) sys += '\n\n' + TODO_JSON_RULES;
        cur = openAiStream([{ role: 'system', content: sys }].concat(hist.slice(-12)), (d) => {
          full += d;
          if (jsonMode) {
            body.textContent = '生成中…（结构化待办 ' + full.length + ' 字）';
          } else {
            if (full.length === d.length) body.textContent = '';
            body.textContent += d;
            log.scrollTop = log.scrollHeight;
          }
        }, cfg);
        await cur.promise;
        if (full) {
          const todo = jsonMode ? parseTodoJson(full) : null;
          if (todo) renderTodoCards(todo, body);
          else body.textContent = full;
          hist.push({ role: 'assistant', content: full });
        }
        prog('完成 ✅（' + rounds() + ' 轮）');
      } catch (e) {
        const msg = (e && e.message) || String(e);
        if (full) {
          hist.push({ role: 'assistant', content: full });
          prog('中断：' + msg);
        } else if (sys && /连接中断|生成超时/.test(msg)) {
          // 流式通道断了（MV3 后台被回收 / 网络抖动）：自动降级为非流式再试一次
          body.textContent = '流式连接中断，正在改用非流式重试…';
          try {
            const t = await callAi([{ role: 'system', content: sys }].concat(hist.slice(-12)), { cfg });
            full = t;
            const todo = jsonMode ? parseTodoJson(t) : null;
            if (todo) { body.textContent = ''; renderTodoCards(todo, body); }
            else body.textContent = t;
            body.style.color = '';
            hist.push({ role: 'assistant', content: t });
            prog('完成 ✅（非流式回退）');
          } catch (e2) {
            const m2 = (e2 && e2.message) || String(e2);
            body.textContent = '失败：' + m2;
            body.style.color = '#b91c1c';
            prog('失败：' + m2);
          }
        } else {
          body.textContent = '失败：' + msg;
          body.style.color = '#b91c1c';
          prog('失败：' + msg);
        }
      } finally {
        busy = false; cur = null; setBtns(); saveState();
        if (collapsed) { $('ali-ai-mini').textContent = '已保留 ' + rounds() + ' 轮对话 · 点「展开」继续追问'; }
      }
    };
    const runAnalysis = () => {
      if (focusName && !focusScope()) { prog('未匹配到该客户会话；请先导入或更新聊天资料'); return; }
      if (!cfgReady) { prog('请先配置 AI 模型；客户卡片与本机聊天范围仍可查看'); return; }
      hist = [];
      renderHist();
      saveState();
      prog('分析中…');
      if (focusName) {
        ask('请结合该客户的最近聊天记录分析当前状态，给出一条下一步动作和一段可核对后发送的英文回复草稿。', false);
        return;
      }
      if ($('ali-ai-scope').value === FOLLOWUP_SCOPE) {
        ask('按规则输出待办卡片：重点待回复、待确认报价和样品结果的客户。', true);
        return;
      }
      ask('请概览所选会话。只有最近3个本机自然日（含今天）存在客户新消息或询盘变化时才列入今日待办；其余历史内容只作背景。成交只认已核实依据。', true);
    };
    const conversationText = () => hist.map((m) => {
      if (m.role === 'assistant') {
        const o = parseTodoJson(m.content);
        if (o) return 'AI：' + todoToText(o);
      }
      return (m.role === 'user' ? '我：' : 'AI：') + m.content;
    }).join('\n\n');

    const collectAndAnalyze = async () => {
      try {
        prog('读取本机聊天资料…');
        const r = await chrome.runtime.sendMessage({ type: 'localChatData', startDate, endDate });
        if (!r || !r.ok) throw new Error((r && r.error) || '本机资料读取失败');
        let rows = r.rows || [];
        if (focusName) {
          let matched = matchSession(groupChatRows(rows), focusName, '');
          if (!matched && (startDate || endDate)) {
            const all = await chrome.runtime.sendMessage({ type: 'localChatData', startDate: '', endDate: '' });
            if (all && all.ok) {
              const historical = matchSession(groupChatRows(all.rows || []), focusName, '');
              if (historical) { matched = historical; rows = all.rows || []; startDate = ''; endDate = ''; }
            }
          }
          sessions = matched ? [matched] : [];
          fillScope(focusScope());
          refreshCtx();
          if (!matched) {
            prog('本机未匹配到「' + focusName + '」的聊天记录；请先导入或更新该客户资料');
            return;
          }
          prog('已匹配当前客户 ' + matched.count + ' 条聊天记录，开始分析…');
          runAnalysis();
          return;
        }
        if (!rows.length) {
          sessions = [];
          fillScope('');
          refreshCtx();
          prog('本机没有该时间段的聊天记录；可先导入文件，或查看待跟进询盘。');
          return;
        }
        sessions = groupChatRows(rows);
        fillScope(focusScope());
        refreshCtx();
        prog('已读取本机资料 ' + rows.length + ' 条，开始分析…');
        runAnalysis();
      } catch (e) {
        prog('读取失败：' + e.message + '。请先在工作台导入聊天文件。');
      }
    };

    $('ali-ai-toggle').onclick = () => { setCollapsed(!collapsed); saveState(); };
    $('ali-ai-close2').onclick = () => { if (cur) cur.abort(); saveState(); box.remove(); if (sideHandle) sideHandle.style.display = ''; chrome.storage.local.set({ [aiPanelKey(workspace)]: false }).catch(() => {}); };
    $('ali-ai-scope').onchange = () => { refreshCtx(); updatePermBtn(); saveState(); };
    $('ali-ai-again').onclick = () => {
      if (busy) return;
      if ($('ali-ai-scope').value === FOLLOWUP_SCOPE || sessions.length) runAnalysis();
    };
    $('ali-ai-perm').onclick = () => {
      try { chrome.runtime.sendMessage({ type: 'openOptions' }); }
      catch (e) { toast('请到扩展详情页点「扩展选项」后授权', true); }
    };
    $('ali-ai-recollect').onclick = () => { if (!busy) { followupCache = null; followupKey = ''; collectAndAnalyze(); } };
    $('ali-ai-wipe').onclick = async () => {
      if (busy) return;
      hist = []; sessions = []; renderHist(); fillScope(''); refreshCtx();
      try { await chrome.storage.local.remove(stateKey); } catch (e) { /* ignore */ }
      prog('已清空，可点「重新采集」');
    };
    $('ali-ai-stop').onclick = () => { if (cur) cur.abort(); };
    $('ali-ai-copy2').onclick = () => {
      const v = conversationText();
      if (!v) { toast('还没有内容', true); return; }
      navigator.clipboard.writeText(v).then(() => toast('已复制对话')).catch(() => toast('复制失败', true));
    };
    $('ali-ai-settings').onclick = () => chrome.runtime.sendMessage({ type: 'openOptions' });
    $('ali-ai-exp').onclick = async (e) => {
      const v = hist.filter((m) => m.role === 'assistant').map((m) => {
        const o = parseTodoJson(m.content);
        return o ? todoToText(o) : m.content;
      }).join('\n\n');
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
    const currentSyncAt = await platformSyncAt(workspace).catch(() => 0);
    const staleDaily = !focusName && saved && (saved.todoRulesVersion !== 3
      || String(saved.ts || '').slice(0, 10) !== localStamp().slice(0, 10)
      || Number(currentSyncAt || 0) > Number(saved.syncAtMs || 0));
    if (saved && !staleDaily && saved.hist && saved.hist.length && String(saved.focusName || '') === focusName) {
      hist = saved.hist;
      sessions = saved.sessions || [];
      fillScope(focusScope() || saved.scope);
      renderHist();
      refreshCtx();
      updatePermBtn();
      setCollapsed(!!saved.collapsed);
      prog('已恢复 ' + (saved.ts || '上次') + ' 的对话（' + rounds() + ' 轮）｜数据范围 ' + ((saved.range || []).join(' ~ ') || '—'));
      if (focusName) {
        try {
          const latest = await chrome.runtime.sendMessage({ type: 'localChatData', startDate: '', endDate: '' });
          const current = latest && latest.ok ? matchSession(groupChatRows(latest.rows || []), focusName, '') : null;
          if (current) {
            const previous = sessions[0];
            const oldLast = previous && previous.msgs && previous.msgs.length ? previous.msgs[previous.msgs.length - 1].t : '';
            const newLast = current.msgs.length ? current.msgs[current.msgs.length - 1].t : '';
            sessions = [current]; fillScope(focusScope()); refreshCtx();
            if (!previous || current.count !== previous.count || newLast !== oldLast) {
              prog('本机聊天记录有更新；历史分析仅供参考，请点「重新分析」');
            }
          } else {
            prog('历史分析已恢复，但本机未匹配到该客户当前聊天资料；请先更新数据');
          }
        } catch (e) { prog('历史分析已恢复；暂无法核对本机聊天资料，请核对最新消息'); }
      }
      return;
    }
    await collectAndAnalyze();
  }

  // ---------------- 非主营成品需求 · AI 跟进（半自动回复，示例） ----------------
  // 判定口径：只认「买家说过」的成品/整机类词；我方消息不单独判定，避免误命中
  // 候选词仅为示例，请按你的行业替换；最终分类由 AI 判断
  const FINISHED_RE = /(finished\s+goods|ready[-\s]?made|end\s+products?|complete\s+(?:units?|sets?)|turnkey|成品|整机|现货|代工)/gi;
  const CUSTOMER_TYPE_LABEL = {
    type_a: '客户类型 A', type_b: '客户类型 B', distributor: '经销商', oem: 'OEM/贴牌', unknown: '未识别',
  };

  const SEND_API_KEY = 'aliSendApi';        // 抓取到的发送请求模板
  const PENDING_SEND_KEY = 'aliPendingSend'; // 列表页点发送 → 聊天窗口加载后自动发送
  const SMART_REPLY_KEY = 'aliSmartReply';   // 工作台人工确认的询盘回复 → 聊天窗口加载后发送
  const SMART_REPLY_RESULT_KEY = 'aliSmartReplyResult';
  const INBOX_PROBE_KEY = 'aliInboxProbe';   // 工作台「只定位不发送」测试
  const INBOX_PROBE_RESULT_KEY = 'aliInboxProbeResult';
  const INBOX_AUTOTEST_KEY = 'aliInboxAutoTest'; // 工作台「自动测试」队列
  const INBOX_AUTOTEST_RESULT_KEY = 'aliInboxAutoTestResult';
  const FINISHED_LOG_KEY = 'aliFinishedLog';  // { date, count, customers:{客户键: 最后客户消息时间} }
  const SEND_MAX_PER_DAY = 20;              // 保守：全局每天 20 条
  const SEND_GAP_MIN = 8000, SEND_GAP_MAX = 20000; // 每条之间随机 8-20 秒
  const dayKey = () => new Date().toISOString().slice(0, 10);

  // 带联系人元数据的会话采集：发送必须要 accountId / accountIdEncrypt（导出行里没有）
  async function collectChatSessions(startDate, endDate, onProgress) {
    const startTs = toTs(startDate, false);
    const endTs = endDate ? toTs(endDate, true) : Date.now();
    const out = [];
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
          out.push({
            name: String(ct.name || ct.loginId || ct.accountId || '未知客户'),
            acct: { accountId: acct.accountId, enc: acct.accountIdEncrypt, name: String(acct.name || '') },
            ct: { accountId: ct.accountId, enc: ct.accountIdEncrypt, loginId: String(ct.loginId || '') },
            msgs: msgs.map((m) => ({
              ts: m.sendTime || 0,
              t: fmtDate(m.sendTime, '-'),
              mine: String(m.messageType || '').toLowerCase() !== 'rec',
              c: String(m.content || '').replace(/\s+/g, ' ').trim(),
            })).filter((m) => m.c),
          });
          done++;
          if (onProgress) onProgress(done, out.length);
          await pace();
        }
        if (contacts.length < PAGE_SIZE) break;
        await pace();
      }
    }
    out.sort((a, b) => lastBuyerTs(b) - lastBuyerTs(a));
    return out;
  }
  function lastBuyerTs(s) {
    for (let i = s.msgs.length - 1; i >= 0; i--) if (!s.msgs[i].mine) return s.msgs[i].ts || 0;
    return 0;
  }
  function finishedHit(s) {
    const hits = new Set();
    let buyer = 0, ours = 0;
    for (const m of s.msgs) {
      if (isChatNoise(m.c)) continue;
      const found = m.c.match(FINISHED_RE);
      if (!found || !found.length) continue;
      found.forEach((x) => hits.add(String(x).toLowerCase()));
      if (m.mine) ours += found.length; else buyer += found.length;
    }
    return { score: buyer * 2 + ours, buyer, ours, hits: Array.from(hits) };
  }
  function parseAiJson(t) {
    const s = String(t || '').replace(/```json/gi, '```').replace(/```/g, '');
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('模型未返回 JSON');
    return JSON.parse(s.slice(a, b + 1));
  }
  function transcriptOf(s, n) {
    return s.msgs.filter((m) => !isChatNoise(m.c)).slice(-(n || 40))
      .map((m) => m.t + (m.mine ? ' 我方：' : ' 客户：') + m.c.slice(0, 300)).join('\n');
  }
  async function analyzeFinished(sess, cfg) {
    const sys = '你是阿里国际站供应商的外贸助理。\n\n'
      + '【公司产品】\n'
      + '（示例占位：请替换为你自己的产品线）\n'
      + '1) 主营产品线 A：产品 A1 / A2\n'
      + '2) 主营产品线 B：产品 B1 / B2\n'
      + '3) 配套服务：安装、培训、技术支持\n'
      + '4) OEM / 贴牌：按需定制\n\n'
      + '【目标客户】\n'
      + '- type_a：客户类型 A\n'
      + '- type_b：客户类型 B\n'
      + '- distributor：经销商\n'
      + '- oem：OEM / 贴牌\n\n'
      + '【公司不做】不生产、不销售非主营的成品，也不承接相关加工。\n'
      + '【语言】客户可能使用西班牙语/葡萄牙语/法语/德语/意大利语/俄语/阿拉伯语/土耳其语/越南语/泰语/印尼语/韩语/日语，请用客户语言理解并回复。\n\n'
      + '【分类】\n'
      + '- target：客户在采购主营产品、设备、材料或技术支持\n'
      + '- mismatch_finished：客户要的是非主营的成品/整机，或外包加工\n'
      + '- unclear：信息不足，无法判断\n\n'
      + '只输出严格 JSON（不要 markdown 代码块）：\n'
      + '{"category":"target|mismatch_finished|unclear",'
      + '"customer_type":"type_a|type_b|distributor|oem|unknown",'
      + '"need_reply":true/false,"reason":"中文一句话",'
      + '"intent":"询价|索样|确认规格|催货|售后|闲聊|其他","stage":"新询盘|报价中|打样|待成交|售后",'
      + '"language":"en","reply":"给客户的回复原文","risk":"需要人工确认的点，没有则空"}\n'
      + '规则：\n'
      + '- 只有 mismatch_finished 才生成婉拒回复；target 和 unclear 的 reply 留空、need_reply=false\n'
      + '- 客户身份按对话判断；判断不了就填 unknown\n'
      + '- 婉拒话术：用客户语言；25-60 词；像真人业务员在聊天，不要像公司声明或法律条款；'
      + '友好、自然、简短；英文用缩写；不要以 Dear 开头\n'
      + '- 结构：先感谢/回应 → 轻松说明我们不做该类成品 → 一句话说我们主营什么 → 友好收尾\n'
      + '- 不推销、不报价、不承诺样品；不提及 AI\n'
      + '- 若聊天里我方已经明确拒绝过，need_reply=false，reply 留空';

    const user = '客户：' + sess.name + '\n聊天记录：\n' + transcriptOf(sess, 40);
    const txt = await callAi([{ role: 'system', content: sys }, { role: 'user', content: user }], { cfg });
    return parseAiJson(txt);
  }
  async function loadSendApi() {
    try { const o = await chrome.storage.local.get(SEND_API_KEY); return (o && o[SEND_API_KEY]) || null; } catch (e) { return null; }
  }
  // 用抓到的请求做模板：把抓包里的探针文本替换成实际回复（同时覆盖 JSON 转义 / URL 编码两种形态）
  function buildSendBody(tpl, text) {
    const esc = (v) => JSON.stringify(String(v)).slice(1, -1);
    const probe = String(tpl.probeText || '');
    if (!probe) return '';
    const from = [probe, esc(probe), encodeURIComponent(probe), encodeURIComponent(esc(probe))];
    const to = [text, esc(text), encodeURIComponent(text), encodeURIComponent(esc(text))];
    let body = String(tpl.body || '');
    let hit = false;
    from.forEach((v, i) => { if (v && body.indexOf(v) >= 0) { body = body.split(v).join(to[i]); hit = true; } });
    if (!hit) return '';
    // CSRF 可能随会话变化，能识别就换成当前值
    const t = tokens();
    if (t.csrf) {
      body = body.replace(/(_csrf_token_=)[^&]*/g, '$1' + encodeURIComponent(t.csrf))
        .replace(/(_csrf=)[^&]*/g, '$1' + encodeURIComponent(t.csrf));
    }
    return body;
  }
  async function sendMessageNow(tpl, text) {
    if (tpl.via === 'ws') throw new Error('抓到的发送走 WebSocket，当前版本暂不支持自动发送；请复制话术后手动粘贴发送');
    const body = buildSendBody(tpl, text);
    if (!body) throw new Error('发送模板里找不到探针文本，请重新抓取');
    const headers = Object.assign({}, onetalkHeaders(), tpl.headers || {});
    delete headers['content-length']; delete headers['Content-Length'];
    return request(tpl.url, tpl.method || 'POST', headers, body);
  }

  // ---------------- 页面模拟发送（接口抓不到时的兜底） ----------------
  const uiWait = (ms) => new Promise((r) => setTimeout(r, ms));
  // 同源 iframe 也一起找（聊天区可能在 iframe 里）
  function allDocs() {
    const out = [document];
    const walk = (doc) => {
      let fs = [];
      try { fs = Array.from(doc.querySelectorAll('iframe')); } catch (e) { return; }
      fs.forEach((f) => {
        try { const d = f.contentDocument; if (d) { out.push(d); walk(d); } } catch (e) { /* 跨域忽略 */ }
      });
    };
    walk(document);
    return out;
  }
  function uiVisible(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const w = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const s = w.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    } catch (e) { return false; }
  }
  // 排除扩展自己的面板：AI 分析/设置、婉拒面板、工作台、侧边入口
  function uiInOurPanel(el) {
    return !!(el && el.closest && (
      el.closest('#ali-ai-box') || el.closest('#ali-dt-box') || el.closest('#ali-expo-box') ||
      el.closest('#ali-export-panel') || el.closest('#ali-dock')
    ));
  }
  const uiText = (el) => String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  function uiClick(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    try { el.click(); return true; } catch (e) { /* ignore */ }
    try {
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window };
      el.dispatchEvent(new MouseEvent('mousedown', o));
      el.dispatchEvent(new MouseEvent('mouseup', o));
      el.dispatchEvent(new MouseEvent('click', o));
      return true;
    } catch (e) { return false; }
  }
  function uiDoubleClick(el) {
    if (!el) return false;
    try {
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch (e) { return false; }
  }
  function uiFindOtherContact(except) {
    for (const d of allDocs()) {
      let els = [];
      try { els = Array.from(d.querySelectorAll('li.contact-item, [class*="contact-item"]')); } catch (e) { continue; }
      const hit = els.find((el) => el !== except && uiVisible(el) && !uiInOurPanel(el)
        && el.getBoundingClientRect().left < window.innerWidth * 0.45);
      if (hit) return hit;
    }
    return null;
  }
  const UI_ITEM_SEL = 'li.contact-item, [class*="contact-item"], [class*="conversation-item"], [class*="session-item"], [class*="result-item"], [class*="search-item"], [class*="search-result"], [class*="searchResult"], [role="listitem"], [role="option"], li';
  function uiMatchConversation(el, sess) {
    const t = uiText(el);
    if (!t || t.length > 600) return false;   // 只排除包住整列的大容器
    const keys = [sess && sess.name, sess && sess.ct && sess.ct.loginId, sess && sess.ct && sess.ct.accountId]
      .filter(Boolean).map(String);
    return keys.some((k) => k && t.indexOf(k) >= 0);
  }
  // 名字被截断时（EDWIN C...）才用前 6 个字符兜底，且只作为精确匹配失败后的第二选择
  function uiMatchConversationLoose(el, sess) {
    const t = uiText(el);
    if (!t || t.length > 300) return false;
    const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
    const head = norm(sess && sess.name).slice(0, 6);
    return head.length >= 5 && norm(t).indexOf(head) >= 0;
  }
  function uiFindBy(sess, loose) {
    let best = null;
    const els = uiDeepQuery(UI_ITEM_SEL);
    els.forEach((el) => {
      if (!uiVisible(el) || uiInOurPanel(el)) return;
      // 会话列表通常在左半边；排除右侧聊天区里出现的同名文本
      try { if (el.getBoundingClientRect().left > window.innerWidth * 0.45) return; } catch (e) { return; }
      const ok = uiMatchConversation(el, sess) || (loose && uiMatchConversationLoose(el, sess));
      if (!ok) return;
      if (!best || uiText(el).length < uiText(best).length) best = el;
    });
    return best;
  }
  function uiFindConversation(sess) {
    if (!sess) return null;
    return uiFindBy(sess, false) || uiFindBy(sess, true);
  }
  function uiFindContactScroller() {
    let cands = [];
    for (const d of allDocs()) {
      let els = [];
      try { els = Array.from(d.querySelectorAll('[class*="contact-list"], [class*="contactList"], [class*="session-list"], [class*="conversation-list"], ul')); } catch (e) { continue; }
      els.forEach((el) => {
        if (!uiVisible(el) || uiInOurPanel(el)) return;
        try { if (el.getBoundingClientRect().left > window.innerWidth * 0.45) return; } catch (e) { return; }
        if (el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 150) cands.push(el);
      });
    }
    cands.sort((a, b) => {
      const sa = /contact-list|contactList|session-list|conversation-list/i.test(String(a.className)) ? 1 : 0;
      const sb = /contact-list|contactList|session-list|conversation-list/i.test(String(b.className)) ? 1 : 0;
      return sb - sa || (b.scrollHeight - a.scrollHeight);
    });
    if (cands.length) return cands[0];
    // 兜底：以真实会话项为锚，向上找最近的可滚动祖先（不依赖类名）
    let anchor = null;
    try { anchor = document.querySelector('.contact-item-container, li.contact-item'); } catch (e) { anchor = null; }
    let p = anchor && anchor.parentElement;
    for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
      if (p.scrollHeight > p.clientHeight + 20 && p.clientHeight > 100) return p;
    }
    return null;
  }
  // 会话列表是虚拟滚动的：分步往下滚，每步都找一次（直接跳到底会漏掉中间项）
  async function uiScrollFind(sess) {
    const sc = uiFindContactScroller();
    const total = () => (sc ? sc.scrollHeight : (document.scrollingElement ? document.scrollingElement.scrollHeight : 0));
    const top = () => (sc ? sc.scrollTop : (window.scrollY || 0));
    const view = () => (sc ? sc.clientHeight : window.innerHeight);
    const to = (v) => { if (sc) sc.scrollTop = v; else window.scrollTo(0, v); };
    if (total() <= view() + 20) return null;   // 不需要滚动
    try { to(0); } catch (e) { /* ignore */ }
    await uiWait(300);
    for (let i = 0; i < 30; i++) {
      const item = uiFindConversation(sess);
      if (item) return item;
      const before = top();
      const step = Math.max(200, Math.floor(view() * 0.8));
      to(Math.min(total(), before + step));
      await uiWait(350);
      if (top() === before) break;
    }
    return uiFindConversation(sess);
  }
  async function uiRevealConversation(sess) {
    let item = uiFindConversation(sess);
    if (item) return item;
    // 搜索最可靠：命中后平台会把该客户顶到列表最前面
    item = await uiSearchConversation(sess);
    if (item) return item;
    // 搜索不可用时：清掉可能残留的筛选词，再分步滚动
    await uiClearSearch();
    item = await uiScrollFind(sess);
    if (item) return item;
    return await uiSearchConversation(sess);
  }
  // 深度查询：覆盖 Shadow DOM（阿里 IM 的搜索框可能挂在自定义组件里）
  function uiRoots() {
    const roots = [];
    const walk = (root) => {
      roots.push(root);
      let els = [];
      try { els = Array.from(root.querySelectorAll('*')); } catch (e) { return; }
      for (const el of els) { if (el.shadowRoot) walk(el.shadowRoot); }
    };
    allDocs().forEach(walk);
    return roots;
  }
  function uiDeepQuery(sel) {
    const out = [];
    for (const r of uiRoots()) {
      try { out.push(...Array.from(r.querySelectorAll(sel))); } catch (e) { /* ignore */ }
    }
    return out;
  }
  const SEARCH_HINT = /search|搜索|查找|昵称|买家\s*id|买家昵称|联系人|好友/i;
  function uiSearchable(el) {
    if (!el || !uiVisible(el) || uiInOurPanel(el)) return false;
    const cls = String(el.className || '');
    if (/send-textarea|send-input|translate/i.test(cls)) return false;   // 聊天输入框 / 翻译框
    // 搜索容器内的编辑区：没有 placeholder 也算
    if (/search|input-wrapper/i.test(cls) || (el.closest && el.closest('[class*="search"]'))) return true;
    const hint = [(el.getAttribute('placeholder') || ''), (el.getAttribute('aria-label') || ''),
      (el.getAttribute('title') || ''), (el.getAttribute('type') || ''), cls].join(' ');
    return SEARCH_HINT.test(hint);
  }
  function uiFindSearch() {
    const els = uiDeepQuery('input, textarea, [contenteditable], [role="textbox"], [role="searchbox"]');
    return els.find(uiSearchable) || null;
  }
  // 搜索入口可能是「假输入框」（点击后才出现真输入框）
  async function uiOpenSearch() {
    let s = uiFindSearch();
    if (s) return s;
    // 真机结构：div.search-container > div.search-background > div.input-wrapper（文案「搜索」）
    // 事件多半绑在外层，先点外层，再退到内层
    const ordered = [];
    ['[class*="search-container"]', '[class*="searchContainer"]', '[class*="search-background"]', '[class*="input-wrapper"]']
      .forEach((q) => ordered.push(...uiDeepQuery(q)));
    ordered.push(...uiDeepQuery('div, span, button, a, [role="button"]')
      .filter((el) => {
        if (!uiVisible(el) || uiInOurPanel(el)) return false;
        const t = uiText(el);
        if (!t || t.length > 40 || !SEARCH_HINT.test(t)) return false;
        const r = el.getBoundingClientRect();
        return r.left <= window.innerWidth * 0.5 && r.width * r.height <= 40000;
      })
      .sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (rb.width * rb.height) - (ra.width * ra.height);   // 外层优先
      }));
    const seen = new Set();
    const targets = ordered.filter((el) => {
      if (!el || seen.has(el)) return false;
      seen.add(el);
      return uiVisible(el) && !uiInOurPanel(el);
    });
    for (const el of targets.slice(0, 6)) {
      uiClick(el);
      for (let i = 0; i < 6; i++) {
        await uiWait(300);
        s = uiFindSearch();
        if (s) return s;
        // 展开后焦点落在自定义编辑区：直接用它
        const a = document.activeElement;
        if (a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return a;
      }
    }
    return null;
  }
  // 清空搜索框，避免上一次的筛选词把其他客户挡住
  async function uiClearSearch() {
    const s = uiFindSearch();
    if (!s) return;
    const cur = String(s.value !== undefined ? s.value : uiText(s));
    if (!cur) return;
    uiSetText(s, '');
    await uiWait(400);
  }
  function uiFindSearchButton(search) {
    const r0 = search.getBoundingClientRect();
    let best = null, bestScore = Infinity;
    for (const d of allDocs()) {
      let els = [];
      try { els = Array.from(d.querySelectorAll('button, [role="button"], a, [class*="search"], [class*="Search"]')); } catch (e) { continue; }
      els.forEach((el) => {
        if (el === search || !uiVisible(el)) return;
        const cls = String(el.className || '').toLowerCase();
        const aria = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).toLowerCase();
        if (!/search|搜索|查找/.test(cls + ' ' + aria)) return;
        const r = el.getBoundingClientRect();
        if (r.width * r.height > 20000) return;
        const dist = Math.hypot(r.left - r0.right, r.top - r0.top);
        if (dist < bestScore) { bestScore = dist; best = el; }
      });
    }
    return best;
  }
  async function uiSearchConversation(sess) {
    const search = await uiOpenSearch();
    if (!search) {
      const near = uiDeepQuery('div, span, button, a')
        .filter((el) => uiVisible(el) && !uiInOurPanel(el) && el.getBoundingClientRect().left < window.innerWidth * 0.5)
        .map((el) => uiText(el))
        .filter((t) => t && t.length <= 40)
        .slice(0, 40);
      console.warn('[ali-export-ext] 没找到搜索入口，左侧可见文本：', near);
      return null;
    }
    const keys = [sess && sess.name, sess && sess.ct && sess.ct.loginId, sess && sess.ct && sess.ct.accountId]
      .filter(Boolean).map(String);
    for (const k of keys) {
      uiSetText(search, '');
      await uiWait(300);
      uiSetText(search, k);
      // 搜索结果多是异步返回的：轮询最多约 4 秒，不要只看一眼
      let item = null;
      for (let i = 0; i < 10 && !item; i++) { await uiWait(400); item = uiFindConversation(sess); }
      if (item) return item;
      uiPressEnter(search);
      for (let i = 0; i < 8 && !item; i++) { await uiWait(400); item = uiFindConversation(sess); }
      if (item) return item;
      const sb = uiFindSearchButton(search);
      if (sb) {
        uiClick(sb);
        for (let i = 0; i < 8 && !item; i++) { await uiWait(400); item = uiFindConversation(sess); }
      }
      if (item) return item;
    }
    return null;
  }
  function uiFindComposer() {
    // 新版聊天窗口：优先使用明确的发送输入框
    for (const d of allDocs()) {
      let el = null;
      try { el = d.querySelector('textarea.send-textarea'); } catch (e) { /* ignore */ }
      if (el && uiVisible(el) && !uiInOurPanel(el)) return el;
    }
    let cands = [];
    for (const d of allDocs()) {
      let els = [];
      try { els = Array.from(d.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')); } catch (e) { continue; }
      els.forEach((el) => {
        if (!uiVisible(el) || uiInOurPanel(el)) return;
        const hint = ((el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
        if (/search|搜索|查找/.test(hint)) return;
        const r = el.getBoundingClientRect();
        cands.push({ el, area: r.width * r.height, bottom: r.bottom });
      });
    }
    if (!cands.length) return null;
    // 输入框通常面积较大且靠页面下方
    cands.sort((a, b) => (b.area - a.area) || (b.bottom - a.bottom));
    return cands[0].el;
  }
  // 新版消息页：回复框可能藏在「Enter / to call up Smart Assistant」提示后面
  function uiFindComposerActivator() {
    let best = null;
    for (const d of allDocs()) {
      let els = [];
      try { els = Array.from(d.querySelectorAll('button, [role="button"], a, div, span, p')); } catch (e) { continue; }
      els.forEach((el) => {
        if (!uiVisible(el) || uiInOurPanel(el)) return;
        const t = uiText(el);
        if (!t || t.length > 80) return;
        if (!/smart\s*assistant|智能助手|call up|唤起|reply generation|回复建议|快捷回复/i.test(t)) return;
        if (!best) best = el;
      });
    }
    return best;
  }
  function uiFindSendButton(composer) {
    // 新版聊天窗口：优先使用明确的发送按钮
    for (const d of allDocs()) {
      let els = [];
      try { els = Array.from(d.querySelectorAll('button.send-tool-button, .send-btn-bar button')); } catch (e) { continue; }
      const hit = els.find((el) => uiVisible(el) && !uiInOurPanel(el));
      if (hit) return hit;
    }
    const cr = composer.getBoundingClientRect();
    let best = null, bestScore = Infinity;
    for (const d of allDocs()) {
      let els = [];
      try { els = Array.from(d.querySelectorAll('button, [role="button"], a, [class*="send"], [class*="Send"], [class*="submit"], [class*="Submit"]')); } catch (e) { continue; }
      els.forEach((el) => {
        if (!uiVisible(el) || uiInOurPanel(el)) return;
        const t = uiText(el).toLowerCase();
        const cls = String(el.className || '').toLowerCase();
        const aria = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).toLowerCase();
        const isSend = t === 'send' || t === '发送' || /send|发送|submit/.test(cls + ' ' + aria);
        if (!isSend || t.length > 16) return;
        if (/fail|error|retry|resend/i.test(cls)) return; // send-fail-wrapper 之类不是按钮
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > 40000) return; // 容器级元素，不是按钮
        const dist = Math.hypot(r.left - cr.right, r.top - cr.bottom);
        if (dist > 240) return; // 离输入框太远，不是发送键
        const score = dist + area / 1000;
        if (score < bestScore) { bestScore = score; best = el; }
      });
    }
    return best;
  }
  function uiPressEnter(el, ctrl) {
    el.focus();
    const opt = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, ctrlKey: !!ctrl, metaKey: !!ctrl };
    ['keydown', 'keypress', 'keyup'].forEach((type) => el.dispatchEvent(new KeyboardEvent(type, opt)));
  }
  function uiSetText(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      if (document.execCommand('insertText', false, text)) return true;
    } catch (e) { /* ignore */ }
    el.innerText = text;
    try { el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })); } catch (e) { el.dispatchEvent(new Event('input', { bubbles: true })); }
    return true;
  }
  async function uiFillAndSend(composer, text) {
    uiSetText(composer, text);
    await uiWait(250);
    const getVal = () => String(composer.value !== undefined ? composer.value : uiText(composer));
    const head = text.slice(0, 12);
    // 发送前确认输入框里确实是这段文字，避免发错会话
    if (getVal().indexOf(head) < 0) throw new Error('输入框内容校验失败，已取消发送');
    const btn = uiFindSendButton(composer);
    if (btn) uiClick(btn); else uiPressEnter(composer);
    await uiWait(700);
    if (getVal().indexOf(head) >= 0) {
      uiPressEnter(composer); // 没发出去：再兜一次回车
      await uiWait(700);
    }
    if (getVal().indexOf(head) >= 0) {
      uiPressEnter(composer, true); // 有些聊天框用 Ctrl+Enter 发送
      await uiWait(700);
    }
    if (getVal().indexOf(head) >= 0) throw new Error('发送后输入框仍有内容：没找到发送按钮，请点「页面诊断」把内容发我');
    return true;
  }
  async function uiWakeComposer() {
    let composer = uiFindComposer();
    if (composer) return composer;
    const act = uiFindComposerActivator();
    if (act) {
      uiClick(act);
      await uiWait(700);
      composer = uiFindComposer();
      if (composer) return composer;
    }
    // 平台提示 Enter "/" 唤起
    const ev = { key: '/', code: 'Slash', keyCode: 191, which: 191, bubbles: true, cancelable: true };
    document.body.dispatchEvent(new KeyboardEvent('keydown', ev));
    document.body.dispatchEvent(new KeyboardEvent('keypress', ev));
    await uiWait(700);
    return uiFindComposer();
  }
  // 聊天窗口当前的子账号（weblitePWA URL 上的 activeAccountId）
  function curAcctId() {
    try { return String(new URL(location.href).searchParams.get('activeAccountId') || ''); } catch (e) { return ''; }
  }
  // 页面里所有会话项的文本（诊断用：能直接看出列表到底渲染了哪些客户）
  function uiContactTexts(limit) {
    const out = [];
    allDocs().forEach((d) => {
      let els = [];
      try { els = Array.from(d.querySelectorAll('.contact-item-container, li.contact-item, [class*="contact-item"]')); } catch (e) { return; }
      els.forEach((el) => {
        if (uiInOurPanel(el)) return;
        const t = uiText(el);
        if (t) out.push(t.slice(0, 80));
      });
    });
    return out.slice(0, limit || 40);
  }
  // 在聊天窗口（weblitePWA）切到目标客户，返回可用的输入框
  // 校验做了三重兜底：左侧选中项 → 聊天区标题 → 平台没有选中态时按定位结果继续
  async function uiSelectSessionPwa(sess) {
    const name = String((sess && sess.name) || '').trim();
    const keys = [name, sess && sess.ct && sess.ct.loginId].filter(Boolean).map(String);
    const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
    const nkeys = keys.map(norm).filter(Boolean);
    const hit = (txt) => {
      const n = norm(txt);
      if (!n) return false;
      if (nkeys.some((k) => n.indexOf(k) >= 0)) return true;
      // 列表里名字可能被截断：前 6 个字符能对上就认
      const head = norm(name).slice(0, 6);
      return head.length >= 4 && n.indexOf(head) >= 0;
    };
    const selectedText = () => {
      let t = '';
      try { t = uiText(document.querySelector('.contact-item-container.selected')); } catch (e) { t = ''; }
      return t;
    };
    const headerText = () => {
      let t = '';
      allDocs().forEach((d) => {
        let els = [];
        try {
          els = Array.from(d.querySelectorAll('[class*="chat-header"], [class*="conversation-header"], [class*="chat-title"], [class*="session-header"], [class*="contact-info"]'));
        } catch (e) { return; }
        els.forEach((el) => { if (!uiInOurPanel(el)) t += ' ' + uiText(el); });
      });
      return t;
    };

    const item = await uiRevealConversation(sess);
    if (!item) {
      const cur = curAcctId();
      const own = String((sess && sess.acct && sess.acct.accountId) || '');
      const acctHint = (cur && own && cur !== own)
        ? '；该客户属于子账号「' + ((sess.acct && sess.acct.name) || own) + '」，当前窗口是子账号 ' + cur
        : '';
      const seen = uiContactTexts(12).join(' / ') || '（左侧列表未渲染任何会话项）';
      console.warn('[ali-export-ext] 找不到会话', { want: name, loginId: sess && sess.ct && sess.ct.loginId, curAcct: cur, ownAcct: own, visible: uiContactTexts(40) });
      throw new Error('页面里找不到会话「' + name + '」' + acctHint + '。左侧当前可见：' + seen + '（已打印到 F12 Console，点「诊断」可复制完整结构）');
    }
    uiClick(item);

    for (let i = 0; i < 14; i++) {
      await uiWait(450);
      const st = selectedText();
      if (hit(st)) {
        const c = await uiWakeComposer();
        if (c) return c;
      }
      if (hit(headerText())) {
        const c = await uiWakeComposer();
        if (c) return c;
      }
      if (i === 4) uiClick(item);        // 点击可能没生效：重试一次
      if (i === 8) uiDoubleClick(item);  // 再兜一次双击
    }

    const composer = await uiWakeComposer();
    if (composer && !selectedText()) return composer; // 平台没有 selected 标记：按已定位的会话继续
    console.warn('[ali-export-ext] 会话校验未通过', { want: name, selected: selectedText(), header: headerText().slice(0, 120) });
    throw new Error('当前聊天窗口是「' + (selectedText().slice(0, 40) || '未知') + '」，不是「' + name + '」：已自动重试点击，请手动点开该客户后再试');
  }
  // 找聊天窗口的图片上传入口（多数是隐藏的 input[type=file]）
  function uiFindImageInput() {
    let best = null;
    allDocs().forEach((d) => {
      let inputs = [];
      try { inputs = Array.from(d.querySelectorAll('input[type="file"]')); } catch (e) { return; }
      inputs.forEach((el) => {
        const acc = String(el.getAttribute('accept') || '').toLowerCase();
        const isImg = /image/.test(acc) || /\.(png|jpe?g|gif|webp|bmp)/.test(acc);
        const near = el.closest && el.closest('[class*="chat"], [class*="send"], [class*="input"], [class*="editor"], [class*="toolbar"], [class*="upload"], [class*="conversation"]') ? 2 : 0;
        const s = (isImg ? 4 : 0) + near;
        if (!best || s > best.s) best = { el, s };
      });
    });
    // 4 分 = 明确 accept=image；3 分 = 图片入口附近的其他 file input
    return best && best.s >= 3 ? best.el : null;
  }
  // 把本地图片塞给页面上传入口：优先 input[type=file]（只派发一次 change），兜底模拟粘贴
  // 成功判定：聊天记录里的 blob 图片数量增加（图片已进入消息区），而不是看输入框有没有预览
  async function uiAttachImages(files, composer, sess) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return false;
    const dt = new DataTransfer();
    list.forEach((f) => dt.items.add(f));
    const startTs = Date.now();
    const blobCount = () => Array.from(document.querySelectorAll('img[src^="blob:"]'))
      .filter((img) => !img.closest('#ali-expo-box') && !img.closest('#ali-dt-box')).length;
    const before = blobCount();
    const waitSent = async (rounds) => {
      for (let i = 0; i < rounds; i++) {
        await uiWait(700);
        if (blobCount() > before) return true;
      }
      return false;
    };
    // DOM 判断不出来时，回查聊天接口：只看发送开始之后、内容像图片的我方消息
    const verifyByApi = async () => {
      if (!sess || !sess.acct || !sess.ct) return null; // 无法判断
      try {
        const msgs = await collectHistory(sess.acct, sess.ct, startTs - 1000, Date.now());
        return msgs.some((m) => {
          const t = String(m.messageType || '').toLowerCase();
          const c = String(m.content || '');
          return (m.sendTime || 0) >= startTs - 1000 && t !== 'rec'
            && (/img|image|pic/i.test(t) || /\.(png|jpe?g|gif|webp|bmp)/i.test(c) || /imageUrl/i.test(c));
        });
      } catch (e) { return null; }
    };
    const input = uiFindImageInput();
    if (input) {
      // 只派发 change：同时派发 input 会让部分页面重复上传（3 张变 6 张）
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const target = composer || uiFindComposer();
      if (!target) throw new Error('找不到图片上传入口：请先在聊天里手动发一张图，确认工具栏有图片按钮');
      try {
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
      } catch (e) {
        throw new Error('图片粘贴失败，请先在聊天里手动发一张图确认可用');
      }
    }
    if (await waitSent(12)) return true;
    // 还没出现在消息区：可能挂在输入区等手动发送，点一次发送再等
    const c = composer || uiFindComposer();
    if (c) {
      const btn = uiFindSendButton(c);
      if (btn) uiClick(btn); else uiPressEnter(c);
      if (await waitSent(8)) return true;
    }
    const apiOk = await verifyByApi();
    if (apiOk === true) return true;
    // 校验不到不代表没发出去（图片可能走 CDN 而非 blob、接口字段也可能不同），
    // 为避免把已送达的客户误标成失败，这里按已发送处理，只在控制台留痕。
    console.warn('[ali-export-ext] 图片发送结果未能确认，按已发送处理', { dom: blobCount() - before, api: apiOk });
    return true;
  }
  async function uiSendTo(sess, text) {
    const name = String((sess && sess.name) || '').trim();
    // 单聊窗口（weblitePWA）：有完整会话列表，优先切到目标客户
    if (/weblitePWA/i.test(location.pathname)) {
      const composer = await uiSelectSessionPwa(sess);
      return uiFillAndSend(composer, text);
    }
    // 消息管理器列表页：先定位会话，再打开聊天框
    const item = await uiRevealConversation(sess);
    if (!item) throw new Error('页面里找不到会话「' + name + '」：请先在消息管理器点开该客户，进入聊天窗口后再试');
    let composer = await uiWakeComposer();
    if (!composer) { uiClick(item); await uiWait(800); composer = await uiWakeComposer(); }
    if (!composer) { uiDoubleClick(item); await uiWait(800); composer = await uiWakeComposer(); }
    if (!composer) {
      const other = uiFindOtherContact(item);
      if (other) {
        uiClick(other);
        await uiWait(700);
        uiClick(item);
        await uiWait(1000);
        composer = await uiWakeComposer();
      }
    }
    if (!composer) throw new Error('没有聊天框：请在消息管理器点开客户，进入聊天窗口后再试');
    return uiFillAndSend(composer, text);
  }
  // 工作台人工确认的询盘回复：聊天窗口加载后发送，并把结果回写给工作台。
  async function maybeSmartReply() {
    if (window.self !== window.top) return;
    if (!/weblitePWA/i.test(location.pathname)) return;
    // 只处理工作台明确打开、带发送标记的标签页，避免员工手动打开聊天页时误发。
    let url = null;
    try { url = new URL(location.href); } catch (e) { return; }
    if (url.searchParams.get('aliSmartReply') !== '1') return;
    try {
      url.searchParams.delete('aliSmartReply');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) { /* 地址栏清理失败不阻断本次发送 */ }
    let pending = null;
    try {
      const saved = await chrome.storage.local.get(SMART_REPLY_KEY);
      pending = saved && saved[SMART_REPLY_KEY];
    } catch (e) { return; }
    if (!pending || pending.kind !== 'inquiry-reply' || !pending.text || !pending.key) return;
    if (Date.now() - (pending.createdAt || 0) > 5 * 60 * 1000) {
      try { await chrome.storage.local.remove(SMART_REPLY_KEY); } catch (e) { /* ignore */ }
      return;
    }
    let workspace = 'default';
    try {
      const saved = await chrome.storage.local.get('aliActiveWorkspace');
      workspace = String((saved && saved.aliActiveWorkspace) || 'default');
    } catch (e) { /* ignore */ }
    if (pending.workspace && pending.workspace !== workspace) {
      try {
        await chrome.storage.local.set({ [SMART_REPLY_RESULT_KEY]: {
          key: pending.key, ok: false, error: '工作区已切换，已取消发送', at: Date.now(),
        } });
        await chrome.storage.local.remove(SMART_REPLY_KEY);
      } catch (e) { /* ignore */ }
      return;
    }
    toast('检测到待发送的询盘回复，正在定位客户…');
    for (let i = 0; i < 15; i++) {
      await uiWait(800);
      if (await uiWakeComposer()) break;
    }
    try {
      await uiSendTo({ name: pending.customer }, pending.text);
      await chrome.storage.local.set({ [SMART_REPLY_RESULT_KEY]: {
        key: pending.key, ok: true, at: Date.now(), customer: pending.customer,
      } });
      toast('已发送给 ' + pending.customer);
    } catch (e) {
      try {
        await chrome.storage.local.set({ [SMART_REPLY_RESULT_KEY]: {
          key: pending.key, ok: false, error: e.message || String(e), at: Date.now(), customer: pending.customer,
        } });
      } catch (e2) { /* ignore */ }
      toast('发送失败：' + (e.message || e), true);
    } finally {
      try { await chrome.storage.local.remove(SMART_REPLY_KEY); } catch (e) { /* ignore */ }
    }
  }
  // 工作台测试：只定位会话，不发送。用于确认客户名匹配是否可靠。
  async function maybeInboxProbe() {
    if (window.self !== window.top) return;
    if (!/weblitePWA/i.test(location.pathname)) return;
    let url = null;
    try { url = new URL(location.href); } catch (e) { return; }
    if (url.searchParams.get('aliInboxProbe') !== '1') return;
    try {
      url.searchParams.delete('aliInboxProbe');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) { /* 不阻断定位 */ }
    let pending = null;
    try { pending = (await chrome.storage.local.get(INBOX_PROBE_KEY))[INBOX_PROBE_KEY]; } catch (e) { return; }
    if (!pending || !pending.key || !pending.customer) return;
    if (Date.now() - (pending.createdAt || 0) > 5 * 60 * 1000) {
      try { await chrome.storage.local.remove(INBOX_PROBE_KEY); } catch (e) { /* ignore */ }
      return;
    }
    let workspace = 'default';
    try {
      workspace = String((await chrome.storage.local.get('aliActiveWorkspace')).aliActiveWorkspace || 'default');
    } catch (e) { /* ignore */ }
    if (pending.workspace && pending.workspace !== workspace) {
      try {
        await chrome.storage.local.set({ [INBOX_PROBE_RESULT_KEY]: {
          key: pending.key, ok: false, error: '工作区已切换，已取消定位', visible: [],
        } });
        await chrome.storage.local.remove(INBOX_PROBE_KEY);
      } catch (e) { /* ignore */ }
      return;
    }
    for (let i = 0; i < 15; i++) {
      await uiWait(800);
      if (await uiWakeComposer()) break;
    }
    try {
      const item = await uiRevealConversation({ name: pending.customer });
      const visible = uiContactTexts(8);
      await chrome.storage.local.set({ [INBOX_PROBE_RESULT_KEY]: item
        ? { key: pending.key, ok: true, customer: pending.customer, visible }
        : { key: pending.key, ok: false, customer: pending.customer, error: '左侧列表找不到会话', visible } });
      toast(item ? '已定位会话：' + pending.customer : '未找到会话：' + pending.customer, !item);
    } catch (e) {
      try {
        await chrome.storage.local.set({ [INBOX_PROBE_RESULT_KEY]: {
          key: pending.key, ok: false, customer: pending.customer,
          error: e.message || String(e), visible: uiContactTexts(8),
        } });
      } catch (e2) { /* ignore */ }
    } finally {
      try { await chrome.storage.local.remove(INBOX_PROBE_KEY); } catch (e) { /* ignore */ }
    }
  }

  // 工作台测试：按队列顺序真实发送多条，记录逐条结果；测试模式不写正式发送日志。
  async function maybeInboxAutoTest() {
    if (window.self !== window.top) return;
    if (!/weblitePWA/i.test(location.pathname)) return;
    let url = null;
    try { url = new URL(location.href); } catch (e) { return; }
    if (url.searchParams.get('aliInboxAutoTest') !== '1') return;
    try {
      url.searchParams.delete('aliInboxAutoTest');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) { /* 不阻断发送 */ }
    let pending = null;
    try { pending = (await chrome.storage.local.get(INBOX_AUTOTEST_KEY))[INBOX_AUTOTEST_KEY]; } catch (e) { return; }
    if (!pending || !Array.isArray(pending.items) || !pending.items.length || !pending.key) return;
    if (Date.now() - (pending.createdAt || 0) > 10 * 60 * 1000) {
      try { await chrome.storage.local.remove(INBOX_AUTOTEST_KEY); } catch (e) { /* ignore */ }
      return;
    }
    let workspace = 'default';
    try {
      workspace = String((await chrome.storage.local.get('aliActiveWorkspace')).aliActiveWorkspace || 'default');
    } catch (e) { /* ignore */ }
    if (pending.workspace && pending.workspace !== workspace) {
      try {
        await chrome.storage.local.set({ [INBOX_AUTOTEST_RESULT_KEY]: {
          key: pending.key, done: true, index: 0, total: pending.items.length,
          results: [{ ok: false, error: '工作区已切换，已取消自动测试' }],
        } });
        await chrome.storage.local.remove(INBOX_AUTOTEST_KEY);
      } catch (e) { /* ignore */ }
      return;
    }
    const total = pending.items.length;
    const results = [];
    const publish = (index, done) => chrome.storage.local.set({
      [INBOX_AUTOTEST_RESULT_KEY]: { key: pending.key, done, index, total, results: results.slice() },
    }).catch(() => {});
    await publish(0, false);
    toast('自动测试开始：' + total + ' 个客户');
    for (let i = 0; i < total; i++) {
      const item = pending.items[i];
      await publish(i, false);
      try {
        await uiSendTo({ name: item.customer }, item.text);
        results.push({ ok: true, customer: item.customer, inquiryId: item.inquiryId, at: Date.now() });
      } catch (e) {
        results.push({ ok: false, customer: item.customer, inquiryId: item.inquiryId,
          error: e.message || String(e), at: Date.now() });
      }
      await publish(i + 1, false);
      if (i < total - 1) await uiWait(Math.max(3000, Number(pending.gapMs) || 3000));
    }
    await publish(total, true);
    const success = results.filter((item) => item.ok).length;
    toast('自动测试完成：成功 ' + success + ' / 失败 ' + (results.length - success), success < results.length);
    try { await chrome.storage.local.remove(INBOX_AUTOTEST_KEY); } catch (e) { /* ignore */ }
  }

  // 列表页点了发送后：聊天窗口（weblitePWA）加载时读取并自动发送
  async function maybeAutoSend() {
    if (!/weblitePWA/i.test(location.pathname)) return;
    let p = null;
    try {
      const o = await chrome.storage.local.get(PENDING_SEND_KEY);
      p = o && o[PENDING_SEND_KEY];
    } catch (e) { return; }
    if (!p || !p.text) return;
    if (Date.now() - (p.ts || 0) > 3 * 60 * 1000) {
      try { await chrome.storage.local.remove(PENDING_SEND_KEY); } catch (e) { /* ignore */ }
      return;
    }
    toast('检测到待发送婉拒，正在等待聊天窗口加载…');
    for (let i = 0; i < 12; i++) {
      await uiWait(800);
      if (await uiWakeComposer()) break;
    }
    try {
      await uiSendTo({ name: p.customer, ct: { loginId: p.loginId } }, p.text);
      if (!p.test) {
        const log = await loadFinishedLog();
        const key = String(p.loginId || p.customer);
        log.count += 1;
        log.customers[key] = String(Date.now());
        await saveFinishedLog(log);
      }
      await chrome.storage.local.remove(PENDING_SEND_KEY);
      toast('已自动发送婉拒给 ' + p.customer);
    } catch (e) {
      toast('自动发送失败：' + e.message, true);
    }
  }
  // 页面结构诊断：把候选会话项/输入框/发送按钮打印出来，便于校准
  function uiDiagnose() {
    const docs = allDocs();
    const pick = (el) => ({
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 100),
      ph: (el.getAttribute && (el.getAttribute('placeholder') || '')) || '',
      type: (el.getAttribute && (el.getAttribute('type') || '')) || '',
      aria: (el.getAttribute && ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).trim()) || '',
      text: uiText(el).slice(0, 120),
    });
    const out = {
      url: location.href,
      activeAccountId: curAcctId(),
      contactTexts: uiContactTexts(40),
      searchInputs: [],
      searchCandidates: uiDeepQuery('div, span, button, a, [role="button"]')
        .filter((el) => {
          if (!uiVisible(el) || uiInOurPanel(el)) return false;
          const t = uiText(el);
          if (!t || t.length > 40 || !SEARCH_HINT.test(t)) return false;
          try { return el.getBoundingClientRect().left < window.innerWidth * 0.5; } catch (e) { return false; }
        })
        .slice(0, 10).map(pick),
      shadowRoots: uiRoots().length - allDocs().length,
      frames: [],
      inputs: [],
      contactItems: [],
      composers: [],
      composerChain: [],
      nearComposer: [],
      sendButtons: [],
    };
    docs.forEach((d) => {
      try { out.frames.push(d.location.href); } catch (e) { out.frames.push('(cross-origin)'); }
      try { out.inputs.push(...Array.from(d.querySelectorAll('input')).filter(uiVisible).slice(0, 25).map(pick)); } catch (e) { /* ignore */ }
      try { out.contactItems.push(...Array.from(d.querySelectorAll('li.contact-item, [class*="contact-item"]')).filter(uiVisible).slice(0, 60).map(pick)); } catch (e) { /* ignore */ }
      try { out.composers.push(...Array.from(d.querySelectorAll('textarea, [contenteditable="true"]')).filter(uiVisible).slice(0, 10).map(pick)); } catch (e) { /* ignore */ }
      try {
        out.searchInputs.push(...Array.from(d.querySelectorAll('input, [contenteditable="true"]'))
          .filter(uiVisible)
          .filter((el) => /search|搜索|查找|昵称|买家|联系人/.test(String(el.getAttribute('placeholder') || '') + String(el.getAttribute('aria-label') || '')))
          .slice(0, 6).map(pick));
      } catch (e) { /* ignore */ }
      try {
        out.sendButtons.push(...Array.from(d.querySelectorAll('button, [role="button"], a, [class*="send"], [class*="Send"], [class*="submit"]'))
          .filter(uiVisible)
          .filter((el) => /send|发送|submit/i.test(String(el.className) + ' ' + uiText(el) + ' ' + (el.getAttribute('aria-label') || '')))
          .slice(0, 20).map(pick));
      } catch (e) { /* ignore */ }
    });
    // 输入框附近 260px 内的元素（找无文字的图标发送按钮）
    const comp = uiFindComposer();
    if (comp) {
      const cr = comp.getBoundingClientRect();
      const chain = [];
      let p = comp.parentElement;
      for (let i = 0; i < 5 && p; i++, p = p.parentElement) chain.push(p.tagName + '.' + String(p.className || '').slice(0, 60));
      out.composerChain = chain;
      docs.forEach((d) => {
        try {
          Array.from(d.querySelectorAll('button, [role="button"], a, div, span, svg, i')).filter(uiVisible).forEach((el) => {
            if (el.closest && el.closest('#ali-dt-box')) return;
            const r = el.getBoundingClientRect();
            if (Math.hypot(r.left - cr.right, r.top - cr.bottom) > 260) return;
            out.nearComposer.push(pick(el));
          });
        } catch (e) { /* ignore */ }
      });
      out.nearComposer = out.nearComposer.slice(0, 40);
    }
    console.log('[ali-export-ext][UI-DIAG]', out);
    return out;
  }
  async function loadFinishedLog() {
    let o = null;
    try { const r = await chrome.storage.local.get(FINISHED_LOG_KEY); o = r && r[FINISHED_LOG_KEY]; } catch (e) { /* ignore */ }
    if (!o || o.date !== dayKey()) o = { date: dayKey(), count: 0, customers: {} };
    return o;
  }
  async function saveFinishedLog(o) {
    try { await chrome.storage.local.set({ [FINISHED_LOG_KEY]: o }); } catch (e) { /* ignore */ }
  }

  async function openFinishedReply(startDate, endDate) {
    closeFeaturePanels('ali-dt-box'); // 先关掉 AI 分析/设置面板，避免互相遮挡
    const old = document.getElementById('ali-dt-box');
    if (old) { old.remove(); return; }
    const cfg = await loadAiCfg();
    if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.model) { toast('请先点「AI 设置」配置模型', true); return; }
    const box = document.createElement('div');
    box.id = 'ali-dt-box';
    box.style.cssText = 'position:fixed;right:16px;top:48px;z-index:2147483002;width:min(880px,96vw);height:min(820px,92vh);'
      + 'display:flex;flex-direction:column;background:#fff;border:1px solid #e5e7eb;border-radius:12px;'
      + 'box-shadow:0 10px 40px rgba(0,0,0,.18);font:13px/1.6 "Microsoft YaHei",sans-serif;color:#111;overflow:hidden;';
    const btnS = 'border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:4px 9px;cursor:pointer;font-size:12px;white-space:nowrap;';
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #f0f0f0;">'
      + '<b style="white-space:nowrap;">成品需求 · 婉拒回复</b>'
      + '<span id="ali-dt-prog" style="color:#6b7280;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">准备中…</span>'
      + '<span style="flex:1"></span>'
      + '<button id="ali-dt-recollect" style="' + btnS + '">重新采集</button>'
      + '<button id="ali-dt-analyze" style="' + btnS + '">生成分析</button>'
      + '<button id="ali-dt-probe-btn" style="' + btnS + '">抓取发送接口</button>'
      + '<button id="ali-dt-diag" style="' + btnS + '">页面诊断</button>'
      + '<button id="ali-dt-auto" style="border:0;background:#f59e0b;color:#fff;border-radius:6px;padding:5px 11px;cursor:pointer;font-size:12px;white-space:nowrap;">自动测试</button>'
      + '<button id="ali-dt-sendall" style="border:0;background:#2563eb;color:#fff;border-radius:6px;padding:5px 11px;cursor:pointer;font-size:12px;white-space:nowrap;">全部发送</button>'
      + '<button id="ali-dt-stop" style="' + btnS + '" disabled>停止</button>'
      + '<button id="ali-dt-close" style="border:0;background:#f3f4f6;border-radius:6px;padding:4px 9px;cursor:pointer;">关闭</button></div>'
      + '<div id="ali-dt-stats" style="padding:7px 12px;border-bottom:1px solid #f7f7f7;color:#374151;font-size:12px;"></div>'
      + '<div id="ali-dt-probe" style="padding:0 12px 7px;color:#9ca3af;font-size:11px;"></div>'
      + '<div id="ali-dt-list" style="flex:1;overflow:auto;padding:10px 12px;background:#fafafa;"></div>';
    document.body.appendChild(box);
    const $ = (id) => box.querySelector('#' + id);
    const list = $('ali-dt-list');
    const prog = (t) => { const el = $('ali-dt-prog'); if (el) el.textContent = t; };
    let items = [];
    let busy = false;
    let stopped = false;
    let probeMarker = '';
    let probeArmed = false;
    let uiConfirmed = false; // 页面模拟发送的二次确认只弹一次
    let testMode = false; // 测试模式：跳过每客户每日去重与全局上限

    const setBtns = () => {
      $('ali-dt-recollect').disabled = busy;
      $('ali-dt-analyze').disabled = busy || !items.length;
      $('ali-dt-sendall').disabled = busy || !items.length;
      $('ali-dt-auto').disabled = busy || !items.length;
      $('ali-dt-stop').disabled = !busy;
    };
    let onlyMismatch = false;
    const catOf = (it) => (it && it.ai && it.ai.category) || '';
    const renderStats = () => {
      const mis = items.filter((x) => catOf(x) === 'mismatch_finished').length;
      const tgt = items.filter((x) => catOf(x) === 'target').length;
      const unc = items.filter((x) => catOf(x) === 'unclear').length;
      const sent = items.filter((x) => x.status === 'sent').length;
      $('ali-dt-stats').innerHTML = '命中 <b>' + items.length + '</b> · 待婉拒 <b>' + mis + '</b> · 目标客户 <b>' + tgt + '</b> · 待确认 <b>' + unc + '</b> · 已发送 <b>' + sent + '</b>'
        + '<label style="margin-left:10px;color:#6b7280;cursor:pointer;"><input type="checkbox" id="ali-dt-onlymis"' + (onlyMismatch ? ' checked' : '') + '> 只看待婉拒</label>'
        + '<label style="margin-left:10px;color:#b45309;cursor:pointer;"><input type="checkbox" id="ali-dt-testmode"' + (testMode ? ' checked' : '') + '> 测试模式（允许重复）</label>';
      const cb = $('ali-dt-onlymis');
      if (cb) cb.onchange = () => { onlyMismatch = cb.checked; render(); };
      const tm = $('ali-dt-testmode');
      if (tm) tm.onchange = () => { testMode = tm.checked; render(); };
    };
    const catBadge = (it) => {
      const c = catOf(it);
      if (c === 'target') return '<span style="background:#ecfdf5;color:#047857;border-radius:10px;padding:1px 8px;font-size:11px;">目标客户 · 不婉拒</span>';
      if (c === 'mismatch_finished') return '<span style="background:#fef2f2;color:#b91c1c;border-radius:10px;padding:1px 8px;font-size:11px;">待婉拒</span>';
      if (c === 'unclear') return '<span style="background:#f3f4f6;color:#6b7280;border-radius:10px;padding:1px 8px;font-size:11px;">待确认</span>';
      return '<span style="background:#f3f4f6;color:#9ca3af;border-radius:10px;padding:1px 8px;font-size:11px;">分析中</span>';
    };
    const badge = (st) => {
      const m = { pending: ['待发送', '#eff6ff', '#1d4ed8'], sent: ['已发送', '#ecfdf5', '#047857'], skip: ['已跳过', '#f3f4f6', '#6b7280'], error: ['失败', '#fef2f2', '#b91c1c'], sending: ['发送中', '#fff7ed', '#c2410c'] };
      const x = m[st] || m.pending;
      return '<span style="background:' + x[1] + ';color:' + x[2] + ';border-radius:10px;padding:1px 8px;font-size:11px;">' + x[0] + '</span>';
    };
    const render = () => {
      if (!items.length) {
        list.innerHTML = '<div style="padding:24px;color:#9ca3af;text-align:center;">没有命中「成品 / 整机」关键词的会话</div>';
        renderStats(); setBtns(); return;
      }
      const shown = items.map((it, i) => ({ it, i }))
        .filter((x) => !onlyMismatch || catOf(x.it) === 'mismatch_finished');
      if (!shown.length) {
        list.innerHTML = '<div style="padding:24px;color:#9ca3af;text-align:center;">当前没有「待婉拒」的会话</div>';
        renderStats(); setBtns(); return;
      }
      list.innerHTML = shown.map(({ it, i }) => {
        const a = it.ai || {};
        const canDecline = catOf(it) === 'mismatch_finished';
        const lb = (function () { for (let k = it.sess.msgs.length - 1; k >= 0; k--) { const m = it.sess.msgs[k]; if (!m.mine && !isChatNoise(m.c)) return m; } return null; })();
        return '<div data-i="' + i + '" style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;margin-bottom:10px;">'
          + '<div style="display:flex;align-items:center;gap:8px;font-size:12px;">'
          + '<b>' + escHtml(it.sess.name) + '</b>'
          + '<span style="color:#6b7280;">买家命中 ' + it.hit.buyer + ' 次 · ' + (it.hit.hits.slice(0, 4).map(escHtml).join('、') || '-') + '</span>'
          + '<span style="flex:1"></span>' + catBadge(it) + ' ' + (it.status !== 'pending' ? badge(it.status) : '') + '</div>'
          + '<div style="margin:6px 0;color:#4b5563;font-size:12px;">最近客户消息：' + escHtml(lb ? (lb.t + '｜' + lb.c.slice(0, 160)) : '（无）') + '</div>'
          + '<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px;color:#6b7280;margin-bottom:5px;">'
          + '<span>客户类型：' + escHtml(CUSTOMER_TYPE_LABEL[a.customer_type] || '-') + '</span>'
          + '<span>意向：' + escHtml(a.intent || '-') + '</span>'
          + '<span>阶段：' + escHtml(a.stage || '-') + '</span>'
          + '<span>说明：' + escHtml(a.reason || '') + '</span></div>'
          + (a.risk ? '<div style="color:#b45309;font-size:11.5px;margin-bottom:5px;">风险/待确认：' + escHtml(a.risk) + '</div>' : '')
          + (it.err ? '<div style="color:#b91c1c;font-size:11.5px;margin-bottom:5px;">' + escHtml(it.err) + '</div>' : '')
          + (canDecline
            ? '<textarea style="width:100%;min-height:92px;padding:8px;border:1px solid #d1d5db;border-radius:8px;font:12.5px/1.6 inherit;resize:vertical;box-sizing:border-box;">' + escHtml(it.reply || '') + '</textarea>'
            : '<div style="color:#9ca3af;font-size:12px;margin:4px 0;">' + (catOf(it) === 'target' ? '已判定为目标客户（技工所/经销商/诊所等），不生成婉拒话术。' : (catOf(it) === 'unclear' ? '信息不足，建议人工判断。' : '分析中…')) + '</div>')
          + '<div style="display:flex;gap:8px;margin-top:6px;">'
          + (canDecline
            ? '<button data-act="send" style="border:0;background:#dc2626;color:#fff;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:12px;">发送婉拒</button>'
              + '<button data-act="regen" style="' + btnS + '">重新生成</button>'
              + '<button data-act="skip" style="' + btnS + '">跳过</button>'
            : '<button data-act="regen" style="' + btnS + '">重新判断</button>')
          + '<span style="flex:1"></span><span style="color:#9ca3af;font-size:11px;">' + it.sess.msgs.length + ' 条消息</span></div></div>';
      }).join('');
      shown.forEach(({ it, i }) => {
        const card = list.querySelector('[data-i="' + i + '"]');
        if (!card) return;
        const ta = card.querySelector('textarea');
        if (ta) ta.oninput = () => { it.reply = ta.value; };
        const s = card.querySelector('[data-act="send"]'); if (s) s.onclick = () => sendOne(i);
        const r = card.querySelector('[data-act="regen"]'); if (r) r.onclick = () => regenOne(i);
        const k = card.querySelector('[data-act="skip"]'); if (k) k.onclick = () => { it.status = 'skip'; render(); };
      });
      renderStats(); setBtns();
    };

    const sendOne = async (i) => {
      const it = items[i];
      if (!it || busy) return;
      if (catOf(it) !== 'mismatch_finished') { toast('该会话不是成品需求买家，不发送婉拒', true); return; }
      const tpl = await loadSendApi();
      const useUI = !tpl || tpl.via === 'ws';
      const txt = String(it.reply || '').trim();
      if (!txt) { toast('回复为空', true); return; }
      if (useUI && !uiConfirmed) {
        const ok = window.confirm('未配置发送接口，将使用「页面模拟发送」：\n会自动切换会话、在聊天框填入话术并点击发送。\n请保持聊天窗口可见，确认继续？');
        if (!ok) return;
        uiConfirmed = true;
      }
      const log = await loadFinishedLog();
      const key = String(it.sess.ct.accountId || it.sess.name);
      if (!testMode) {
        if (log.count >= SEND_MAX_PER_DAY) { toast('今日已达上限 ' + SEND_MAX_PER_DAY + ' 条', true); return; }
        if (log.customers[key]) { toast('今天已经回复过这个客户', true); return; }
      }
      // 在消息管理器列表页：先记下待发送，再点击客户打开聊天窗口；窗口加载后自动发送
      if (useUI && !/weblitePWA/i.test(location.pathname)) {
        const item = await uiRevealConversation(it.sess);
        if (!item) { toast('左侧列表找不到该客户，请先手动点开一次', true); return; }
        try {
          await chrome.storage.local.set({ [PENDING_SEND_KEY]: {
            customer: it.sess.name,
            loginId: (it.sess.ct && it.sess.ct.loginId) || '',
            text: txt,
            test: testMode,
            ts: Date.now(),
          } });
        } catch (e) { toast('保存待发送失败：' + e.message, true); return; }
        busy = true; setBtns(); it.status = 'sending'; render();
        uiClick(item);
        toast('正在打开聊天窗口，加载后会自动发送…');
        await uiWait(2000);
        busy = false; render();
        return;
      }
      busy = true; setBtns(); it.status = 'sending'; render();
      try {
        if (useUI) await uiSendTo(it.sess, txt);
        else await sendMessageNow(tpl, txt);
        if (!testMode) {
          log.count += 1; log.customers[key] = String(lastBuyerTs(it.sess));
          await saveFinishedLog(log);
        }
        it.status = 'sent'; it.err = '';
        toast('已发送给 ' + it.sess.name);
      } catch (e) {
        it.status = 'error'; it.err = '发送失败：' + e.message;
        toast('发送失败：' + e.message, true);
      } finally { busy = false; render(); }
    };
    const regenOne = async (i) => {
      const it = items[i];
      if (!it || busy) return;
      busy = true; setBtns();
      try {
        it.ai = await analyzeFinished(it.sess, cfg);
        it.reply = it.ai.reply || '';
        it.status = (it.ai.category === 'mismatch_finished' && it.ai.need_reply !== false) ? 'pending' : 'skip';
        it.err = '';
      } catch (e) { toast('重新判断失败：' + e.message, true); }
      finally { busy = false; render(); }
    };
    const analyzeAll = async () => {
      busy = true; setBtns();
      for (let i = 0; i < items.length; i++) {
        if (stopped) break;
        const it = items[i];
        if (it.ai) continue;
        prog('AI 分析 ' + (i + 1) + '/' + items.length + '：' + it.sess.name);
        try {
          it.ai = await analyzeFinished(it.sess, cfg);
          it.reply = it.ai.reply || '';
          it.status = (it.ai.category === 'mismatch_finished' && it.ai.need_reply !== false) ? 'pending' : 'skip';
        } catch (e) {
          it.ai = { reason: '分析失败：' + e.message };
          it.status = 'error'; it.err = '分析失败：' + e.message;
        }
        render();
        await pace();
      }
      busy = false; render();
      prog(stopped ? '已停止' : '分析完成');
    };
    const collect = async () => {
      busy = true; stopped = false; items = []; render();
      try {
        const all = await collectChatSessions(startDate, endDate, (d) => prog('已取 ' + d + ' 个会话…'));
        items = all.map((s) => ({ sess: s, hit: finishedHit(s), ai: null, reply: '', status: 'pending', err: '' }))
          .filter((x) => x.hit.buyer > 0 || x.hit.score >= 2);
        prog('命中 ' + items.length + ' / ' + all.length + ' 个会话，开始分析…');
        render();
        busy = false; setBtns();
        await analyzeAll();
      } catch (e) {
        busy = false; render();
        prog('采集失败（需在聊天页操作）：' + e.message);
      }
    };
    const sendAll = async () => {
      if (busy) return;
      stopped = false;
      for (let i = 0; i < items.length; i++) {
        if (stopped) break;
        const it = items[i];
        if (it.status !== 'pending' && it.status !== 'error') continue;
        if (!String(it.reply || '').trim()) continue;
        await sendOne(i);
        if (stopped) break;
        const gap = SEND_GAP_MIN + Math.floor(Math.random() * (SEND_GAP_MAX - SEND_GAP_MIN));
        prog('已发送，等待 ' + Math.round(gap / 1000) + ' 秒…');
        await new Promise((r) => setTimeout(r, gap));
      }
      prog(stopped ? '已停止' : '批量发送结束');
    };
    // 自动测试：一次点击，按顺序自动发送多个待婉拒客户，记录成功/失败
    const autoTest = async () => {
      if (busy) return;
      if (!/weblitePWA/i.test(location.pathname)) {
        toast('请先进入聊天窗口（weblitePWA）再执行自动测试', true);
        return;
      }
      const pool = items.filter((it) => catOf(it) === 'mismatch_finished' && String(it.reply || '').trim());
      if (!pool.length) { toast('没有可测试的待婉拒客户', true); return; }
      const raw = window.prompt('自动测试：要发送的客户数（最多 ' + pool.length + '）', String(Math.min(pool.length, 3)));
      if (raw === null) return;
      const n = Math.max(1, Math.min(pool.length, parseInt(raw, 10) || 1));
      const ok = window.confirm('将自动向 ' + n + ' 个待婉拒客户发送（测试模式：跳过去重/上限，间隔 3 秒）。\n请确认当前聊天窗口可正常发送。继续？');
      if (!ok) return;
      const prevTest = testMode;
      testMode = true;
      stopped = false;
      busy = true; setBtns();
      let success = 0, fail = 0;
      const list = pool.slice(0, n);
      for (let i = 0; i < list.length; i++) {
        if (stopped) break;
        const it = list[i];
        prog('自动测试 ' + (i + 1) + '/' + list.length + '：' + it.sess.name);
        it.status = 'sending'; it.err = ''; render();
        try {
          await uiSendTo(it.sess, String(it.reply || '').trim());
          it.status = 'sent'; success++;
        } catch (e) {
          it.status = 'error'; it.err = '自动测试失败：' + e.message; fail++;
        }
        render();
        if (i < list.length - 1 && !stopped) await uiWait(3000);
      }
      testMode = prevTest;
      busy = false; render();
      const msg = '自动测试完成：成功 ' + success + ' / 失败 ' + fail;
      prog(msg);
      toast(msg, fail > 0);
    };
    // 抓取发送接口：① 安装探针 → 手动发一条带标记的消息 → ② 读取并保存模板
    const probeStep = async () => {
      if (!probeArmed) {
        probeMarker = 'ali-probe-' + Math.random().toString(36).slice(2, 8);
        const r = await chrome.runtime.sendMessage({ type: 'sendProbeInstall', marker: probeMarker }).catch(() => null);
        if (!r || !r.ok) { toast('探针安装失败：' + ((r && r.error) || '未知'), true); return; }
        probeArmed = true;
        $('ali-dt-probe-btn').textContent = '读取抓取结果';
        $('ali-dt-probe').textContent = '已开始抓取：请**不要刷新页面**，在聊天窗口手动发送内容为 ' + probeMarker + ' 的消息（发给自己/同事），然后回来点「读取抓取结果」。';
        toast('请手动发一条测试消息：' + probeMarker);
        return;
      }
      const r = await chrome.runtime.sendMessage({ type: 'sendProbeRead' }).catch(() => null);
      if (!r || !r.ok) { toast('读取失败：' + ((r && r.error) || '未知'), true); return; }
      // 后台已按 frame 返回：{hits, last, frame}；兼容旧的数组返回
      const frames = (r.result || []).filter(Boolean);
      const hits = [];
      const last = [];
      frames.forEach((f) => {
        if (Array.isArray(f)) { hits.push(...f); return; }
        if (Array.isArray(f.hits)) hits.push(...f.hits);
        if (Array.isArray(f.last)) last.push(...f.last);
      });
      const dec = (s) => { try { return decodeURIComponent(String(s || '')); } catch (e) { return String(s || ''); } };
      const cap = hits.find((c) => String(c.body || '').indexOf(probeMarker) >= 0 || dec(c.body).indexOf(probeMarker) >= 0) || hits[0];
      if (!cap) {
        const urls = last.slice(-6).map((x) => x.via + ' ' + x.method + ' ' + x.url + ' (' + x.len + 'B)');
        $('ali-dt-probe').textContent = urls.length
          ? ('未匹配到标记。最近请求：' + urls.join(' ｜ ') + '（抓取期间不要刷新页面）')
          : '未捕获到任何非 GET 请求：确认消息已真正发出，且发送窗口就是当前标签页。';
        toast('没抓到自己发的消息，请看面板下方「最近请求」', true);
        return;
      }
      const tpl = { url: cap.url, method: cap.method || 'POST', via: cap.via || 'xhr', headers: cap.headers || {}, body: cap.body, probeText: probeMarker, ts: Date.now() };
      await chrome.storage.local.set({ [SEND_API_KEY]: tpl });
      probeArmed = false;
      $('ali-dt-probe-btn').textContent = '抓取发送接口';
      $('ali-dt-probe').textContent = '已保存发送接口（' + (cap.via || 'xhr') + '）：' + cap.url
        + (cap.via === 'ws' ? '（WebSocket 通道，当前版本只能复制话术手动发送）' : '');
      toast('发送接口已保存');
    };

    $('ali-dt-close').onclick = () => { stopped = true; box.remove(); };
    $('ali-dt-stop').onclick = () => { stopped = true; prog('停止中…'); };
    $('ali-dt-recollect').onclick = () => { if (!busy) collect(); };
    $('ali-dt-analyze').onclick = () => { if (!busy) analyzeAll(); };
    $('ali-dt-sendall').onclick = () => sendAll();
    $('ali-dt-auto').onclick = () => autoTest();
    $('ali-dt-probe-btn').onclick = () => probeStep();
    $('ali-dt-diag').onclick = () => {
      const d = uiDiagnose();
      const txt = JSON.stringify(d, null, 2);
      navigator.clipboard.writeText(txt)
        .then(() => toast('页面结构已复制到剪贴板（也可在 F12 Console 看 [UI-DIAG]）'))
        .catch(() => toast('已打印到 Console（F12）查看 [UI-DIAG]', true));
    };

    const tplNow = await loadSendApi();
    const onChatWin = /weblitePWA/i.test(location.pathname);
    $('ali-dt-probe').textContent = (tplNow
      ? ('发送接口已就绪：' + tplNow.url + (tplNow.via === 'ws' ? '（WebSocket，将走页面模拟）' : ''))
      : '未配置发送接口：发送时自动走「页面模拟」')
      + (onChatWin ? '｜当前在聊天窗口，可直接发送'
        : '｜当前不是聊天窗口：请先在消息管理器点开客户，进入聊天窗口后再发送');
    await collect();
  }

  // ---------------- 展会通知 · 站内群发 ----------------
  // 边界：只发给「所选时间范围内有聊天往来」的客户；纯模板变量，不调 AI；
  // 逐条页面模拟发送（切会话 → 填输入框 → 发送），间隔 8–20 秒，每日可配上限。
  const EXPO_LOG_KEY = 'aliExpoLog';   // { date, count, sent:{客户键: 时间戳} }
  const EXPO_HIST_KEY = 'aliExpoHist'; // { 客户键: [{h:内容指纹, ts}] } 跨天保留，防重复内容
  const EXPO_FAIL_KEY = 'aliExpoFail'; // [{at,name,loginId,account,reason,textDone,imgDone}] 失败可复盘
  const EXPO_CFG_KEY = 'aliExpoCfg';   // { limit, gapMin, gapMax }
  const EXPO_MAX_HARD = 500;           // 硬上限：防止误填成几千条
  async function loadExpoHist() {
    let o = null;
    try { const r = await chrome.storage.local.get(EXPO_HIST_KEY); o = r && r[EXPO_HIST_KEY]; } catch (e) { /* ignore */ }
    return o && typeof o === 'object' ? o : {};
  }
  async function saveExpoHist(h) {
    try { await chrome.storage.local.set({ [EXPO_HIST_KEY]: h }); } catch (e) { /* ignore */ }
  }
  // 失败记录：留最近 200 条，便于事后复盘（面板关掉也不会丢）
  async function loadExpoFail() {
    let o = null;
    try { const r = await chrome.storage.local.get(EXPO_FAIL_KEY); o = r && r[EXPO_FAIL_KEY]; } catch (e) { /* ignore */ }
    return Array.isArray(o) ? o : [];
  }
  async function appendExpoFail(rec) {
    try {
      const list = await loadExpoFail();
      list.unshift(rec);
      await chrome.storage.local.set({ [EXPO_FAIL_KEY]: list.slice(0, 200) });
    } catch (e) { /* ignore */ }
  }
  function hashOf(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  // 内容指纹 = 渲染后的文字 + 图片（文件名+大小），同一客户发过同样内容就不再发
  function expoContentHash(text, files) {
    const sig = (files || []).map((f) => String(f.name || '') + ':' + String(f.size || 0)).sort().join('|');
    return hashOf(String(text || '') + '#' + sig);
  }
  async function loadExpoCfg() {
    const def = { limit: 20, gapMin: 8, gapMax: 20 };
    let o = null;
    try { const r = await chrome.storage.local.get(EXPO_CFG_KEY); o = r && r[EXPO_CFG_KEY]; } catch (e) { /* ignore */ }
    if (!o) return def;
    return {
      limit: Math.max(1, Math.min(EXPO_MAX_HARD, parseInt(o.limit, 10) || def.limit)),
      gapMin: Math.max(3, Math.min(120, parseInt(o.gapMin, 10) || def.gapMin)),
      gapMax: Math.max(3, Math.min(300, parseInt(o.gapMax, 10) || def.gapMax)),
    };
  }
  async function saveExpoCfg(cfg) {
    try { await chrome.storage.local.set({ [EXPO_CFG_KEY]: cfg }); } catch (e) { /* ignore */ }
  }
  function expoKeyOf(sess) {
    return String((sess && sess.ct && (sess.ct.loginId || sess.ct.accountId)) || (sess && sess.name) || '');
  }
  async function loadExpoLog() {
    let o = null;
    try { const r = await chrome.storage.local.get(EXPO_LOG_KEY); o = r && r[EXPO_LOG_KEY]; } catch (e) { /* ignore */ }
    if (!o || o.date !== dayKey()) o = { date: dayKey(), count: 0, sent: {} };
    if (!o.sent) o.sent = {};
    return o;
  }
  async function saveExpoLog(o) {
    try { await chrome.storage.local.set({ [EXPO_LOG_KEY]: o }); } catch (e) { /* ignore */ }
  }
  // 模板变量：{name} 客户名、{first_name} 名、{loginId} 登录名
  function renderExpoText(tpl, sess) {
    const name = String((sess && sess.name) || '').trim();
    const vars = {
      name: name,
      first_name: name.split(/\s+/)[0] || name,
      loginId: String((sess && sess.ct && sess.ct.loginId) || ''),
    };
    return String(tpl || '').replace(/\{(name|first_name|loginId)\}/g, (m, k) => vars[k] || '');
  }

  async function openExpoBroadcast(startDate, endDate) {
    closeFeaturePanels('ali-expo-box');
    const old = document.getElementById('ali-expo-box');
    if (old) { old.remove(); return; }
    const box = document.createElement('div');
    box.id = 'ali-expo-box';
    box.style.cssText = 'position:fixed;right:16px;top:48px;z-index:2147483002;width:min(820px,96vw);height:min(800px,92vh);'
      + 'display:flex;flex-direction:column;background:#fff;border:1px solid #e5e7eb;border-radius:12px;'
      + 'box-shadow:0 10px 40px rgba(0,0,0,.18);font:13px/1.6 "Microsoft YaHei",sans-serif;color:#111;overflow:hidden;';
    const btnS = 'border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:4px 9px;cursor:pointer;font-size:12px;white-space:nowrap;';
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #f0f0f0;">'
      + '<b style="white-space:nowrap;">展会通知 · 站内群发</b>'
      + '<span id="ali-expo-prog" style="color:#6b7280;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">未采集</span>'
      + '<span style="flex:1"></span>'
      + '<button id="ali-expo-collect" style="' + btnS + '">采集客户</button>'
      + '<button id="ali-expo-preview" style="' + btnS + '" disabled>预览</button>'
      + '<button id="ali-expo-send" style="border:0;background:#2563eb;color:#fff;border-radius:6px;padding:5px 11px;cursor:pointer;font-size:12px;white-space:nowrap;">发送选中</button>'
      + '<button id="ali-expo-stop" style="' + btnS + '" disabled>停止</button>'
      + '<button id="ali-expo-retry" style="' + btnS + '">重试失败</button>'
      + '<button id="ali-expo-fails" style="' + btnS + '">失败明细</button>'
      + '<button id="ali-expo-diag" style="' + btnS + '">诊断</button>'
      + '<button id="ali-expo-close" style="border:0;background:#f3f4f6;border-radius:6px;padding:4px 9px;cursor:pointer;">关闭</button></div>'
      + '<div style="padding:8px 12px 6px;border-bottom:1px solid #f7f7f7;">'
      + '<textarea id="ali-expo-tpl" placeholder="粘贴展会通知文案，可用变量：{name} 客户名、{first_name} 名、{loginId} 登录名" '
      + 'style="width:100%;min-height:96px;padding:8px;border:1px solid #d1d5db;border-radius:8px;font:12.5px/1.6 inherit;resize:vertical;box-sizing:border-box;"></textarea>'
      + '<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:#6b7280;flex-wrap:wrap;">'
      + '<label style="cursor:pointer;border:1px solid #d1d5db;border-radius:6px;padding:3px 9px;background:#fff;">添加图片'
      + '<input id="ali-expo-files" type="file" accept="image/*" multiple style="display:none;"></label>'
      + '<span id="ali-expo-media-tip">未选择图片（最多 3 张）</span>'
      + '<span style="flex:1"></span>'
      + '<label style="cursor:pointer;color:#374151;"><input id="ali-expo-imgfirst" type="checkbox"> 先发图片再发文字</label>'
      + '<label style="cursor:pointer;color:#6b7280;"><input id="ali-expo-allowdup" type="checkbox"> 允许重发相同内容</label></div>'
      + '<div id="ali-expo-thumbs" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;"></div>'
      + '<div style="display:flex;align-items:center;gap:10px;margin-top:6px;font-size:12px;color:#6b7280;flex-wrap:wrap;">'
      + '<label>每日上限（个客户）<input id="ali-expo-limit" type="number" min="1" max="' + EXPO_MAX_HARD + '" value="20" '
      + 'style="width:64px;padding:3px 6px;border:1px solid #d1d5db;border-radius:6px;"></label>'
      + '<label>间隔 <input id="ali-expo-gap-min" type="number" min="3" max="120" value="8" '
      + 'style="width:52px;padding:3px 6px;border:1px solid #d1d5db;border-radius:6px;"> – '
      + '<input id="ali-expo-gap-max" type="number" min="3" max="300" value="20" '
      + 'style="width:52px;padding:3px 6px;border:1px solid #d1d5db;border-radius:6px;"> 秒</label>'
      + '<span id="ali-expo-quota"></span>'
      + '<span style="flex:1"></span>'
      + '<span style="color:#b45309;">建议先发 5 人；间隔越接近人工越安全</span></div></div>'
      + '<div id="ali-expo-stats" style="padding:6px 12px;color:#374151;font-size:12px;border-bottom:1px solid #f7f7f7;"></div>'
      + '<div id="ali-expo-preview-box" style="display:none;padding:6px 12px;color:#1f2937;font-size:12px;background:#f9fafb;border-bottom:1px solid #f0f0f0;white-space:pre-wrap;"></div>'
      + '<div id="ali-expo-list" style="flex:1;overflow:auto;padding:8px 12px;background:#fafafa;"></div>';
    document.body.appendChild(box);
    const $ = (id) => box.querySelector('#' + id);
    const list = $('ali-expo-list');
    const prog = (t) => { const el = $('ali-expo-prog'); if (el) el.textContent = t; };

    let items = [];       // { sess, checked, status, err }
    let busy = false;
    let stopped = false;
    let log = await loadExpoLog();
    const cfg0 = await loadExpoCfg();
    $('ali-expo-limit').value = String(cfg0.limit);
    $('ali-expo-gap-min').value = String(cfg0.gapMin);
    $('ali-expo-gap-max').value = String(cfg0.gapMax);
    // 每次发送前现读，允许中途改参数后继续用新值
    const readCfg = () => {
      const c = {
        limit: Math.max(1, Math.min(EXPO_MAX_HARD, parseInt($('ali-expo-limit').value, 10) || 20)),
        gapMin: Math.max(3, Math.min(120, parseInt($('ali-expo-gap-min').value, 10) || 8)),
        gapMax: Math.max(3, Math.min(300, parseInt($('ali-expo-gap-max').value, 10) || 20)),
      };
      if (c.gapMax < c.gapMin) c.gapMax = c.gapMin;
      return c;
    };
    let media = [];       // 本次随文案一起发送的图片（File），最多 3 张
    let mediaUrls = [];
    const renderMedia = () => {
      mediaUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
      mediaUrls = [];
      const t = $('ali-expo-media-tip');
      const thumbs = $('ali-expo-thumbs');
      if (!media.length) {
        t.textContent = '未选择图片（最多 3 张）';
        thumbs.innerHTML = '';
        return;
      }
      t.textContent = media.length + ' 张图片（随文字一起算一次发送）';
      thumbs.innerHTML = media.map((f, i) => {
        const u = URL.createObjectURL(f);
        mediaUrls.push(u);
        return '<div style="position:relative;">'
          + '<img src="' + u + '" style="width:72px;height:72px;object-fit:cover;border:1px solid #e5e7eb;border-radius:8px;">'
          + '<button data-del="' + i + '" style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:0;'
          + 'background:#ef4444;color:#fff;cursor:pointer;font-size:12px;line-height:18px;padding:0;">×</button>'
          + '<div style="font-size:10px;color:#9ca3af;text-align:center;">' + Math.max(1, Math.round(f.size / 1024)) + 'KB</div>'
          + '</div>';
      }).join('');
      thumbs.querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = () => { media.splice(parseInt(b.getAttribute('data-del'), 10), 1); renderMedia(); };
      });
    };

    const limitNow = () => readCfg().limit;
    const setBtns = () => {
      $('ali-expo-collect').disabled = busy;
      $('ali-expo-send').disabled = busy || !items.length;
      $('ali-expo-preview').disabled = busy || !items.length;
      $('ali-expo-stop').disabled = !busy;
    };
    const quotaText = () => {
      const left = Math.max(0, limitNow() - log.count);
      $('ali-expo-quota').textContent = '今日已发 ' + log.count + ' 个客户，剩余 ' + left + ' 个';
    };
    const checkedItems = () => items.filter((it) => it.checked);
    const stats = () => {
      const sel = checkedItems().length;
      const sent = items.filter((x) => x.status === 'sent').length;
      const bad = items.filter((x) => x.status === 'error').length;
      const done = items.filter((x) => !!log.sent[expoKeyOf(x.sess)]).length;
      const dup = items.filter((x) => x.status === 'skip').length;
      $('ali-expo-stats').innerHTML = '客户 <b>' + items.length + '</b> · 选中 <b>' + sel + '</b> · 今日已发 <b>' + log.count + '/' + limitNow()
        + '</b> · 本次成功 <b>' + sent + '</b> · 失败 <b>' + bad + '</b> · 重复跳过 <b>' + dup + '</b> · 历史已发 <b>' + done + '</b>'
        + '<label style="margin-left:10px;color:#6b7280;cursor:pointer;">'
        + '<input type="checkbox" id="ali-expo-all"' + (items.length && sel === items.length ? ' checked' : '') + '> 全选</label>';
      const all = $('ali-expo-all');
      if (all) all.onchange = () => { items.forEach((it) => { it.checked = all.checked; }); render(); };
      quotaText();
    };
    const badge = (st) => {
      const m = {
        pending: ['待发送', '#eff6ff', '#1d4ed8'],
        sending: ['发送中', '#fff7ed', '#c2410c'],
        sent: ['已发送', '#ecfdf5', '#047857'],
        error: ['失败', '#fef2f2', '#b91c1c'],
        skip: ['跳过', '#f3f4f6', '#6b7280'],
      };
      const x = m[st] || m.pending;
      return '<span style="background:' + x[1] + ';color:' + x[2] + ';border-radius:10px;padding:1px 8px;font-size:11px;">' + x[0] + '</span>';
    };
    const render = () => {
      if (!items.length) {
        list.innerHTML = '<div style="padding:24px;color:#9ca3af;text-align:center;">点「采集客户」拉取该时间段内有聊天往来的客户</div>';
        stats(); setBtns(); return;
      }
      list.innerHTML = items.map((it, i) => {
        const s = it.sess;
        const doneTs = log.sent[expoKeyOf(s)];
        const cur = curAcctId();
        const acctId = String((s.acct && s.acct.accountId) || '');
        const acctName = String((s.acct && s.acct.name) || acctId || '');
        const mismatch = !!(cur && acctId && cur !== acctId);
        let lb = null;
        for (let k = s.msgs.length - 1; k >= 0; k--) {
          const m = s.msgs[k];
          if (!m.mine && !isChatNoise(m.c)) { lb = m; break; }
        }
        return '<div data-i="' + i + '" style="display:flex;gap:8px;align-items:flex-start;background:#fff;border:1px solid #e5e7eb;'
          + 'border-radius:10px;padding:8px 10px;margin-bottom:8px;' + (it.checked ? '' : 'opacity:.6;') + '">'
          + '<input type="checkbox" data-check="' + i + '"' + (it.checked ? ' checked' : '') + ' style="margin-top:3px;">'
          + '<div style="flex:1;min-width:0;">'
          + '<div style="display:flex;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap;">'
          + '<b>' + escHtml(s.name) + '</b>'
          + (s.ct && s.ct.loginId ? '<span style="color:#9ca3af;font-size:11px;">' + escHtml(String(s.ct.loginId)) + '</span>' : '')
          + (acctName ? '<span style="color:#6b7280;font-size:11px;">子账号：' + escHtml(acctName) + '</span>' : '')
          + (mismatch ? '<button data-switch="' + escHtml(acctId) + '" style="border:1px solid #fcd34d;background:#fffbeb;color:#b45309;'
            + 'border-radius:6px;padding:1px 7px;cursor:pointer;font-size:11px;">切到该子账号</button>' : '')
          + '<span style="flex:1"></span>' + (doneTs ? '<span style="color:#047857;font-size:11px;">今日已发</span> ' : '') + badge(it.status) + '</div>'
          + '<div style="color:#4b5563;font-size:12px;margin-top:2px;">最近客户消息：' + escHtml(lb ? (lb.t + '｜' + lb.c.slice(0, 120)) : '（无）') + '</div>'
          + (it.err ? '<div style="color:#b91c1c;font-size:11.5px;">' + escHtml(it.err) + '</div>' : '')
          + '</div></div>';
      }).join('');
      list.querySelectorAll('[data-switch]').forEach((el) => {
        el.onclick = () => {
          const id = el.getAttribute('data-switch');
          try {
            const u = new URL(location.href);
            u.searchParams.set('activeAccountId', id);
            toast('正在切换到子账号 ' + id + '，加载后请重新采集');
            location.href = u.toString();
          } catch (e) { toast('切换失败：' + e.message, true); }
        };
      });
      list.querySelectorAll('[data-check]').forEach((el) => {
        el.onchange = () => {
          const i = parseInt(el.getAttribute('data-check'), 10);
          if (items[i]) items[i].checked = el.checked;
          render();
        };
      });
      stats(); setBtns();
    };

    const collect = async () => {
      busy = true; stopped = false; items = []; render();
      try {
        const all = await collectChatSessions(startDate, endDate, (d) => prog('已取 ' + d + ' 个会话…'));
        items = all.filter((s) => lastBuyerTs(s) > 0)
          .map((s) => ({ sess: s, checked: false, status: 'pending', err: '', textDone: false, imgDone: false }));
        prog('采集完成：' + items.length + ' 个有往来的客户');
      } catch (e) {
        prog('采集失败（需在聊天页操作）：' + e.message);
      }
      busy = false; render();
    };

    const preview = () => {
      const tpl = String($('ali-expo-tpl').value || '').trim();
      const target = checkedItems()[0];
      const boxEl = $('ali-expo-preview-box');
      if (!tpl && !media.length) { toast('请先填写文案或添加图片', true); return; }
      if (!target) { toast('请先勾选至少一个客户', true); return; }
      boxEl.style.display = 'block';
      boxEl.textContent = '预览（' + target.sess.name + '）：\n'
        + (tpl ? renderExpoText(tpl, target.sess) : '（不发送文字）')
        + (media.length ? '\n\n[附带图片 ' + media.length + ' 张' + ($('ali-expo-imgfirst').checked ? '，先发图片' : '') + ']' : '');
    };

    const sendSelected = async () => {
      if (busy) return;
      if (!/weblitePWA/i.test(location.pathname)) { toast('请先进入聊天窗口（weblitePWA）再发送', true); return; }
      const tpl = String($('ali-expo-tpl').value || '').trim();
      const files = media.slice();
      if (!tpl && !files.length) { toast('请先填写文案或添加图片', true); return; }
      log = await loadExpoLog();
      const hist = await loadExpoHist();
      const allowDup = $('ali-expo-allowdup').checked;
      const limit = limitNow();
      const remain = limit - log.count;
      if (remain <= 0) { toast('今日已达上限 ' + limit + ' 个客户', true); return; }
      const pool = checkedItems().filter((it) => !log.sent[expoKeyOf(it.sess)]);
      if (!pool.length) { toast('选中的客户今天都已发过（或没有勾选）', true); return; }

      // 内容级去重：同一客户发过同样的「文字+图片」就跳过（跨天生效，避免重复打扰）
      const plan = [];
      let dupSkipped = 0;
      for (const it of pool) {
        const text = tpl ? renderExpoText(tpl, it.sess) : '';
        const hash = expoContentHash(text, files);
        const key = expoKeyOf(it.sess);
        const rec = (hist[key] || []).find((x) => x && x.h === hash);
        if (!allowDup && rec) {
          it.status = 'skip';
          it.err = '相同内容已发过（' + (rec.ts ? fmtDate(rec.ts, '-') : '之前') + '），已自动跳过';
          dupSkipped += 1;
          continue;
        }
        plan.push({ it, text, hash, key });
      }
      render();
      if (!plan.length) { toast('选中的客户都发过相同内容，已全部跳过', true); return; }
      const n = Math.min(plan.length, remain);   // 按客户计次：一条任务含文字+图片也只算 1 次
      const imgFirst = $('ali-expo-imgfirst').checked;
      const c0 = readCfg();
      const ok = window.confirm('将向 ' + n + ' 个客户发送展会通知'
        + (files.length ? '（每条含 ' + files.length + ' 张图片，按' + (imgFirst ? '先图后文' : '先文后图') + '顺序）' : '')
        + '，间隔 ' + c0.gapMin + '–' + c0.gapMax + ' 秒随机，每 5–9 个客户额外休息 30–90 秒，今日剩余可发 ' + remain + ' 个客户。'
        + (dupSkipped ? '\n已自动跳过 ' + dupSkipped + ' 个「发过相同内容」的客户。' : '')
        + '\n请确认当前聊天窗口可正常发送，发送期间不要操作页面。继续？');
      if (!ok) return;
      busy = true; stopped = false; setBtns();
      let success = 0, fail = 0;
      let restIn = 5 + Math.floor(Math.random() * 5);
      for (let i = 0; i < n; i++) {
        if (stopped) break;
        const { it, text, hash, key } = plan[i];
        prog('发送 ' + (i + 1) + '/' + n + '：' + it.sess.name);
        it.status = 'sending'; it.err = ''; render();
        try {
          const doText = async () => { if (!text || it.textDone) return; await uiSendTo(it.sess, text); it.textDone = true; };
          const doImg = async () => {
            if (!files.length || it.imgDone) return;
            const c = await uiSelectSessionPwa(it.sess);
            await uiAttachImages(files, c, it.sess);
            it.imgDone = true;
          };
          if (imgFirst) { await doImg(); await doText(); }
          else { await doText(); await doImg(); }
          it.status = 'sent'; success++;
          log.count += 1;
          log.sent[key] = Date.now();
          const list = (hist[key] || []).filter((x) => x && x.h !== hash);
          list.unshift({ h: hash, ts: Date.now() });
          hist[key] = list.slice(0, 20);
          await saveExpoLog(log);
          await saveExpoHist(hist);
        } catch (e) {
          it.status = 'error'; fail++;
          it.err = (it.textDone || it.imgDone)
            ? '部分已发送（' + (it.textDone ? '文字✓ ' : '') + (it.imgDone ? '图片✓ ' : '') + '），重试只会补没发出去的部分：' + e.message
            : '发送失败：' + e.message;
          await appendExpoFail({
            at: new Date().toISOString(),
            name: it.sess.name,
            loginId: (it.sess.ct && it.sess.ct.loginId) || '',
            account: (it.sess.acct && (it.sess.acct.name || it.sess.acct.accountId)) || '',
            curAccountId: curAcctId(),
            reason: e.message,
            textDone: !!it.textDone,
            imgDone: !!it.imgDone,
          });
        }
        render();
        if (i < n - 1 && !stopped) {
          const c = readCfg();
          let waitMs = (c.gapMin + Math.random() * (c.gapMax - c.gapMin)) * 1000;
          restIn -= 1;
          if (restIn <= 0) {
            waitMs += (30 + Math.floor(Math.random() * 61)) * 1000;
            restIn = 5 + Math.floor(Math.random() * 5);
            prog('已发送 ' + success + ' 条，按人工节奏休息 ' + Math.round(waitMs / 1000) + ' 秒后再继续…');
          } else {
            prog('已发送 ' + success + ' 条，失败 ' + fail + ' 条，等待 ' + Math.round(waitMs / 1000) + ' 秒…');
          }
          for (let t = 0; t < waitMs && !stopped; t += 500) await uiWait(500);
        }
      }
      busy = false;
      prog(stopped ? ('已停止：成功 ' + success + '，失败 ' + fail) : ('发送结束：成功 ' + success + '，失败 ' + fail));
      render();
    };

    $('ali-expo-close').onclick = () => { stopped = true; box.remove(); };
    $('ali-expo-retry').onclick = () => {
      if (busy) return;
      const bad = items.filter((x) => x.status === 'error');
      if (!bad.length) { toast('没有失败项', true); return; }
      items.forEach((x) => { x.checked = x.status === 'error'; });
      render();
      prog('已只勾选 ' + bad.length + ' 个失败客户，开始重试…');
      sendSelected();
    };
    $('ali-expo-fails').onclick = async () => {
      const list = await loadExpoFail();
      if (!list.length) { toast('还没有失败记录', true); return; }
      console.log('[ali-export-ext][EXPO-FAIL]', list);
      const txt = JSON.stringify(list, null, 2);
      navigator.clipboard.writeText(txt)
        .then(() => toast('失败明细已复制（' + list.length + ' 条）'))
        .catch(() => toast('已打印到 Console（F12）', true));
    };
    $('ali-expo-stop').onclick = () => { stopped = true; prog('停止中…'); };
    $('ali-expo-diag').onclick = () => {
      const d = uiDiagnose();
      const txt = JSON.stringify(d, null, 2);
      console.log('[ali-export-ext][EXPO-DIAG]', d);
      navigator.clipboard.writeText(txt)
        .then(() => toast('页面结构已复制，发给开发者可定位「找不到会话」'))
        .catch(() => toast('已打印到 Console（F12）', true));
    };
    $('ali-expo-collect').onclick = () => { if (!busy) collect(); };
    $('ali-expo-preview').onclick = () => preview();
    $('ali-expo-send').onclick = () => sendSelected();
    const persistCfg = () => { saveExpoCfg(readCfg()); };
    $('ali-expo-limit').onchange = () => { persistCfg(); stats(); };
    $('ali-expo-gap-min').onchange = () => { persistCfg(); };
    $('ali-expo-gap-max').onchange = () => { persistCfg(); };
    $('ali-expo-files').onchange = (e) => {
      const picked = Array.from(e.target.files || []).filter((f) => /^image\//i.test(f.type || ''));
      if (picked.length) media = media.concat(picked).slice(0, 3);
      e.target.value = '';
      renderMedia();
    };
    $('ali-expo-imgfirst').onchange = () => {
      const boxEl = $('ali-expo-preview-box');
      if (boxEl && boxEl.style.display !== 'none') preview();
    };
    $('ali-expo-tpl').addEventListener('input', () => {
      const boxEl = $('ali-expo-preview-box');
      if (boxEl.style.display !== 'none') boxEl.style.display = 'none';
    });

    render();
    await collect();
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
    const d = new Date();
    d.setDate(d.getDate() + (offset || 0));
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }

  // ---------------- 跨页面路由（统一工作台：点功能 → 跳到对应页 → 落地再点一次执行） ----------------
  const PENDING_KEY = 'aliPendingExport';
  // 工作台功能表：url=目标页地址（null=不限页面）；to=目标页显示名；date=需要时间范围；fields=客户类可选时间字段
  // group='tool' 的功能收纳在「更多工具」里
  const MSG_PAGE = 'https://message.alibaba.com/message/default.htm';
  const CHAT_PAGE = 'https://onetalk.alibaba.com/message/messageManager.htm#/';
  const CHAT_WIN = 'https://onetalk.alibaba.com/message/weblitePWA.htm'; // 真正的聊天窗口
  // 记下最近一次可用的聊天窗口完整地址（含 activeAccountId / chatToken），跳转时优先复用
  if (/weblitePWA/i.test(location.pathname)) {
    try {
      activeAiWorkspace().then((workspace) => chrome.storage.local.set({
        ['aliLastChatUrl:' + encodeURIComponent(workspace)]: { url: location.href, ts: Date.now() },
      })).catch(() => {});
    } catch (e) { /* ignore */ }
  }
  // ---------------- 登录态回填：把当前会话推给本地常驻进程 ----------------
  // 常驻进程不再依赖手工 Copy as cURL；仅在员工主动点击“同步登录态”时回填。
  const BRIDGE_URL = 'http://127.0.0.1:39271';
  const BRIDGE_SYNC_KEY = 'aliBridgeSyncAt';

  // 返回 { ok, result } | 抛出可读错误；cookie 读取、请求组装与验活都在后台/Node 侧完成
  // （chrome.cookies 在内容脚本不可用，页面 CSP 也常禁止直连 127.0.0.1）
  function syncViaBackground() {
    // 页面侧兜底：若后台从 cookie 里找不到 ctoken，可用这里的 document.cookie 结果补
    let hint = '';
    let tbHint = '';
    try {
      const m = document.cookie.match(/ctoken=([^&;]*)/);
      hint = m && m[1] ? decodeURIComponent(m[1]) : '';
      tbHint = getCookie('_tb_token_') || '';
    } catch (e) { hint = ''; }
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'bridgeSync', url: BRIDGE_URL, ctokenFallback: hint, tbFallback: tbHint, pageUrl: location.href }, (r) => {
          if (chrome.runtime.lastError) { reject(new Error('后台无响应：' + chrome.runtime.lastError.message)); return; }
          if (!r) { reject(new Error('后台无响应')); return; }
          if (!r.ok) { reject(new Error(r.error || ('HTTP ' + r.status))); return; }
          resolve(r);
        });
      } catch (e) { reject(e); }
    });
  }

  // 页面级自检：当前浏览器里国际站到底有没有登录（比读 cookie 更可靠）
  // 返回 true=已登录 / false=被跳到登录页 / null=判断不了
  async function pageLoginOk() {
    if (!/^message\.alibaba\.com$/i.test(location.hostname)) return null;
    try {
      const r = await fetch('https://message.alibaba.com/message/default.htm', { credentials: 'include', cache: 'no-store' });
      if (/icbu_login|passport\.alibaba\.com/i.test(r.url)) return false;
      const txt = await r.text();
      if (/icbu_login|passport\.alibaba\.com\/icbu_login/i.test(txt.slice(0, 3000))) return false;
      return true;
    } catch (e) { return null; }
  }

  async function pushLoginState(opts) {
    const silent = !!(opts && opts.silent);
    const logged = await pageLoginOk();
    if (logged === false) {
      throw new Error('这个浏览器里的国际站是未登录状态（页面本身会被跳到登录页）。请先在本浏览器登录 message.alibaba.com，再点同步');
    }
    let r;
    try {
      r = await syncViaBackground();
    } catch (e) {
      throw new Error('推送失败：' + e.message + '（确认常驻进程在运行：浏览器打开 http://127.0.0.1:39271/health）');
    }
    try { await chrome.storage.local.set({ [BRIDGE_SYNC_KEY]: Date.now() }); } catch (e) { /* ignore */ }
    const info = r && r.result ? ('（校验通过：' + r.result.fetched + ' 条 / 共 ' + r.result.total + '）') : '';
    if (!silent) toast('登录态已同步到后台' + info + '，任务会自动继续');
    console.log('[ali-export-ext] 登录态已同步', r && r.result);
    return true;
  }

  const WORKBENCH = [
    { id: 'inquiry', label: '询盘导出', url: MSG_PAGE, to: '询盘页', date: true, hint: '导出询盘列表（自动补全客户信息）' },
    { id: 'invview', label: '询盘增强', url: MSG_PAGE, to: '询盘页', date: true, hint: '先采集，再按国家/去重筛选后导出' },
    { id: 'chat', label: '聊天导出', url: CHAT_PAGE, to: '聊天页', date: true, hint: '导出指定时间段的聊天记录' },
    { id: 'aianalysis', label: '聊天分析（AI）', url: CHAT_PAGE, to: '聊天页', date: true, hint: '流式分析该时间段聊天，可实时追问' },
    { id: 'finishedreply', label: '成品需求 · 婉拒回复', url: CHAT_WIN, to: '聊天窗口', date: true, hint: '执行后会跳到聊天窗口（weblitePWA），到达后再点一次执行' },
    { id: 'expo', label: '展会通知 · 群发', url: CHAT_WIN, to: '聊天窗口', date: true, hint: '只发给时间范围内有往来的客户；支持文字+图片，间隔与每日上限可配' },
    { id: 'crmmine', label: '我的客户', url: 'https://i.alibaba.com/hub/alicrm/my_customer', to: '客户管理页', hint: '拉取我的客户全量快照并入库（不按日期筛选）' },
    { id: 'crmpub', label: '公海客户', url: 'https://i.alibaba.com/hub/alicrm/public_customer', to: '公海客户页', hint: '拉取公海客户全量快照并入库（不按日期筛选）' },
    { id: 'order', label: '订单导出', url: 'https://biz.alibaba.com/ta/list/scene/mainList.htm', to: '订单页', date: true, hint: '导出信保订单列表：状态、金额、币种、产品明细' },
    { id: 'visitors', label: '访客导出', url: 'https://data.alibaba.com/marketing/visitor', to: '访客页', date: true, hint: '单次范围建议不超过 30 天' },
    { id: 'diag', label: '自检接口', url: MSG_PAGE, to: '询盘页', group: 'tool' },
    { id: 'syncCookie', label: '同步登录态到后台', url: null, group: 'tool', hint: '把当前登录态推给常驻进程（cookie 过期时点一下，不需要跳页）' },
    { id: 'custdiag', label: '客户接口自检', url: MSG_PAGE, to: '询盘页', group: 'tool' },
    { id: 'chatdiag', label: '聊天接口自检', url: CHAT_PAGE, to: '聊天页', group: 'tool' },
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
      case 'finishedreply': return openFinishedReply(start, end);
      case 'expo': return openExpoBroadcast(start, end);
      case 'crmmine': return exportCustomers(btn, 'mine', start, end, '');
      case 'crmpub': return exportCustomers(btn, 'public', start, end, '');
      case 'order': return exportOrders(start, end, btn);
      case 'visitors': return exportVisitors(start, end, btn);
      case 'diag': return runDiagnostics(btn);
      case 'syncCookie': return pushLoginState().catch((e) => toast(e.message, true));
      case 'custdiag': return probeCustomer(btn);
      case 'chatdiag': return probeChat(btn);
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
    toast(`已到达${fn.to || '目标页面'}，请确认时间范围后再开始`);
  }

  const WORKBENCH_UI = {
    inquiry: { title: '询盘数据', desc: '导出询盘，并自动更新本机资料库', action: '导出询盘' },
    invview: { title: '筛选询盘', desc: '按国家筛选、按客户去重后再导出', action: '打开询盘筛选' },
    chat: { title: '聊天记录', desc: '导出所选时间段的客户沟通记录', action: '导出聊天记录' },
    aianalysis: { title: '右侧 AI 客户助手', desc: '边查看客户分析边处理聊天回复', action: '打开右侧模块' },
    finishedreply: { title: '成品需求筛选', desc: '识别不匹配需求，核对客户后处理回复', action: '查看待处理客户' },
    expo: { title: '展会通知', desc: '准备触达名单、文字和图片', action: '准备展会通知' },
    crmmine: { title: '我的客户', desc: '拉取我的客户全量快照并入库', action: '同步客户' },
    crmpub: { title: '公海客户', desc: '拉取公海客户全量快照并入库', action: '同步公海' },
    order: { title: '订单数据', desc: '导出信保订单，含状态、金额与产品明细', action: '导出订单' },
    visitors: { title: '访客数据', desc: '了解近期访客和搜索需求', action: '导出访客数据' },
    diag: { title: '询盘接口自检', desc: '检查询盘页面接口是否可用', action: '运行询盘自检' },
    syncCookie: { title: '同步后台登录态', desc: '常驻监控提示登录失效时使用', action: '同步登录态' },
    custdiag: { title: '客户接口自检', desc: '检查客户资料接口是否可用', action: '运行客户自检' },
    chatdiag: { title: '聊天接口自检', desc: '检查聊天页面接口是否可用', action: '运行聊天自检' },
    aicfg: { title: 'AI 模型配置', desc: '配置模型与本地 MCP 接入', action: '打开 AI 设置' },
  };
  const wbUi = (id) => WORKBENCH_UI[id] || { title: id, desc: '', action: '开始' };
  const currentPageName = () => {
    if (location.hostname === 'message.alibaba.com') return '询盘页面';
    if (location.hostname === 'onetalk.alibaba.com') return /weblitePWA/i.test(location.pathname) ? '聊天窗口' : '聊天管理';
    if (location.hostname === 'biz.alibaba.com') return '订单页面';
    if (/my_customer/i.test(location.pathname)) return '我的客户页面';
    if (/public_customer/i.test(location.pathname)) return '公海客户页面';
    if (location.hostname === 'data.alibaba.com') return '访客页面';
    return location.hostname;
  };
  const defaultWorkbenchAction = () => {
    if (location.hostname === 'onetalk.alibaba.com') return 'aianalysis';
    if (location.hostname === 'biz.alibaba.com') return 'order';
    if (/my_customer/i.test(location.pathname)) return 'crmmine';
    if (/public_customer/i.test(location.pathname)) return 'crmpub';
    if (location.hostname === 'data.alibaba.com') return 'visitors';
    return 'inquiry';
  };
  let wbSelected = defaultWorkbenchAction();

  function syncQuickState(box) {
    const start = box.querySelector('#ali-start').value;
    const end = box.querySelector('#ali-end').value;
    box.querySelectorAll('[data-quick]').forEach((el) => {
      const v = el.getAttribute('data-quick');
      const n = parseInt(v, 10);
      const on = v === 'all' ? !start && !end : start === todayStr(-(n - 1)) && end === todayStr(0);
      el.classList.toggle('is-active', !!on);
      el.setAttribute('aria-pressed', String(!!on));
    });
  }

  // 高亮选中项，并按功能切换「时间字段/时间范围」的显隐与提示
  function selectFn(id) {
    wbSelected = id;
    const box = document.getElementById('ali-export-panel');
    if (!box) return;
    const fn = fnById(id) || {};
    const ui = wbUi(id);
    box.querySelectorAll('[data-fn]').forEach((el) => {
      const on = el.getAttribute('data-fn') === id;
      el.classList.toggle('is-selected', on);
      el.setAttribute('aria-pressed', String(on));
    });
    if (fn.group === 'tool') box.querySelector('#ali-wb-advanced').open = true;
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
    const jump = !!(fn.url && !onTarget(fn));
    if (hint) hint.innerHTML = '<strong>' + escHtml(ui.title) + '</strong><span>' + escHtml(ui.desc) + '</span>'
      + (jump ? '<em>先前往' + escHtml(fn.to) + '，到达后再点一次开始。</em>' : '');
    const run = box.querySelector('#ali-btn-run');
    if (run) run.textContent = jump ? '前往' + fn.to : ui.action;
    const note = box.querySelector('#ali-run-note');
    if (note) note.textContent = id === 'expo' || id === 'finishedreply'
      ? '发送前请在下一步核对客户、消息内容和发送范围。'
      : jump ? '切换页面不会自动执行，抵达后需要再确认一次。'
        : needDate ? '默认近 7 天；选择“全部”会处理更多数据，耗时也更长。' : '此操作只影响当前登录账号与本机配置。';
  }

  function fillForm(p) {
    const si = document.getElementById('ali-start'); const ei = document.getElementById('ali-end');
    if (si && typeof p.start === 'string') si.value = p.start;
    if (ei && typeof p.end === 'string') ei.value = p.end;
    if (p.action) selectFn(p.action);
    if (p.dateField) { const sel = document.getElementById('ali-datefield'); if (sel) sel.value = p.dateField; }
    const box = document.getElementById('ali-export-panel'); if (box) syncQuickState(box);
  }

  function mountPanel() {
    if (document.getElementById('ali-export-panel')) return;
    const box = document.createElement('div');
    box.id = 'ali-export-panel';
    box.setAttribute('role', 'complementary');
    box.setAttribute('aria-label', '外贸员工工作台');
    const fnBtn = (f) => {
      const ui = wbUi(f.id);
      return `<button type="button" data-fn="${f.id}" class="ali-wb-action" aria-pressed="false">
        <span><strong>${escHtml(ui.title)}</strong><small>${escHtml(ui.desc)}</small></span><span class="ali-wb-arrow" aria-hidden="true">›</span></button>`;
    };
    const work = ['aianalysis', 'finishedreply', 'expo'].map(fnById);
    const exports = ['inquiry', 'invview', 'chat', 'order', 'crmmine', 'crmpub', 'visitors'].map(fnById);
    const tools = WORKBENCH.filter((f) => f.group === 'tool' && f.id !== 'syncCookie');
    box.innerHTML = `
      <div class="ali-wb-head">
        <span class="ali-wb-mark" aria-hidden="true">贸</span>
        <span class="ali-wb-brand"><strong>外贸助手</strong><small>员工工作台 · v${VERSION}</small></span>
        <button type="button" id="ali-collapse" aria-label="收起外贸助手">收起</button>
      </div>
      <div class="ali-wb-body">
        <div class="ali-wb-page">当前页面：<b>${escHtml(currentPageName())}</b></div>
        <div class="ali-wb-shortcuts">
          <button type="button" id="ali-btn-platform" class="ali-wb-shortcut">打开今日待办 ↗</button>
          <button type="button" id="ali-ai-shortcut" class="ali-wb-shortcut secondary">分析客户聊天</button>
        </div>
        <section class="ali-wb-execute" aria-label="当前操作">
          <h3>当前操作</h3>
          <div id="ali-fn-hint" aria-live="polite"></div>
          <div id="ali-date-row">
            <input id="ali-start" type="date" value="${todayStr(-6)}" aria-label="开始日期">
            <span>至</span>
            <input id="ali-end" type="date" value="${todayStr(0)}" aria-label="结束日期">
          </div>
          <div id="ali-quick-row" aria-label="快捷时间范围">
            <button type="button" data-quick="1" aria-pressed="false">今天</button>
            <button type="button" data-quick="7" aria-pressed="false">近 7 天</button>
            <button type="button" data-quick="30" aria-pressed="false">近 30 天</button>
            <button type="button" data-quick="all" aria-pressed="false">全部</button>
          </div>
          <div id="ali-datefield-wrap"><span>按</span><select id="ali-datefield" aria-label="客户时间字段"></select><span>筛选</span></div>
          <button type="button" id="ali-btn-run">开始</button>
          <div id="ali-run-note"></div>
          <div id="ali-status" role="status" aria-live="polite"></div>
        </section>
        <section class="ali-wb-section" aria-label="客户工作">
          <div class="ali-wb-section-title"><h3>客户工作</h3><span>先处理，再复盘</span></div>
          <div class="ali-wb-grid work">${work.map(fnBtn).join('')}</div>
        </section>
        <section class="ali-wb-section" aria-label="数据更新">
          <div class="ali-wb-section-title"><h3>数据更新</h3><span>导出或导入后入库</span></div>
          <div class="ali-wb-grid">${exports.map(fnBtn).join('')}</div>
        </section>
        <details id="ali-wb-advanced" class="ali-wb-advanced">
          <summary>配置与排障</summary>
          <div>
            <div class="ali-wb-grid">${tools.map(fnBtn).join('')}</div>
            <button type="button" id="ali-btn-sync">同步登录态到后台</button>
            <div id="ali-diag-wrap" style="display:none;">
              <textarea id="ali-diag" readonly aria-label="接口自检结果"></textarea>
              <button type="button" id="ali-copy">复制自检结果</button>
            </div>
          </div>
        </details>
        <div class="ali-wb-foot">采集使用当前登录账号 · Excel 下载到本机，资料库保存在本机浏览器</div>
      </div>
    `;
    document.body.appendChild(box);
    const start = () => { const el = document.getElementById('ali-start'); return el ? el.value : ''; };
    const end = () => { const el = document.getElementById('ali-end'); return el ? el.value : ''; };
    const dateField = () => { const el = document.getElementById('ali-datefield'); return el ? el.value : ''; };

    box.querySelectorAll('[data-fn]').forEach((el) => {
      el.onclick = () => {
        selectFn(el.getAttribute('data-fn'));
        box.querySelector('.ali-wb-execute').scrollIntoView({ block: 'nearest' });
      };
    });
    box.querySelectorAll('[data-quick]').forEach((el) => {
      el.onclick = () => {
        const si = document.getElementById('ali-start'); const ei = document.getElementById('ali-end');
        const v = el.getAttribute('data-quick');
        if (v === 'all') { si.value = ''; ei.value = ''; syncQuickState(box); return; } // 清空 = 不限时间（导出全部）
        const n = parseInt(v, 10) || 1;
        si.value = todayStr(-(n - 1));
        ei.value = todayStr(0);
        syncQuickState(box);
      };
    });
    box.querySelector('#ali-start').onchange = () => syncQuickState(box);
    box.querySelector('#ali-end').onchange = () => syncQuickState(box);
    box.querySelector('#ali-ai-shortcut').onclick = () => {
      selectFn('aianalysis');
      box.querySelector('.ali-wb-execute').scrollIntoView({ block: 'nearest' });
    };
    document.getElementById('ali-collapse').onclick = () => collapsePanel();
    document.getElementById('ali-btn-platform').onclick = () => {
      chrome.runtime.sendMessage({ type: 'openDashboard' }, () => {
        if (chrome.runtime.lastError) toast('打开看板失败：' + chrome.runtime.lastError.message, true);
      });
    };
    document.getElementById('ali-btn-sync').onclick = (e) => {
      const b = e.target;
      b.disabled = true; b.textContent = '同步中…';
      pushLoginState()
        .catch((err) => toast(err.message, true))
        .finally(() => { b.disabled = false; b.textContent = '同步登录态到后台'; });
    };
    document.getElementById('ali-copy').onclick = () => {
      const ta = document.getElementById('ali-diag');
      navigator.clipboard.writeText(ta.value).then(() => toast('自检结果已复制')).catch(() => { ta.select(); document.execCommand('copy'); toast('自检结果已复制'); });
    };
    document.getElementById('ali-btn-run').onclick = async (e) => {
      const btn = e.target;
      const fn = fnById(wbSelected);
      if (!fn) return;
      if (start() && end() && start() > end()) { toast('开始日期不能晚于结束日期', true); return; }
      const needJump = !onTarget(fn);
      console.log('[ali-export-ext] run', fn.id, 'url=', location.href, 'target=', fn.url, 'needJump=', needJump);
      const payload = { action: fn.id, start: start(), end: end(), dateField: dateField() };
      if (needJump) { // 不在目标页 → 跳转到该功能对应的页面（落地后再点一次才开始）
        let target = fn.url;
        // 聊天窗口带 activeAccountId / chatToken，优先复用最近一次可用地址
        if (fn.id === 'finishedreply' || fn.id === 'expo') {
          try {
            const key = 'aliLastChatUrl:' + encodeURIComponent(await activeAiWorkspace());
            const o = await chrome.storage.local.get(key);
            const last = o && o[key];
            if (last && last.url && Date.now() - (last.ts || 0) < 24 * 60 * 60 * 1000) target = last.url;
          } catch (e) { /* ignore */ }
        }
        if (fn.id === 'aianalysis') {
          const aiTarget = new URL(target);
          if (start()) aiTarget.searchParams.set('aliAiStart', start());
          if (end()) aiTarget.searchParams.set('aliAiEnd', end());
          await chrome.storage.local.set({ [aiPanelKey(await activeAiWorkspace())]: true });
          location.href = aiTarget.href;
          return;
        }
        await stashPending(payload);
        toast(`正在前往${fn.to}，到达后请再次确认开始`);
        location.href = target;
        return;
      }
      try { await runAction(fn.id, payload.start, payload.end, payload.dateField, btn); }
      catch (err) { toast('操作失败：' + ((err && err.message) || err), true); }
      finally { btn.disabled = false; selectFn(wbSelected); }
    };
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') collapsePanel(); });
    selectFn(wbSelected);
    syncQuickState(box);
  }

  // 侧边入口（默认只显示这个：logo + 名字，点了才展开完整面板）
  function mountDock() {
    if (document.getElementById('ali-dock') || document.getElementById('ali-export-panel')) return;
    const d = document.createElement('button');
    d.id = 'ali-dock';
    d.type = 'button';
    d.setAttribute('aria-label', '打开外贸助手员工工作台');
    d.innerHTML = '<span class="ali-dock-mark" aria-hidden="true">贸</span><span>外贸助手</span>';
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
  async function currentAiFocusName() {
    try {
      const fromUrl = new URL(location.href).searchParams.get('aliAiFocus');
      if (fromUrl) return fromUrl;
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await chrome.runtime.sendMessage({ type: 'getAiChatFocus' });
        if (result && result.customer) return result.customer;
        if (attempt < 2) await uiWait(150);
      }
    } catch (e) { /* 普通聊天页没有指定客户 */ }
    return '';
  }
  async function maybeAutoOpenChat() {
    if (window.self !== window.top) return;
    if (!/^https:\/\/onetalk\.alibaba\.com\/message\/(weblitePWA|messageManager)/i.test(location.href)) return;
    try {
      // 工作台确认发送/测试时由各自流程统一定位，避免两处同时点击会话。
      const params = new URL(location.href).searchParams;
      if (params.get('aliSmartReply') === '1' || params.get('aliInboxProbe') === '1'
        || params.get('aliInboxAutoTest') === '1') return;
    } catch (e) { /* 继续走普通定位 */ }
    let want = '';
    try {
      const u = new URL(location.href);
      want = u.searchParams.get('aliChat') || '';
      if (want) {
        u.searchParams.delete('aliChat');
        history.replaceState(null, '', u.pathname + u.search + u.hash);
      }
    } catch (e) { return; }
    if (!want) {
      try { if (!sessionStorage.getItem('aliAiConversationOpened')) want = await currentAiFocusName(); }
      catch (e) { /* ignore */ }
    }
    if (!want) return;
    try { sessionStorage.setItem('aliAiConversationOpened', '1'); } catch (e) { /* ignore */ }
    await uiWait(1200);
    let item = null;
    for (let i = 0; i < 8 && !item; i++) {
      item = await uiRevealConversation({ name: want });
      if (!item) await uiWait(800);
    }
    if (item) {
      uiClick(item);
      toast('已定位会话：' + want);
    } else {
      toast('没找到「' + want + '」，请在左侧搜索框手动查找', true);
    }
  }
  async function maybeRestoreChatAnalysis() {
    if (window.self !== window.top) return;
    if (!['message.alibaba.com', 'onetalk.alibaba.com'].includes(location.hostname)) return;
    try {
      const focus = await currentAiFocusName();
      const workspace = await activeAiWorkspace();
      const stateKey = aiStateKey(workspace, focus);
      const panelKey = aiPanelKey(workspace);
      const saved = await chrome.storage.local.get([panelKey, stateKey]);
      if (!focus && !saved[panelKey]) return;
      if (document.getElementById('ali-ai-box')) return;
      const url = new URL(location.href);
      const chosen = [url.searchParams.get('aliAiStart') || '', url.searchParams.get('aliAiEnd') || ''];
      const range = chosen[0] || chosen[1] ? chosen
        : ((saved[stateKey] && saved[stateKey].range) || [todayStr(-29), todayStr(0)]);
      await openChatAnalysis(range[0], range[1]);
    } catch (e) { /* 页面跳转时下次可从工作台手动打开 */ }
  }
  function mountAiSidecarHandle() {
    if (window.self !== window.top || !['message.alibaba.com', 'onetalk.alibaba.com'].includes(location.hostname)) return;
    if (document.getElementById('ali-ai-sidecar-handle')) return;
    const handle = document.createElement('button');
    handle.id = 'ali-ai-sidecar-handle';
    handle.type = 'button';
    handle.textContent = 'AI 客户助手';
    handle.setAttribute('aria-label', '打开右侧 AI 客户助手');
    handle.onclick = async () => {
      const focus = await currentAiFocusName();
      const stateKey = aiStateKey(await activeAiWorkspace(), focus);
      const saved = await chrome.storage.local.get(stateKey).catch(() => ({}));
      const range = (saved[stateKey] && saved[stateKey].range) || [todayStr(-29), todayStr(0)];
      openChatAnalysis(range[0], range[1]);
    };
    document.body.appendChild(handle);
  }
  function ensurePanel() {
    if (!document.body) return;
    mountDock(); // 默认只留侧边入口，点开才展开面板
    mountAiSidecarHandle();
    if (!window.__aliAutoRan) { window.__aliAutoRan = true; maybeAutoRun(); }
    if (!window.__aliAutoSendRan) { window.__aliAutoSendRan = true; maybeAutoSend(); }
    if (!window.__aliChatAutoRan) { window.__aliChatAutoRan = true; maybeAutoOpenChat(); }
    if (!window.__aliSmartReplyRan) { window.__aliSmartReplyRan = true; maybeSmartReply(); }
    if (!window.__aliInboxProbeRan) { window.__aliInboxProbeRan = true; maybeInboxProbe(); }
    if (!window.__aliInboxAutoTestRan) { window.__aliInboxAutoTestRan = true; maybeInboxAutoTest(); }
    if (!window.__aliAiRestoreRan) { window.__aliAiRestoreRan = true; maybeRestoreChatAnalysis(); }
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
