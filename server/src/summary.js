'use strict';

// 工作台摘要：逐源健康 + 数据缺口 + 最近批次
// 所有计算只读当前态，不改数据；缺口阈值是运营口径，可后续调整
const HOUR = 3600000;
const EXPECTED_KINDS = ['inquiry', 'customer', 'chat', 'order'];

function ratio(n, d) {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

function composeSummary(input) {
  const now = input.now || Date.now();
  const sources = (input.sources || []).map((s) => {
    const t = s.last_success_at ? Date.parse(s.last_success_at) : 0;
    const ageHours = t ? (now - t) / HOUR : null;
    let status = 'ok';
    if (!s.rows) status = 'empty';
    else if (ageHours !== null && ageHours > 24) status = 'stale';
    return {
      kind: s.kind,
      rows: s.rows || 0,
      batches: s.batches || 0,
      last_success_at: s.last_success_at || null,
      last_business_at: s.last_business_at || null,
      age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      status: status,
    };
  });

  const rowsTotal = sources.reduce((sum, s) => sum + s.rows, 0);
  const lastSuccess = sources.map((s) => s.last_success_at).filter(Boolean).sort().pop() || null;
  const gaps = [];

  const iq = input.inquiry || { total: 0 };
  if (iq.total) {
    const noNameRatio = ratio(iq.noName, iq.total);
    if (noNameRatio >= 20) {
      gaps.push({
        id: 'inquiry_no_name', level: 'P0', title: '询盘缺少客户名称',
        count: iq.noName, total: iq.total, ratio: noNameRatio,
        detail: '这些询盘无法识别客户身份、无法关联客户库补买家等级，也匹配不到聊天与成交。',
        action: '先做一次完整补全同步；长期需在平台侧补齐客户资料',
      });
    }
    const noGradeRatio = ratio(iq.noGrade, iq.total);
    if (noGradeRatio >= 50) {
      gaps.push({
        id: 'inquiry_no_grade', level: 'P1', title: '买家等级缺失',
        count: iq.noGrade, total: iq.total, ratio: noGradeRatio,
        detail: '缺少买家等级会让「高价值询盘占比」被低估，投放人群判断失真。',
        action: '补全客户信息后重算；未补全前不要据此削减预算',
      });
    }
    if (iq.adTotal && ratio(iq.noName, iq.adTotal) >= 30) {
      gaps.push({
        id: 'ad_inquiry_no_name', level: 'P0', title: '广告商机买家资料缺口',
        count: iq.adTotal - (iq.adNamed || 0), total: iq.adTotal, ratio: ratio(iq.adTotal - (iq.adNamed || 0), iq.adTotal),
        detail: '广告带来的商机里超过三成没有买家资料，等于买到了流量却无法跟进。',
        action: '把补全客户资料列入每日任务，按缺口清单逐条处理',
      });
    }
  }

  const od = input.order || { total: 0 };
  if (od.total && ratio(od.noInquiryId, od.total) >= 50) {
    gaps.push({
      id: 'order_no_inquiry_id', level: 'P1', title: '订单缺少询盘 ID',
      count: od.noInquiryId, total: od.total, ratio: ratio(od.noInquiryId, od.total),
      detail: '没有询盘 ID 时，广告成交只能按客户身份估算，ROI 与 LTV 会失真。',
      action: '核对订单导出字段；在平台能关联询盘后重新同步',
    });
  }

  sources.filter((s) => s.status === 'stale').forEach((s) => {
    gaps.push({
      id: 'stale_' + s.kind, level: 'P1', title: '数据源超过 24 小时未更新',
      count: Math.round(s.age_hours || 0), total: 24, ratio: 100,
      detail: '最新一次成功同步在 ' + (s.last_success_at || '未知') + '，之后的业务变化没有进云端。',
      action: '检查采集器/浏览器是否在运行，登录态是否失效',
    });
  });

  EXPECTED_KINDS.forEach((kind) => {
    if (!sources.some((s) => s.kind === kind && s.rows > 0)) {
      gaps.push({
        id: 'empty_' + kind, level: 'P2', title: '尚未同步：' + kind,
        count: 0, total: 0, ratio: 0,
        detail: '该数据源在云端没有任何记录，相关分析会缺失。',
        action: '在扩展设置页点「上传现有资料库」，或等待下一次采集',
      });
    }
  });

  const order = { P0: 0, P1: 1, P2: 2 };
  gaps.sort((a, b) => (order[a.level] - order[b.level]) || (b.ratio - a.ratio));

  return {
    seller_id: input.sellerId,
    generated_at: new Date(now).toISOString(),
    totals: {
      kinds: sources.length,
      rows: rowsTotal,
      last_success_at: lastSuccess,
      gap_count: gaps.length,
    },
    sources: sources,
    gaps: gaps,
    recent: input.recent || [],
  };
}

module.exports = { composeSummary, ratio, EXPECTED_KINDS };
