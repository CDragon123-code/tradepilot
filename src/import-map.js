// 将员工从平台正常取得的表格列名映射为本机资料库字段；只处理本地文件。
(function () {
  'use strict';
  const norm = (s) => String(s === undefined || s === null ? '' : s).normalize('NFKC').toLowerCase()
    .replace(/[\s\u3000_\-\/（）()：:]/g, '');
  const aliases = {
    '客户ID': ['客户id', 'customerid', 'buyerid'],
    '询盘ID': ['询盘id', 'inquiryid', 'tradeid'],
    '公司名称': ['公司名称', '客户公司', '买家公司', 'companyname', 'buyercompany', 'company'],
    '客户名称': ['客户名称', '买家名称', 'buyername', 'customername'],
    '联系人': ['联系人', '联系姓名', 'contactname', 'contactperson'],
    '国家/地区': ['国家/地区', '国家地区', '所在国家', 'countryregion', 'country'],
    '行业': ['行业', '所属行业', 'industry'],
    '采购类目': ['采购类目', '采购品类', '采购类别', 'category', 'categories'],
    '经营类型': ['经营类型', '企业类型', 'businesstype'],
    '订单数': ['订单数', '历史订单数', '累计订单数', 'ordercount', 'orders'],
    '订单ID': ['订单id', '订单号', '订单编号', 'orderno', 'orderid', 'order number'],
    '订单状态': ['订单状态', '交易状态', 'orderstatus', 'status'],
    '成交金额': ['成交金额', '实付金额', '订单金额', '支付金额', 'amount', 'paidamount', 'orderamount'],
    '币种': ['币种', '货币', 'currency'],
    '下单时间': ['下单时间', '订单创建时间', '支付时间', 'ordertime', 'paidtime'],
    '年采购额': ['年采购额', 'annualprocurement'],
    '客户来源': ['客户来源', '客户渠道', 'customersource', 'leadsource'],
    '询盘来源': ['询盘来源', '询盘渠道', 'inquirysource'],
    '来源': ['来源', 'source'],
    '来源端': ['来源端', '设备来源', 'appfrom', 'device'],
    '创建时间': ['创建时间', '询盘时间', '询盘日期', 'createtime', 'inquirydate'],
    '询盘主题': ['询盘主题', '主题', 'subject', 'inquirysubject'],
    '购买总金额': ['购买总金额', '累计采购金额', 'totalpurchaseamount'],
    '订单总额($)': ['订单总额($)', '订单总额', 'totalordervolume'],
    '买家等级': ['买家等级', '客户等级', 'buyerlevel'],
    '邮箱': ['邮箱', '电子邮件', 'email'],
    '公司网站': ['公司网站', '官网', 'website', 'companywebsite'],
    '资料来源': ['资料来源', '数据来源', 'datasource'],
    '进入公海时间': ['进入公海时间', '进入公海日期', 'opentime'],
    '发送时间': ['发送时间', '消息时间', 'sendtime'],
    '角色': ['角色', '发言角色', 'role'],
    '访客ID': ['访客id', 'visitorid'],
  };
  const index = new Map();
  Object.entries(aliases).forEach(([canonical, names]) => names.forEach((name) => index.set(norm(name), canonical)));
  const canonical = (header) => (header || []).map((h) => index.get(norm(h)) || String(h === undefined || h === null ? '' : h).trim());
  const known = (header) => (header || []).filter((h) => index.has(norm(h))).length;
  function headerRow(aoa) {
    let best = -1, score = 0;
    (aoa || []).slice(0, 12).forEach((row, i) => {
      const n = known(row);
      if (n > score) { best = i; score = n; }
    });
    return score >= 2 ? best : -1;
  }
  function kind(header, filename) {
    const h = new Set(canonical(header));
    const publicFile = /公海|public/i.test(String(filename || '')) || h.has('进入公海时间');
    if (h.has('订单ID') && (h.has('订单状态') || h.has('成交金额'))) return 'order';
    if (h.has('询盘ID') || (h.has('询盘主题') && h.has('创建时间') && (h.has('客户名称') || h.has('公司名称')))) return 'inquiry';
    if (h.has('发送时间') && h.has('角色')) return 'chat';
    if (h.has('客户ID') || (h.has('公司名称') && (h.has('国家/地区') || h.has('行业') || h.has('采购类目'))))
      return publicFile ? 'public_customer' : 'customer';
    if (h.has('访客ID')) return 'visitor';
    return null;
  }
  const api = { canonical, headerRow, kind, fields: Object.keys(aliases) };
  if (typeof self !== 'undefined') self.AliImportMap = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
