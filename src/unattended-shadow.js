// 无人值守客服的离线影子评估。此模块只分析已入库资料，不包含发送能力。
(function () {
  'use strict';

  const SCHEMA_VERSION = 2;
  const DRAFT_PROMPT_VERSION = 'shadow-draft-v2';
  const SAMPLE_LIMIT = 100;
  const STALE_DAYS = 30;

  const STRATA = ['数据缺口', '售后/投诉', '报价/交期', '已回复', '待回复', '状态未核实'];
  const DISPOSITIONS = ['可自动确认', '需人工', '无需回复', '不应回复'];
  const QUALITIES = ['可用', '需要修改', '不适用'];
  const PLATFORM_STATUSES = ['仍待回复', '已回复', '无需回复', '已关闭', '不存在'];

  const REASON_GROUPS = [
    { name: '数据缺口', codes: ['缺少询盘ID', '缺少主题和产品', '缺少最新买家消息', '回复状态过期', '数据源未更新', '回复状态未核实'] },
    { name: '客户', codes: ['客户身份不确定', '同客户重复样本'] },
    { name: '内容', codes: ['无依据承诺', '价格/交期/认证需核实', '产品适配需人工', '售后/投诉需人工', '报价需人工', '语气不当', '语言不符'] },
    { name: '合规', codes: ['超出授权范围', '隐私/敏感信息'] },
    { name: '历史', codes: ['旧版未核对'] },
  ];
  const REASON_CODES = REASON_GROUPS.reduce((all, group) => all.concat(group.codes), []);
  const BLOCKING_REASONS = ['客户身份不确定', '无依据承诺', '超出授权范围', '回复状态过期'];

  const val = (row, key) => String(row && row[key] != null ? row[key] : '').trim();
  const normalizeStatus = (value) => String(value || '').trim();

  function parseTime(value) {
    const text = String(value || '').trim();
    if (!text) return 0;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text) ? text.replace(' ', 'T') : text;
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : 0;
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtTime(ms) {
    const d = new Date(Number(ms));
    if (!ms || Number.isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function ageDays(createdAt, now) {
    const at = parseTime(createdAt);
    if (!at) return null;
    return Math.max(0, Math.floor(((now || Date.now()) - at) / 86400000));
  }

  function customerKey(row) {
    const name = val(row, '客户名称');
    const company = val(row, '公司名称');
    const base = company || name;
    return base ? base.toLowerCase().replace(/[\s\-_.()（）]/g, '') : '';
  }

  function stratum(row) {
    const inquiryId = val(row, '询盘ID');
    const subject = val(row, '询盘主题');
    const product = val(row, '咨询产品');
    const replyStatus = normalizeStatus(val(row, '回复状态'));
    if (!inquiryId || (!subject && !product)) return '数据缺口';
    const text = (subject + ' ' + product).toLowerCase();
    if (/售后|退款|退货|投诉|质量|破损|损坏|refund|return|complain|quality|damaged|broken/i.test(text)) return '售后/投诉';
    if (/报价|价格|交期|样品|运费|quote|price|lead\s*time|sample|moq|shipping/i.test(text)) return '报价/交期';
    if (replyStatus === '已回复') return '已回复';
    if (replyStatus === '待回复') return '待回复';
    return '状态未核实';
  }

  function assess(row, inquiryHealth, chatHealth, options) {
    const now = (options && options.now) || Date.now();
    const inquiryId = val(row, '询盘ID');
    const subject = val(row, '询盘主题');
    const product = val(row, '咨询产品');
    const replyStatus = normalizeStatus(val(row, '回复状态'));
    const createdAt = val(row, '创建时间');
    const lastReplyAt = val(row, '最新回复时间');
    const createdDays = ageDays(createdAt, now);
    const statusAt = parseTime(lastReplyAt) > parseTime(createdAt) ? lastReplyAt : createdAt;
    const statusDays = ageDays(statusAt, now);
    const stale = statusDays != null && statusDays > STALE_DAYS;
    const health = { inquiry: inquiryHealth || '未知', chat: chatHealth || '未知' };
    const reasons = [];
    const reasonCodes = [];
    if (!inquiryId) { reasons.push('缺少询盘 ID'); reasonCodes.push('缺少询盘ID'); }
    if (!subject && !product) { reasons.push('缺少询盘主题和咨询产品'); reasonCodes.push('缺少主题和产品'); }
    if (replyStatus !== '待回复') {
      reasons.push(replyStatus === '已回复' ? '历史记录显示已回复' : '回复状态未核实');
      reasonCodes.push('回复状态未核实');
    }
    if (health.inquiry !== '已更新') { reasons.push('询盘数据源：' + health.inquiry); reasonCodes.push('数据源未更新'); }
    if (health.chat !== '已更新') { reasons.push('聊天数据源：' + health.chat); reasonCodes.push('数据源未更新'); }
    if (stale) { reasons.push('样本状态距今 ' + statusDays + ' 天，历史回复状态可能已变化'); reasonCodes.push('回复状态过期'); }
    reasons.push('导出记录缺少最新买家消息 ID 与完整正文');
    reasonCodes.push('缺少最新买家消息');

    const canDraft = !!inquiryId && !!(subject || product) && replyStatus === '待回复';
    const lowConfidence = !canDraft || health.inquiry !== '已更新' || health.chat !== '已更新' || stale;
    return {
      inquiryId,
      customer: val(row, '客户名称'),
      company: val(row, '公司名称'),
      customerKey: customerKey(row),
      subject,
      product,
      replyStatus,
      createdAt,
      lastReplyAt,
      ageDays: createdDays,
      statusAgeDays: statusDays,
      stale,
      stratum: stratum(row),
      health,
      confidence: lowConfidence ? '低' : '中',
      canDraft,
      sendEligible: false,
      reasons,
      reasonCodes: Array.from(new Set(reasonCodes)),
    };
  }

  function sampleRows(rows, inquiryHealth, chatHealth, options) {
    const limit = Math.max(1, Number(options && options.limit) || SAMPLE_LIMIT);
    const now = (options && options.now) || Date.now();
    const items = (rows || []).map((row) => ({ row, check: assess(row, inquiryHealth, chatHealth, { now }) }))
      .sort((a, b) => (parseTime(b.check.createdAt) || 0) - (parseTime(a.check.createdAt) || 0));
    const groups = {};
    STRATA.forEach((name) => { groups[name] = []; });
    items.forEach((item) => { groups[item.check.stratum].push(item); });
    const available = {};
    STRATA.forEach((name) => { available[name] = groups[name].length; });

    const selected = [];
    let added = true;
    while (selected.length < limit && added) {
      added = false;
      STRATA.forEach((name) => {
        if (selected.length >= limit) return;
        const next = groups[name].shift();
        if (next) { selected.push(next); added = true; }
      });
    }

    const customerCounts = {};
    selected.forEach((item) => {
      const key = item.check.customerKey;
      if (key) customerCounts[key] = (customerCounts[key] || 0) + 1;
    });
    selected.forEach((item) => {
      const key = item.check.customerKey;
      if (!key || customerCounts[key] < 2) return;
      item.check.duplicate = true;
      if (!item.check.reasonCodes.includes('同客户重复样本')) item.check.reasonCodes.push('同客户重复样本');
      if (!item.check.reasons.some((reason) => reason.includes('同客户')))
        item.check.reasons.push('同客户在本次抽样中出现 ' + customerCounts[key] + ' 条，注意不要重复建议');
    });

    selected.sort((a, b) => STRATA.indexOf(a.check.stratum) - STRATA.indexOf(b.check.stratum)
      || (parseTime(b.check.createdAt) || 0) - (parseTime(a.check.createdAt) || 0));
    const strata = STRATA.map((name) => ({
      name,
      available: available[name],
      selected: selected.filter((item) => item.check.stratum === name).length,
    }));
    return { samples: selected, strata, total: items.length };
  }

  function draftMessages(row) {
    const subject = val(row, '询盘主题');
    const product = val(row, '咨询产品');
    if (!subject && !product) throw new Error('缺少主题和产品，无法生成有依据的草稿');
    return [
      { role: 'system', content: '你是外贸员工的英文询盘回复草稿助手。只写给员工审核的草稿，绝不声称消息已发送。仅依据提供的主题与产品名称，不能假设掌握询盘正文、客户需求或公司产品参数。不要承诺价格、交期、库存、认证、付款方式或适配性。用礼貌简短的英文确认收到询盘，并提出一个有助于明确需求的问题。不要编造事实或客户姓名。只输出回复正文。' },
      { role: 'user', content: JSON.stringify({ 询盘主题: subject.slice(0, 300), 咨询产品: product.slice(0, 300), 信息缺口: '无询盘正文与最新平台消息；仅供员工审核' }) },
    ];
  }

  function emptyRecord(check) {
    const source = check || {};
    const health = source.health || {};
    return {
      schema: SCHEMA_VERSION,
      workspace: '',
      inquiryId: source.inquiryId || '',
      customer: source.customer || '',
      company: source.company || '',
      customerKey: source.customerKey || '',
      stratum: source.stratum || '',
      createdAt: source.createdAt || '',
      lastReplyAt: source.lastReplyAt || '',
      replyStatus: source.replyStatus || '',
      ageDays: source.ageDays == null ? '' : source.ageDays,
      statusAgeDays: source.statusAgeDays == null ? '' : source.statusAgeDays,
      confidence: source.confidence || '',
      check: {
        inquiryHealth: health.inquiry || '未知',
        chatHealth: health.chat || '未知',
        canDraft: !!source.canDraft,
        reasons: (source.reasons || []).slice(),
        reasonCodes: (source.reasonCodes || []).slice(),
      },
      draft: {
        text: '',
        model: '',
        promptVersion: DRAFT_PROMPT_VERSION,
        generatedAt: 0,
        latencyMs: 0,
        attempts: 0,
        error: '',
      },
      platform: {
        status: '',
        latestBuyerMessageAt: '',
        latestMessageId: '',
        checkedAt: 0,
        checkedBy: '',
      },
      review: {
        disposition: '',
        quality: '',
        reasons: [],
        note: '',
        reviewedAt: 0,
      },
    };
  }

  function validateReview(record) {
    const errors = [];
    const source = record || {};
    const draft = source.draft || {};
    const platform = source.platform || {};
    const review = source.review || {};
    const check = source.check || {};
    if (!source.inquiryId) errors.push('缺少询盘ID');
    if (!platform.status) errors.push('请填写平台核对状态');
    if (!String(platform.checkedBy || '').trim()) errors.push('请填写核对人');
    if (!review.disposition) errors.push('请选择处置结论');
    if (!review.quality) errors.push('请选择草稿质量');
    if (review.quality === '需要修改' && !(review.reasons || []).length)
      errors.push('标记“需要修改”时至少选择一个原因码');
    if (['需人工', '不应回复'].includes(review.disposition) && !(review.reasons || []).length)
      errors.push('标记“' + review.disposition + '”时至少选择一个原因码');

    if (review.disposition === '可自动确认') {
      if (platform.status !== '仍待回复') errors.push('平台状态不是“仍待回复”，不能标记可自动确认');
      const latest = parseTime(platform.latestBuyerMessageAt);
      if (!latest) errors.push('可自动确认需要填写平台最新买家消息时间');
      const checkedAt = Number(platform.checkedAt) || Date.now();
      if (latest && latest > checkedAt + 5 * 60 * 1000) errors.push('最新买家消息时间晚于核对时间，请重新核对');
      if (latest && checkedAt - latest > STALE_DAYS * 86400000) errors.push('最新买家消息超过 30 天，不能作为首响自动确认样本');
      if (!String(platform.latestMessageId || '').trim()) errors.push('可自动确认需要填写平台最新消息ID');
      if (!String(draft.text || '').trim()) errors.push('可自动确认需要先生成草稿');
      if (draft.error) errors.push('草稿生成失败，不能标记可自动确认');
      if (review.quality !== '可用') errors.push('可自动确认要求草稿质量标记为“可用”');
      if (!check.canDraft) errors.push('该样本本身不具备草稿条件，不能标记可自动确认');
      if (check.inquiryHealth !== '已更新' || check.chatHealth !== '已更新')
        errors.push('数据源未更新，不能标记可自动确认');
      if (['数据缺口', '已回复', '状态未核实', '售后/投诉', '报价/交期'].includes(source.stratum))
        errors.push('该样本分层首期应转人工，不能标记可自动确认');
      const blocking = (review.reasons || []).filter((reason) => BLOCKING_REASONS.includes(reason));
      if (blocking.length) errors.push('存在阻断原因：' + blocking.join('、'));
    }
    return { ok: errors.length === 0, errors };
  }

  function migrateLegacy(legacy, check, workspace) {
    const verdict = String(legacy && legacy.verdict || '');
    const map = {
      草稿可用: { disposition: '需人工', quality: '可用' },
      需要修改: { disposition: '需人工', quality: '需要修改' },
      不应回复: { disposition: '不应回复', quality: '不适用' },
    };
    if (!map[verdict]) return null;
    const record = emptyRecord(check);
    record.workspace = workspace || '';
    record.legacy = true;
    record.review = {
      disposition: map[verdict].disposition,
      quality: map[verdict].quality,
      reasons: ['旧版未核对'],
      note: '旧版标记：' + verdict + '；未记录平台核对与草稿正文',
      reviewedAt: Number(legacy.at) || 0,
    };
    return record;
  }

  function summary(samples, records) {
    const map = records || {};
    const values = (samples || []).map((item) => map[item.check.inquiryId]).filter(Boolean);
    const dispositions = {};
    DISPOSITIONS.forEach((name) => { dispositions[name] = 0; });
    const qualities = {};
    QUALITIES.forEach((name) => { qualities[name] = 0; });
    const reasons = {};
    REASON_CODES.forEach((code) => { reasons[code] = 0; });
    let reviewed = 0;
    let platformChecked = 0;
    let drafts = 0;
    let draftFailed = 0;
    values.forEach((record) => {
      const review = record.review || {};
      const platform = record.platform || {};
      const draft = record.draft || {};
      if (review.disposition) { reviewed += 1; dispositions[review.disposition] = (dispositions[review.disposition] || 0) + 1; }
      if (review.quality) qualities[review.quality] = (qualities[review.quality] || 0) + 1;
      if (platform.status && platform.checkedBy) platformChecked += 1;
      if (draft.text) drafts += 1;
      if (draft.error) draftFailed += 1;
      (review.reasons || []).forEach((code) => { reasons[code] = (reasons[code] || 0) + 1; });
    });
    const autoByCustomer = {};
    values.forEach((record) => {
      if (record.review && record.review.disposition === '可自动确认' && record.customerKey)
        autoByCustomer[record.customerKey] = (autoByCustomer[record.customerKey] || 0) + 1;
    });
    const blocking = {
      wrongCustomer: reasons['客户身份不确定'] || 0,
      unsupported: reasons['无依据承诺'] || 0,
      staleReply: reasons['回复状态过期'] || 0,
      duplicateAutoConfirm: Object.values(autoByCustomer).filter((count) => count > 1).length,
      compliance: reasons['超出授权范围'] || 0,
    };
    return {
      reviewed, platformChecked, drafts, draftFailed,
      dispositions, qualities, reasons, blocking,
      blockingTotal: blocking.wrongCustomer + blocking.unsupported + blocking.staleReply
        + blocking.duplicateAutoConfirm + blocking.compliance,
    };
  }

  const csvCell = (value) => '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
  function csv(records) {
    const header = ['序号', '工作区', '询盘ID', '客户', '公司', '客户键', '分层', '创建时间', '历史回复状态',
      '数据置信', '系统识别缺口', '询盘源', '聊天源', '平台核对状态', '最新买家消息时间', '最新消息ID', '核对人', '核对时间',
      '处置结论', '草稿质量', '原因码', '备注', '草稿正文', '模型', '提示词版本', '生成状态',
      '生成时间', '生成耗时ms', '生成失败原因', '生成次数', '评估时间', '校验结果'];
    const lines = [header.map(csvCell).join(',')];
    (records || []).forEach((record, index) => {
      const source = record || {};
      const draft = source.draft || {};
      const platform = source.platform || {};
      const review = source.review || {};
      const check = source.check || {};
      const validation = validateReview(source);
      const validated = !review.disposition ? '未评估' : (validation.ok ? '通过' : validation.errors.join('；'));
      const draftStatus = draft.text ? '已生成' : draft.error ? '失败' : draft.attempts ? '未完成' : '未生成';
      lines.push([
        index + 1, source.workspace || '', source.inquiryId || '', source.customer || '', source.company || '',
        source.customerKey || '', source.stratum || '', source.createdAt || '', source.replyStatus || '',
        source.confidence || '', (check.reasonCodes || []).join('；'), check.inquiryHealth || '',
        check.chatHealth || '', platform.status || '未核对',
        platform.latestBuyerMessageAt || '', platform.latestMessageId || '', platform.checkedBy || '',
        fmtTime(platform.checkedAt), review.disposition || '未评估', review.quality || '',
        (review.reasons || []).join('；'), review.note || '', draft.text || '', draft.model || '',
        draft.promptVersion || DRAFT_PROMPT_VERSION, draftStatus, fmtTime(draft.generatedAt),
        draft.latencyMs || '', draft.error || '', draft.attempts || 0, fmtTime(review.reviewedAt), validated,
      ].map(csvCell).join(','));
    });
    return lines.join('\r\n');
  }

  const api = {
    SCHEMA_VERSION, DRAFT_PROMPT_VERSION, SAMPLE_LIMIT, STALE_DAYS,
    STRATA, DISPOSITIONS, QUALITIES, PLATFORM_STATUSES, REASON_GROUPS, REASON_CODES,
    parseTime, fmtTime, ageDays, customerKey, stratum,
    assess, sampleRows, draftMessages, emptyRecord, validateReview, migrateLegacy, summary, csv,
  };
  if (typeof self !== 'undefined') self.AliUnattendedShadow = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
