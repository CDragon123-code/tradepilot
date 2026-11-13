// 本地客户主页：只汇总已入库的客户、询盘与订单，不触发平台请求。
(function () {
  'use strict';
  const CORE = typeof self !== 'undefined' && self.AliDataCore ? self.AliDataCore : require('./data-core');
  const blank = (v) => v === undefined || v === null || !String(v).trim() || /^(?:-|n\/?a|unknown|未填写|暂无)$/i.test(String(v).trim());
  const value = (row, keys) => {
    for (const key of keys) if (row && !blank(row[key])) return String(row[key]).trim();
    return '';
  };
  const companyValue = (row) => {
    const name = value(row, ['公司名称']);
    return /^(?:no\s*company(?:\s*name)?|n\/?a|pas d['’]?entreprise)(?:_\d+)?$/i.test(name) ? '' : name;
  };
  const number = (v) => {
    if (blank(v)) return null;
    const n = Number(String(v).replace(/[,\s$]/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const fact = (v, source, note) => v === '' || v === null || v === undefined
    ? { 值: null, 来源: '', 说明: '暂无可核实数据' }
    : { 值: v, 来源: source, ...(note ? { 说明: note } : {}) };
  const first = (rows, keys, source) => {
    for (const row of rows) {
      for (const key of keys) if (!blank(row && row[key])) return fact(String(row[key]).trim(), source(row, key));
    }
    return fact(null);
  };
  const distinct = (arr) => Array.from(new Set(arr.filter(Boolean)));
  const sourceOf = (row, field) => {
    const item = row && ((row.__fields && row.__fields[field]) || (row['字段来源'] && row['字段来源'][field]));
    return item && item.来源 || value(row, ['资料来源']) || (row && row['来源库'] === '公海' ? '公海客户' : '我的客户');
  };

  function build(customerRows, inquiryRows, orderRows) {
    const mine = (customerRows || []).filter((r) => r['来源库'] !== '公海');
    const crm = mine.concat((customerRows || []).filter((r) => r['来源库'] === '公海'));
    const inv = (inquiryRows || []).slice().sort((a, b) =>
      String(b['创建时间'] || '').localeCompare(String(a['创建时间'] || '')));
    const orders = (orderRows || []).slice().sort((a, b) => String(b['下单时间'] || '').localeCompare(String(a['下单时间'] || '')));
    const confirmedOrders = orders.filter(CORE.wonOrder);
    const company = fact(null);
    for (const row of crm) if (companyValue(row)) { Object.assign(company, fact(companyValue(row), sourceOf(row, '公司名称'))); break; }
    if (company.值 === null) for (const row of inv) if (companyValue(row)) { Object.assign(company, fact(companyValue(row), '询盘')); break; }
    const country = first(crm, ['国家/地区', '国家'], sourceOf);
    if (country.值 === null) Object.assign(country, first(inv, ['国家'], () => '询盘'));
    const statedIndustry = first(crm, ['行业'], sourceOf);
    const category = first(crm, ['采购类目'], sourceOf);
    const preference = first(inv, ['采购偏好'], () => '询盘买家资料');
    const business = first(crm, ['经营类型'], sourceOf);
    if (business.值 === null) Object.assign(business, first(inv, ['经营类型'], () => '询盘买家资料'));
    const industry = statedIndustry.值 !== null ? fact(statedIndustry.值, statedIndustry.来源, '平台资料所列行业，需人工核实')
      : category.值 !== null ? fact(category.值, category.来源, '采购类目仅作行业线索，需人工核实')
      : preference.值 !== null ? fact(preference.值, preference.来源, '采购偏好仅作行业线索，需人工核实')
        : business.值 !== null ? fact(business.值, business.来源, '经营类型仅作行业线索，需人工核实') : fact(null);
    const crmSource = first(crm, ['客户来源'], sourceOf);
    const verifiedInquirySource = first(crm, ['询盘来源'], sourceOf);
    const inquirySources = distinct(inv.map((r) => value(r, ['来源'])));
    const inquiryEnds = distinct(inv.map((r) => value(r, ['来源端'])));
    const source = inquirySources.length ? fact(inquirySources, '询盘')
      : verifiedInquirySource.值 !== null ? fact([verifiedInquirySource.值], verifiedInquirySource.来源, '员工补录，需核实原始询盘') : fact(null);
    const orderCounts = crm.map((r) => number(r['订单数'])).filter((n) => n !== null);
    const orderCount = orderCounts.length ? fact(Math.max(...orderCounts), sourceOf(crm.find((r) => number(r['订单数']) === Math.max(...orderCounts)), '订单数')) : fact(null);
    const confirmedCount = orders.length ? fact(confirmedOrders.length, '已导入订单') : fact(null);
    const amounts = new Map();
    confirmedOrders.forEach((r) => {
      const n = CORE.amount(r['成交金额']);
      if (n === null) return;
      const currency = value(r, ['币种']) || '未标注币种';
      amounts.set(currency, (amounts.get(currency) || 0) + n);
    });
    const confirmedAmount = amounts.size ? fact(Array.from(amounts, ([currency, n]) => `${currency} ${Math.round(n * 100) / 100}`).join('、'), '已导入订单') : fact(null);
    // 询盘内金额多为累计快照，取最大已知值，不能把多条询盘金额相加。
    const maxAmount = (rows, key, src) => {
      const vals = rows.map((r) => number(r[key])).filter((n) => n !== null && n > 0);
      return vals.length ? fact(Math.max(...vals), src, '累计字段取最大已知值，不按询盘求和') : fact(null);
    };
    const purchase = maxAmount(inv, '购买总金额', '询盘买家资料');
    const buyerTotal = maxAmount(inv, '订单总额($)', '询盘买家资料');
    if (buyerTotal.值 !== null) buyerTotal.说明 += '；可能为买家平台总量，不代表本店成交';
    const website = first(crm, ['公司网站'], sourceOf);
    if (website.值 === null) Object.assign(website, first(inv, ['公司网站'], () => '询盘买家资料'));
    const buyerTier = first(crm, ['买家等级'], sourceOf);
    const golden = crm.some((r) => value(r, ['金牌买家']) === '是' || value(r, ['星标客户']) === '是');
    const evidence = [];
    let tier = '待核实';
    if (confirmedOrders.length) {
      tier = '已确认成交';
      evidence.push(`已确认订单 ${confirmedOrders.length} 笔`);
    } else if (orderCount.值 > 0 || purchase.值 > 0) {
      tier = '已有成交信号';
      evidence.push(orderCount.值 > 0 ? `客户库订单数 ${orderCount.值}` : `购买总金额 ${purchase.值}`);
    } else if (/^L[34]$/i.test(String(buyerTier.值 || '')) || golden) {
      tier = '高潜力线索';
      evidence.push(buyerTier.值 ? `买家等级 ${buyerTier.值}` : '金牌或星标客户');
    }
    const gaps = [];
    if (company.值 === null) gaps.push('公司');
    if (country.值 === null) gaps.push('国家');
    if (industry.值 === null) gaps.push('行业线索');
    if (orderCount.值 === null && purchase.值 === null && !orders.length) gaps.push('历史订单');
    if (!orders.length) gaps.push('已确认订单结果');
    if (source.值 === null) gaps.push('询盘来源');
    return {
      公司: company, 国家: country, 行业线索: industry, 经营类型: business,
      历史订单: { 订单数: orderCount, 已确认订单数: confirmedCount, 已确认成交金额: confirmedAmount, 购买总金额: purchase, 买家订单总额美元: buyerTotal,
        最近订单: orders.slice(0, 5).map((r) => ({ 订单ID: r['订单ID'], 状态: r['订单状态'], 金额: r['成交金额'], 币种: r['币种'], 时间: r['下单时间'] })) },
      询盘来源: source, 来源端: inquiryEnds.length ? fact(inquiryEnds, '询盘') : fact(null),
      公司网站: website, 客户来源: crmSource, 询盘数: inv.length,
      价值分层: { 层级: tier, 依据: evidence, 说明: '基于已入库数据的跟进优先级；缺失数据不等于低价值，成交信号需核对订单。' },
      缺失字段: gaps,
    };
  }

  const api = { build };
  if (typeof self !== 'undefined') self.AliCustomerProfile = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
