'use strict';

// 云端采集器拿到的询盘列表是平台原始报文；这里统一映射为扩展导出的 24 列规范字段，
// 避免原始字段直接入库后，云端看板/AI/提醒按「客户名称/国家」取不到值。
// 采集器没有客户补全能力，缺失字段留空；服务端按「非空覆盖」合并，保留扩展补全的等级/公司等。

const INQUIRY_KEYS = [
  '询盘ID', '询价次数', '创建时间', '客户名称', '负责人', '公司名称', '是否已加为客户',
  '买家等级', '金牌买家', '联系电话', '电子邮件', '注册时间', '订单总额($)', '购买总金额',
  '国家', '来源', '来源端', '回复状态', '最新回复时间', '未联系天数', '处理进度',
  '询盘主题', '产品ID', '咨询产品', '买家等级(字母)',
  '经营类型', '销售类型', '采购偏好', '搜索词', '公司网站', '活跃天数', '有效询盘数',
  '已回复询盘数', '产品浏览数', '合作供应商数', '潜力分', '成长等级', '被拉黑次数', '被标记垃圾询盘数',
];

const SOURCE_MAP = {
  main_app_detail_sendInquiry: 'APP端详情页商机',
  main_app_miniDetail_sendInquiry: 'APP mini端详情商机',
  main_en_detail: '电脑端英文详情页',
  CONTACT_MKT_IMOpportunity: '营销商机',
};
const REPLY_STATUS_MAP = { 0: '待回复', 1: '已回复' };

let regionNames = null;

function text(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

function countryCn(code, name) {
  const s = text(code).toUpperCase();
  if (s) {
    try {
      if (!regionNames) regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
      const label = regionNames.of(s);
      if (label && label !== s) return label;
    } catch (e) { /* 无 ICU 时回退到英文国名 */ }
  }
  return text(name);
}

function sourceCn(v) {
  return v ? (SOURCE_MAP[String(v)] || String(v)) : '';
}

function appFromToCn(v) {
  if (!v) return '';
  const s = String(v);
  const l = s.toLowerCase();
  if (/^ios|iphone|ipad/.test(l)) return 'iOS端';
  if (/android/.test(l)) return '安卓端';
  if (/weblite|wap/.test(l)) return '手机网页版';
  if (/web|pc|camel/.test(l)) return '电脑端';
  return s;
}

function replyStatusCn(v) {
  if (v === '' || v === undefined || v === null) return '';
  return REPLY_STATUS_MAP[String(v)] || String(v);
}

function toMs(v) {
  if (v === '' || v === undefined || v === null) return null;
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) {
    const n = Number(v);
    const ms = String(v).length === 13 ? n : n * 1000;
    return ms > 0 ? ms : null;
  }
  const t = Date.parse(String(v).replace(/\//g, '-'));
  return Number.isFinite(t) && t > 0 ? t : null;
}

// 与扩展导出口径一致：店铺本地时间（东八区），用 / 分隔
function formatCst(v) {
  const ms = toMs(v);
  if (ms === null) return '';
  const s = new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false });
  return s.replace(/-/g, '/');
}

function businessAtOf(raw) {
  const ms = toMs(raw && (raw.createTime || raw.gmtCreate));
  return ms === null ? null : new Date(ms).toISOString();
}

function platformIdOf(raw) {
  const id = text(raw && (raw.feedbackId || raw.id));
  return id ? 'inquiry:' + id : '';
}

function waitDaysOf(raw) {
  const explicit = raw && raw.waitDay;
  if (explicit !== undefined && explicit !== null && explicit !== '') return explicit;
  const last = toMs(raw && (raw.lastestReplyTime || raw.modifiedTime)) || toMs(raw && raw.createTime);
  if (last === null) return '';
  return Math.max(0, Math.floor((Date.now() - last) / 86400000));
}

function canonicalInquiry(raw) {
  const o = raw || {};
  const sender = o.sender && typeof o.sender === 'object' ? o.sender : {};
  const product = Array.isArray(o.productInfo) && o.productInfo.length ? o.productInfo[0] : {};
  const payload = {};
  INQUIRY_KEYS.forEach((k) => { payload[k] = ''; });
  payload['询盘ID'] = text(o.feedbackId || o.id);
  payload['询价次数'] = o.inquiryCount === undefined || o.inquiryCount === null ? '' : o.inquiryCount;
  payload['创建时间'] = formatCst(o.createTime || o.gmtCreate);
  payload['客户名称'] = text(sender.name) || (typeof o.sender === 'string' ? text(o.sender) : '');
  payload['负责人'] = text(o.ownerName);
  payload['国家'] = countryCn(sender.countryCode, sender.countryName);
  payload['来源'] = sourceCn(o.source);
  payload['来源端'] = appFromToCn(o.appFrom);
  payload['回复状态'] = replyStatusCn(o.replyStatus);
  payload['最新回复时间'] = formatCst(o.lastestReplyTime);
  payload['未联系天数'] = waitDaysOf(o);
  payload['处理进度'] = text(o.process || o.mark);
  payload['询盘主题'] = text(o.subject);
  payload['产品ID'] = text(product.productId || product.id);
  payload['咨询产品'] = text(product.productName);
  return payload;
}

module.exports = {
  INQUIRY_KEYS,
  countryCn,
  sourceCn,
  appFromToCn,
  replyStatusCn,
  formatCst,
  businessAtOf,
  platformIdOf,
  canonicalInquiry,
};
