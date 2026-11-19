'use strict';

// 守门规则：对 AI 草稿做发布前检查，命中即转人工
// 目标不是判对错，而是把"可能造成承诺风险"的内容拦在人工确认前
const RULES = [
  { code: 'price', label: '价格 / 报价', level: 'block', re: /(price|pricing|discount|quotation|quote|best offer)|价格|报价|折扣|优惠|\$\s?\d/i },
  { code: 'lead_time', label: '交期 / 发货', level: 'block', re: /(lead\s*time|delivery\s*time|ship(ping)?\s*(in|within)|arrive\s*in)|交期|发货时间|几天到/i },
  { code: 'payment', label: '付款条件', level: 'block', re: /(payment\s*term|deposit|t\/t|l\/c|paypal|wire\s*transfer)|付款方式|定金|预付/i },
  { code: 'cert', label: '认证 / 资质', level: 'block', re: /(certif\w*|\bCE\b|\bFDA\b|\bISO\b|compliance)|认证|资质|合规/i },
  { code: 'commitment', label: '保证 / 承诺', level: 'warn', re: /(guarantee|we promise|assure you|warranty)|保证|承诺|包退|包换/i },
  { code: 'offsite', label: '站外联系方式', level: 'block', re: /(whatsapp|wechat|telegram|skype)|微信|加我|\b[\w.+-]+@[\w-]+\.[\w.]+\b/i },
  { code: 'exclusive', label: '独家 / 代理', level: 'block', re: /(exclusive|sole\s+agent|distributor\s+rights)|独家|代理权/i },
];

function snippet(text, index, length) {
  const start = Math.max(0, index - 24);
  return String(text).slice(start, Math.min(String(text).length, index + (length || 40))).trim();
}

function inspect(text) {
  const value = String(text || '');
  const risks = [];
  RULES.forEach((rule) => {
    const m = rule.re.exec(value);
    if (!m) return;
    risks.push({ code: rule.code, label: rule.label, level: rule.level, excerpt: snippet(value, m.index, m[0].length) });
  });
  const level = risks.some((r) => r.level === 'block') ? 'block' : (risks.length ? 'warn' : 'ok');
  return { level: level, risks: risks };
}

module.exports = { inspect, RULES };
