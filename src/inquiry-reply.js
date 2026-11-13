// 智能客服第一阶段：询盘接待队列、回复草稿与发送前校验。
// 只处理已有询盘，所有发送必须由员工确认；本模块自身不发送任何消息。
(function () {
  'use strict';

  const STALE_HOURS = 48;
  const DAILY_LIMIT = 30;
  const COOLDOWN_MS = 10 * 60 * 1000;
  const MAX_TRANSCRIPT = 20;
  const DRAFT_CONTEXT_MESSAGES = 10;
  const DRAFT_PROMPT_VERSION = 'inbox-reply-v1';
  const SENT_STATUSES = ['send_pending', 'sent_page', 'confirmed', 'uncertain'];

  const val = (row, key) => String(row && row[key] != null ? row[key] : '').trim();

  function parseTime(value) {
    const text = String(value || '').trim();
    if (!text) return 0;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text) ? text.replace(' ', 'T') : text;
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : 0;
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function dayKey(ms) {
    const d = new Date(Number(ms) || Date.now());
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function fmtTime(ms) {
    const d = new Date(Number(ms));
    if (!ms || Number.isNaN(d.getTime())) return '';
    return dayKey(ms) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  const normText = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  function hashText(value) {
    let h = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  // 会话名常带公司后缀，如 "John Smith (Acme Co)"；统一去掉括号内容再做匹配。
  function normalizeName(value) {
    return String(value || '')
      .replace(/[（(][^）)]*[）)]/g, ' ')
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[.,，。()（）"'&·\-_/\\]/g, '');
  }

  const isMine = (row) => String(row && row['角色'] || '').indexOf('业务员') >= 0;

  // 需求分类（示例）：先判非主营成品，再判主营材料。
  const FINISHED_RE = /(finished\s+goods|ready[-\s]?made|end\s+products?|complete\s+(?:units?|sets?)|turnkey|成品|整机|现货|代工)/i;
  const FINISHED_STRICT_RE = /(finished\s+goods|ready[-\s]?made|end\s+products?|成品|整机)/i;
  const MATERIAL_RE = /(raw\s+materials?|consumables?|materials?|sheets?|原料|材料|耗材)/i;

  function classifyDemand(value) {
    const text = String(value || '');
    if (!text) return { type: 'other', label: '普通询盘' };
    if (FINISHED_STRICT_RE.test(text)) return { type: 'mismatch_finished', label: '成品需求（不匹配）' };
    if (MATERIAL_RE.test(text)) return { type: 'target_material', label: '材料需求（目标）' };
    if (FINISHED_RE.test(text)) return { type: 'mismatch_finished', label: '成品需求（不匹配）' };
    return { type: 'other', label: '普通询盘' };
  }

  const RISK_RULES = [
    ['价格/报价', /\b(?:price|pricing|quote|quotation|cost|discount)\b|价格|报价|多少钱|precio|cu[aá]nto|цена|سعر/i],
    ['交期/运费', /\b(?:lead\s*time|delivery|shipping|freight)\b|交期|运费|货期|plazo|env[ií]o|lieferzeit|доставка/i],
    ['样品', /\b(?:sample|samples)\b|样品|muestra|échantillon|образец|عينة/i],
    ['认证', /\b(?:certificate|certification|certified|iso\s?\d{4,5}|fda|rohs|reach)\b|认证|сертификат|شهادة/i],
    ['售后/投诉', /\b(?:refund|return|complaint|damaged|broken|defect|quality issue)\b|售后|退款|退货|投诉|质量|reclamaci[oó]n|reklamation/i],
    ['付款', /\b(?:payment|paypal|t\/t|western union|l\/c|deposit)\b|付款|支付|pago|оплата/i],
    ['OEM/贴牌', /\b(?:oem|odm|private label)\b|贴牌|代工/i],
    ['库存', /\b(?:in stock|out of stock|inventory|stock available)\b|库存|现货/i],
  ];

  function risksOf(value) {
    const text = String(value || '');
    return RISK_RULES.filter(([, re]) => re.test(text)).map(([label]) => label);
  }

  function buildSessions(chats) {
    const map = new Map();
    (chats || []).forEach((row) => {
      const raw = val(row, '会话');
      const key = normalizeName(raw);
      if (!key) return;
      if (!map.has(key)) map.set(key, { name: raw, rows: [] });
      map.get(key).rows.push(row);
    });
    map.forEach((session) => {
      session.rows.sort((a, b) => parseTime(a['发送时间']) - parseTime(b['发送时间']));
    });
    return map;
  }

  function findSession(inquiry, sessions, sessionNamesOf) {
    let names = [];
    if (sessionNamesOf) {
      try { names = sessionNamesOf(inquiry) || []; } catch (e) { names = []; }
    }
    names = names.concat([val(inquiry, '客户名称'), val(inquiry, '公司名称')]);
    const keys = Array.from(new Set(names.map(normalizeName).filter(Boolean)));
    for (const key of keys) if (sessions.has(key)) return sessions.get(key);
    for (const key of keys) {
      if (key.length < 4) continue;
      const hits = [];
      sessions.forEach((session, sessionKey) => {
        if (sessionKey.indexOf(key) >= 0 || key.indexOf(sessionKey) >= 0) hits.push(session);
      });
      if (hits.length === 1) return hits[0];
    }
    return null;
  }

  function priorityOf(status, ageHours, level, createdTs, now, riskCount) {
    let score = 0;
    if (status === 'buyer_replied') score += 60;
    else if (status === 'new') score += 40;
    if (ageHours != null) {
      if (ageHours <= 1) score += 25;
      else if (ageHours <= 6) score += 18;
      else if (ageHours <= 24) score += 10;
      else if (ageHours <= 72) score += 4;
    }
    if (level === 'L3' || level === 'L4') score += 10;
    if (createdTs && now - createdTs <= 86400000) score += 8;
    score += riskCount * 2;
    const hot = ageHours != null && ageHours <= 24;
    if (status === 'buyer_replied' && ageHours != null && ageHours <= 6) return { level: 'P0', score };
    if ((status === 'new' || status === 'buyer_replied') && (level === 'L3' || level === 'L4' || hot))
      return { level: 'P0', score };
    if (status === 'new' || status === 'buyer_replied') return { level: 'P1', score };
    return { level: 'P2', score };
  }

  function buildQueue(inquiries, chats, options) {
    const opts = options || {};
    const now = Number(opts.now) || Date.now();
    const closedIds = opts.closedIds || new Set();
    const staleHours = Number(opts.staleHours) || STALE_HOURS;
    const sessions = buildSessions(chats);
    const items = [];

    (inquiries || []).forEach((row) => {
      const inquiryId = val(row, '询盘ID');
      if (!inquiryId) return;
      const createdAt = val(row, '创建时间');
      const createdTs = parseTime(createdAt);
      const replyStatus = val(row, '回复状态');
      const session = findSession(row, sessions, opts.sessionNamesOf);
      const rows = session ? session.rows : [];
      const transcript = rows.slice(-MAX_TRANSCRIPT).map((message) => ({
        at: val(message, '发送时间'),
        ts: parseTime(message['发送时间']),
        mine: isMine(message),
        who: val(message, '发言人'),
        text: val(message, '内容'),
      }));
      let lastBuyer = null;
      let lastMine = null;
      let firstMine = null;
      rows.forEach((message) => {
        const ts = parseTime(message['发送时间']);
        if (!ts) return;
        if (isMine(message)) {
          lastMine = { at: val(message, '发送时间'), ts, text: val(message, '内容') };
          if (!firstMine && (!createdTs || ts >= createdTs)) firstMine = { ts };
        } else {
          lastBuyer = { at: val(message, '发送时间'), ts, text: val(message, '内容') };
        }
      });

      const lastBuyerTs = lastBuyer ? lastBuyer.ts : 0;
      const lastMineTs = lastMine ? lastMine.ts : 0;
      let status;
      if (lastBuyerTs && lastBuyerTs > lastMineTs) status = 'buyer_replied';
      else if (lastMineTs) status = 'waiting';
      else if (rows.length) status = 'waiting';
      else if (replyStatus === '已回复') status = 'replied';
      else status = 'new';

      const needsReply = !closedIds.has(inquiryId) && (status === 'new' || status === 'buyer_replied');
      const latestAt = lastBuyerTs || parseTime(val(row, '最新回复时间')) || createdTs;
      const ageHours = latestAt ? Math.max(0, (now - latestAt) / 3600000) : null;
      const level = String(val(row, '买家等级') || '').toUpperCase();
      const subject = val(row, '询盘主题');
      const product = val(row, '咨询产品');
      const riskText = [lastBuyer && lastBuyer.text, subject, product].filter(Boolean).join(' ');
      const risks = risksOf(riskText);
      const demand = classifyDemand(riskText);
      const gaps = [];
      if (!session) gaps.push('未匹配到聊天会话');
      else if (!rows.length) gaps.push('聊天会话无消息');
      else if (!lastBuyer) gaps.push('聊天记录无客户消息');
      if (!subject && !product) gaps.push('缺少询盘主题和产品');
      if (needsReply && ageHours != null && ageHours > staleHours)
        gaps.push('最新业务活动超过 ' + staleHours + ' 小时');
      const priority = priorityOf(status, ageHours, level, createdTs, now, risks.length);
      const firstResponseMinutes = firstMine && createdTs
        ? Math.max(0, Math.round((firstMine.ts - createdTs) / 60000)) : null;

      items.push({
        inquiryId,
        customer: val(row, '客户名称'),
        company: val(row, '公司名称'),
        country: val(row, '国家'),
        level,
        owner: val(row, '负责人'),
        subject,
        product,
        replyStatus,
        createdAt,
        latestReplyAt: val(row, '最新回复时间'),
        session: session ? session.name : '',
        sessionMatched: !!session,
        status,
        needsReply,
        lastBuyerAt: lastBuyer ? lastBuyer.at : '',
        lastBuyerText: lastBuyer ? lastBuyer.text : '',
        lastMineAt: lastMine ? lastMine.at : '',
        lastMineText: lastMine ? lastMine.text : '',
        transcript,
        risks,
        demand,
        demandLabel: demand.label,
        gaps,
        priority: priority.level,
        score: priority.score,
        ageHours,
        firstResponseMinutes,
        contextAt: lastBuyer ? lastBuyer.at : '',
      });
    });

    items.sort((a, b) => (Number(b.needsReply) - Number(a.needsReply))
      || (b.score - a.score)
      || (parseTime(b.lastBuyerAt) - parseTime(a.lastBuyerAt))
      || (parseTime(b.createdAt) - parseTime(a.createdAt)));
    const pending = items.filter((item) => item.needsReply);
    const waiting = items.filter((item) => !item.needsReply);
    const limit = Math.max(1, Number(opts.limit) || 300);
    return {
      items: pending.concat(waiting).slice(0, limit),
      pending: pending.length,
      waiting: waiting.length,
      total: items.length,
    };
  }

  function draftMessages(item, options) {
    const opts = options || {};
    const source = item || {};
    if (!source.lastBuyerText && !source.subject && !source.product)
      throw new Error('缺少询盘主题、产品或客户消息，无法生成有依据的回复');
    const facts = String(opts.companyFacts || '').trim().slice(0, 2000);
    const transcript = (source.transcript || []).slice(-DRAFT_CONTEXT_MESSAGES).map((message) =>
      (message.at || '') + (message.mine ? ' 业务员：' : ' 客户：') + String(message.text || '').slice(0, 400)).join('\n');
    const demandType = source.demand && source.demand.type;
    const special = demandType === 'mismatch_finished'
      ? '【特殊场景】客户在咨询非主营的成品。公司不生产、不销售该类成品，也不承接相关加工。用客户语言礼貌说明这块帮不上，最多一句话说明公司主营方向，不推销、不报价、不承诺样品，感谢并祝对方找到合适供应商。不要写成公司声明或法律条款。'
      : demandType === 'target_material'
        ? '【特殊场景】客户在咨询主营材料，属于目标需求。确认收到并只提出一个澄清问题；不得报价或承诺交期。'
        : '';
    const system = '你是外贸业务员的询盘回复草稿助手。你的输出只是给员工审核的草稿，绝不会被自动发送。\n'
      + '只依据提供的询盘字段、最近聊天记录和公司已确认资料作答。\n'
      + '必须直接回应客户最新一条消息，使用客户使用的语言，40-90 词，语气自然、专业、简短。\n'
      + '禁止承诺或编造价格、折扣、交期、库存、认证、付款条件、产品适配性、独家代理或售后结论。\n'
      + '客户询问上述内容时，只说明需要确认具体需求后由业务员提供正式信息，不要给出任何数字或时间。\n'
      + '可以确认收到询盘，并只提出一个最有助于推进的问题。不要编造客户姓名、公司、订单、样品或案例。不要提及 AI。\n'
      + (special ? special + '\n' : '')
      + '只输出回复正文。';
    const payload = {
      客户: source.customer || '',
      公司: source.company || '',
      国家: source.country || '',
      买家等级: source.level || '',
      询盘主题: source.subject || '',
      咨询产品: source.product || '',
      询盘时间: source.createdAt || '',
      历史回复状态: source.replyStatus || '',
      最新买家消息时间: source.lastBuyerAt || '无（首次询盘）',
      最新买家消息: String(source.lastBuyerText || '').slice(0, 1000),
      风险提示: source.risks || [],
      公司已确认资料: facts || '未提供；不得引用任何价格、参数、认证或交期',
      最近对话: transcript || '无聊天记录',
    };
    return [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(payload) },
    ];
  }

  function reviewDraft(text, item) {
    const raw = String(text || '').trim();
    const flags = [];
    const push = (flag) => { if (!flags.includes(flag)) flags.push(flag); };
    if (raw.length < 15) push('回复过短');
    if (raw.length > 1500) push('回复过长');
    // 非中文草稿按词数校验；提示词要求 40-90 词，超过 160 词说明跑偏，需精简后再发
    if (!/[\u4e00-\u9fa5]/.test(raw)) {
      const words = raw.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean).length;
      if (words > 160) push('草稿过长，建议精简到 40-90 词');
    }
    if (/【需人工确认】|\[需人工确认\]/.test(raw)) push('仍有【需人工确认】占位');
    if (/[¥$€£]\s?\d|\b(?:usd|us\$|rmb|cny|eur|gbp|jpy|aud|cad)\s?\d/i.test(raw)
      || /\b\d+(?:\.\d+)?\s?(?:usd|dollars?|euros?|元|美元|欧元)\b/i.test(raw)
      || /\b(?:price|quote|quotation|cost|discount)\b[^.\n]{0,24}\d/i.test(raw)
      || /\b\d+(?:\.\d+)?\s?%/.test(raw)) push('出现价格或折扣数字');
    // 交期/运输承诺：覆盖 “3 business days”“plazo de 3 días”“3 Tage”“3 Wochen”“3 天”等常见表达
    if (/\b(?:lead\s*time|delivery|shipping|dispatch|transit|production\s+time)\b[^.\n]{0,40}?\d/i.test(raw)
      || /\b\d+\s*(?:-|to|~)?\s*\d*\s*(?:business\s+|working\s+|calendar\s+)?(?:days?|weeks?|months?|hours?)\b/i.test(raw)
      || /\b(?:within|in)\s+\d+\s*(?:business\s+|working\s+)?(?:days?|weeks?|months?|hours?)\b/i.test(raw)
      || /\b\d+\s*(?:d[ií]as?|semanas?|meses?|horas?|jours?|semaines?|mois|heures?|tage?n?|wochen?|stunden?|giorni?|settimane?|ore|дн[ея]й|недел[ьи]|час[аов]*|g[uü]n)\b/i.test(raw)
      || /\d+\s*(?:个)?\s*(?:工作日|天|周|小时|个月)/.test(raw)) push('出现交期或运输时间承诺');
    // 起订量/数量门槛同样属于商务承诺，需要人工确认。
    // 但“MOQ 需要业务员确认”这类不给数字的转人工表述不应被误拦截。
    {
      const moq = /\b(?:moq|minimum\s+order|min\.?\s*order)\b|起订|最小订|pedido\s+m[ií]nimo|mindestbestellung/i;
      const deferring = /\b(?:confirm|check|verify|advise|sales\s+team|business\s+team|our\s+team|specialist)\b|确认|核实|业务员/i;
      const hit = raw.match(moq);
      let blocked = !!hit;
      if (hit) {
        const after = raw.slice(hit.index + hit[0].length, hit.index + hit[0].length + 40);
        if (!/\d/.test(after) && deferring.test(raw)) blocked = false;
      }
      if (blocked) push('出现起订量或数量门槛');
    }
    if (/\b(?:certificate|certification|certified|iso\s?\d{4,5}|fda|rohs|reach)\b/i.test(raw)
      || /\bCE\b/.test(raw)) push('出现认证声明');
    if (/\b(?:in stock|out of stock|inventory|stock available)\b/i.test(raw)) push('出现库存声明');
    if (/\b(?:payment|paypal|t\/t|western union|l\/c|deposit)\b/i.test(raw)) push('出现付款条件');
    if (/\b(?:guarantee[ds]?|warranty|100\s?%|best price|cheapest|lowest price)\b/i.test(raw)) push('出现绝对化承诺');
    if (/https?:\/\/|www\./i.test(raw)) push('包含外部链接，需人工确认');
    // 阿里国际站禁止引导站外沟通：邮箱、WhatsApp/微信等账号、国际格式电话均需人工处理。
    // 但“不能提供站外联系方式，请在平台内沟通”这类拒绝语句不应被误拦截。
    {
      const hasEmail = /[\w.+-]+@[\w-]+\.[\w.]{2,}/.test(raw);
      const hasPhone = /(?:\+|00)\d[\d\s().-]{6,}\d/.test(raw);
      const social = /\b(?:whats\s?app|wa\.me|wechat|weixin|skype|telegram|viber|facebook|linkedin)\b/i;
      const declining = /(?:can\s*not|can't|cannot|unable|not\s+able|don't\s+share|do\s+not\s+share|no\s+external)[^.\n]{0,60}(?:whats\s?app|email|phone|wechat|contact)/i;
      if (hasEmail || hasPhone || (social.test(raw) && !declining.test(raw))) push('出现站外联系方式（平台违规风险）');
    }
    const buyerChinese = /[\u4e00-\u9fa5]/.test(String(item && item.lastBuyerText || ''));
    if (!buyerChinese && /[\u4e00-\u9fa5]/.test(raw)) push('草稿是中文，客户最近消息不是中文');
    return { ok: flags.length === 0, flags };
  }

  function idempotencyKey(item, text, workspace) {
    return [workspace || 'default', item && item.inquiryId || '', item && item.contextAt || 'none',
      hashText(normText(text))].join('|');
  }

  const STATUS_TEXT = {
    draft: '草稿',
    send_pending: '发送中',
    sent_page: '页面已发出',
    confirmed: '已确认送达',
    uncertain: '待核实',
    failed: '发送失败',
  };
  const statusText = (status) => STATUS_TEXT[status] || status || '未发送';

  function canSend(item, text, records, options) {
    const opts = options || {};
    const errors = [];
    if (!item) errors.push('没有选中的询盘');
    else {
      if (!item.needsReply) errors.push('该询盘当前不需要回复');
      if (!item.session) errors.push('未匹配到聊天会话，无法在聊天窗口发送');
    }
    const raw = String(text || '').trim();
    if (!raw) errors.push('回复内容为空');
    const review = reviewDraft(raw, item);
    review.flags.forEach((flag) => errors.push(flag));
    if (!opts.acknowledged) errors.push('请先回到平台核对最新买家消息并勾选确认');
    if (opts.chatHealth && opts.chatHealth !== '已更新')
      errors.push('聊天数据源未更新，请先更新平台数据或回平台核对');

    const now = Number(opts.now) || Date.now();
    const testMode = !!opts.testMode;
    // 正式发送只检查正式记录；测试模式跳过重复、冷却和日上限，避免影响真实统计。
    const list = Object.values(records || {}).filter((record) => !record.test);
    if (!testMode) {
      if (item) {
        const duplicated = list.find((record) => record.inquiryId === item.inquiryId
          && record.contextAt === item.contextAt
          && SENT_STATUSES.includes(record.status));
        if (duplicated) errors.push('该买家消息已有发送记录（' + statusText(duplicated.status) + '），请勿重复发送');
        const customerKey = normalizeName(item.session || item.customer);
        const recent = list.find((record) => normalizeName(record.session || record.customer) === customerKey
          && now - (record.sentAt || 0) < COOLDOWN_MS
          && SENT_STATUSES.includes(record.status));
        if (recent) errors.push('同一客户 10 分钟内已发送过消息，请稍后再发');
      }
      const sentToday = list.filter((record) => record.sentAt && dayKey(record.sentAt) === dayKey(now)
        && SENT_STATUSES.includes(record.status)).length;
      if (sentToday >= DAILY_LIMIT) errors.push('今日发送已达上限 ' + DAILY_LIMIT + ' 条');
    }
    return { ok: errors.length === 0, errors };
  }

  function pruneRecords(records, max) {
    const entries = Object.entries(records || {})
      .sort((a, b) => (b[1].sentAt || b[1].attemptedAt || 0) - (a[1].sentAt || a[1].attemptedAt || 0));
    return Object.fromEntries(entries.slice(0, Math.max(1, Number(max) || 500)));
  }

  function textMatch(left, right) {
    const a = normText(left);
    const b = normText(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const short = a.length < b.length ? a : b;
    const long = a.length < b.length ? b : a;
    return short.length >= 20 && long.indexOf(short) >= 0;
  }

  // 用已入库聊天记录回读我方消息，确认页面发送是否真的到达平台。
  function reconcile(records, chats, options) {
    const opts = options || {};
    const sessions = buildSessions(chats);
    const next = Object.assign({}, records || {});
    let changed = 0;
    Object.keys(next).forEach((key) => {
      const record = next[key];
      if (!SENT_STATUSES.includes(record.status) || record.status === 'confirmed') return;
      const session = sessions.get(normalizeName(record.session));
      if (session) {
        const from = (record.sentAt || record.attemptedAt || 0) - 10 * 60 * 1000;
        const hit = session.rows.find((row) => isMine(row)
          && parseTime(row['发送时间']) >= from
          && textMatch(row['内容'], record.text));
        if (hit) {
          next[key] = Object.assign({}, record, {
            status: 'confirmed',
            confirmedAt: parseTime(hit['发送时间']) || (opts.now || Date.now()),
            error: '',
          });
          changed += 1;
          return;
        }
      }
      // 页面发送后一直没有回写结果：超过 5 分钟标记为待核实，避免永远停在“发送中”。
      const now = Number(opts.now) || Date.now();
      if (record.status === 'send_pending' && record.sentAt && now - record.sentAt > 5 * 60 * 1000) {
        next[key] = Object.assign({}, record, {
          status: 'uncertain',
          error: record.error || '未收到页面发送结果，请到聊天窗口核实是否已发出',
        });
        changed += 1;
      }
    });
    return { records: next, changed };
  }

  function summarize(items, records, now) {
    const at = Number(now) || Date.now();
    const pendingItems = (items || []).filter((item) => item.needsReply);
    const values = Object.values(records || {});
    const production = values.filter((record) => !record.test);
    const sentToday = production.filter((record) => record.sentAt && dayKey(record.sentAt) === dayKey(at)
      && SENT_STATUSES.includes(record.status)).length;
    const confirmedToday = production.filter((record) => record.confirmedAt
      && dayKey(record.confirmedAt) === dayKey(at) && record.status === 'confirmed').length;
    const uncertain = production.filter((record) => record.status === 'uncertain').length;
    const testSentToday = values.filter((record) => record.test && record.sentAt
      && dayKey(record.sentAt) === dayKey(at) && SENT_STATUSES.includes(record.status)).length;
    const responses = (items || []).map((item) => item.firstResponseMinutes)
      .filter((value) => value != null && value >= 0).sort((a, b) => a - b);
    const mid = Math.floor(responses.length / 2);
    const median = responses.length
      ? (responses.length % 2 ? responses[mid] : Math.round((responses[mid - 1] + responses[mid]) / 2))
      : null;
    return {
      pending: pendingItems.length,
      newCount: pendingItems.filter((item) => item.status === 'new').length,
      buyerReplied: pendingItems.filter((item) => item.status === 'buyer_replied').length,
      highValue: pendingItems.filter((item) => item.level === 'L3' || item.level === 'L4').length,
      sentToday,
      confirmedToday,
      uncertain,
      testSentToday,
      medianFirstResponse: median,
    };
  }

  const api = {
    STALE_HOURS, DAILY_LIMIT, COOLDOWN_MS, DRAFT_PROMPT_VERSION, SENT_STATUSES,
    parseTime, fmtTime, dayKey, normalizeName, risksOf, statusText, classifyDemand,
    buildQueue, draftMessages, reviewDraft, idempotencyKey, canSend, pruneRecords, reconcile, summarize,
  };
  if (typeof self !== 'undefined') self.AliInquiryReply = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
