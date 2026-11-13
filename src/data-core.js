// 导入后的本地归并、订单口径和资料就绪状态；浏览器与 Node 测试共用。
(function () {
  'use strict';
  const txt = (v) => String(v === undefined || v === null ? '' : v).trim();
  const blank = (v) => !txt(v) || /^(?:-|n\/?a|unknown|未填写|暂无|未知|不详)$/i.test(txt(v));
  const key = (kind, row) => {
    const id = kind === 'inquiry' ? txt(row['询盘ID'])
      : kind === 'order' ? txt(row['订单ID'])
        : kind === 'visitor' ? txt(row['访客ID'])
          : kind === 'customer' || kind === 'public_customer' ? txt(row['客户ID']) : '';
    if (id) return kind + ':' + id + (kind === 'visitor'
      ? ':' + txt(row['统计日期'] || row.statDate) : '');
    if (kind === 'chat') {
      const parts = [row['会话'], row['发送时间'], row['内容']].map(txt);
      return parts.every(Boolean) ? kind + ':' + parts.join('\u0001') : '';
    }
    return '';
  };
  const MUTABLE_FIELDS = {
    inquiry: ['负责人', '是否已加为客户', '回复状态', '最新回复时间', '未联系天数', '处理进度'],
    customer: ['客户分组', '跟进状态', '负责人', '原负责人', '星标客户', '流失预警', '最近备注', '备注时间', '订单数'],
    public_customer: ['客户分组', '跟进状态', '负责人', '原负责人', '进入公海时间', '最近备注', '备注时间', '订单数'],
    order: ['订单状态', '平台状态'],
  };
  const mutable = (kind, field) => (MUTABLE_FIELDS[kind] || []).includes(field);
  const businessTime = (row, kind) => {
    const fields = kind === 'inquiry' ? ['最新回复时间', '创建时间']
      : kind === 'order' ? ['下单时间']
        : kind === 'customer' || kind === 'public_customer'
          ? ['备注时间', '领取时间', '创建时间'] : kind === 'chat' ? ['发送时间'] : ['统计日期'];
    return fields.map((field) => txt(row[field])).find((value) => !blank(value)) || '';
  };
  const provenance = (row, meta, field, known = true) => {
    const source = txt(row['资料来源']) || (meta.source === 'local-mcp' ? '本机MCP历史库' : meta.source === 'import' ? '本地导入' : '扩展导出');
    return { 来源: source, 文件: meta.displayName || meta.name, 时间: meta.mtime || '',
      状态: known ? '已知' : '未知', 采集时间: meta.importedAt || meta.mtime || '',
      业务时间: businessTime(row, meta.kind) };
  };
  // 输入按文件新到旧排列；稳定字段可用旧版本补空，可变字段以最新快照为准。
  function mergeFiles(files, kinds) {
    const out = {};
    const maps = {};
    const latestCrmSnapshots = {};
    files.forEach(({ meta, header, rows }, index) => {
      if (!['customer', 'public_customer'].includes(meta.kind) || latestCrmSnapshots[meta.kind]
        || !['platform-auto', 'export'].includes(meta.source)) return;
      const idColumn = (header || []).indexOf('客户ID');
      if (idColumn < 0) return;
      latestCrmSnapshots[meta.kind] = { index,
        ids: new Set((rows || []).map((r) => txt(r[idColumn])).filter(Boolean)) };
    });
    kinds.forEach((k) => { out[k] = []; maps[k] = new Map(); });
    for (const [fileIndex, file] of files.entries()) {
      const { meta, header } = file;
      if (!maps[meta.kind]) continue;
      const snapshot = latestCrmSnapshots[meta.kind];
      const idColumn = (header || []).indexOf('客户ID');
      const rows = snapshot && fileIndex > snapshot.index
        ? (file.rows || []).filter((r) => idColumn >= 0 && snapshot.ids.has(txt(r[idColumn])))
        : file.rows;
      for (const cells of rows || []) {
        const row = {};
        (header || []).forEach((h, i) => { if (h) row[h] = cells[i] === undefined || cells[i] === null ? '' : cells[i]; });
        const k = key(meta.kind, row);
        let target = k && maps[meta.kind].get(k);
        if (!target) {
          target = Object.assign({ __file__: meta.displayName || meta.name, __mtime__: meta.mtime, __fields: {} }, row);
          Object.keys(row).forEach((field) => { if (!blank(row[field])) target.__fields[field] = provenance(row, meta, field); });
          (MUTABLE_FIELDS[meta.kind] || []).forEach((field) => {
            if (Object.prototype.hasOwnProperty.call(row, field) && blank(row[field])) {
              target[field] = '';
              target.__fields[field] = provenance(row, meta, field, false);
            }
          });
          out[meta.kind].push(target);
          if (k) maps[meta.kind].set(k, target);
          continue;
        }
        Object.keys(row).forEach((field) => {
          if (mutable(meta.kind, field)) {
            if (!target.__fields[field]) {
              target[field] = blank(row[field]) ? '' : row[field];
              target.__fields[field] = provenance(row, meta, field, !blank(row[field]));
            }
            return;
          }
          if (blank(target[field]) && !blank(row[field])) {
            target[field] = row[field];
            target.__fields[field] = provenance(row, meta, field);
          }
        });
      }
    }
    return out;
  }
  async function digest(header, rows) {
    const bytes = new TextEncoder().encode(JSON.stringify([header || [], rows || []]));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash)).map((n) => n.toString(16).padStart(2, '0')).join('');
  }
  const amount = (v) => {
    if (blank(v)) return null;
    const n = Number(txt(v).replace(/[,\s$¥€]/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const wonOrder = (row) => /^(?:已付款|已完成|交易成功|paid|completed|finished)$/i.test(txt(row['订单状态']));
  function readiness(data) {
    const n = (k) => (data[k] || []).length;
    const hasCustomer = n('customer') + n('public_customer') > 0;
    const hasInquiry = n('inquiry') > 0;
    const hasChat = n('chat') > 0;
    const confirmedOrders = (data.order || []).filter(wonOrder);
    const confirmed = confirmedOrders.length;
    const inquiryIds = new Set((data.inquiry || []).map((r) => txt(r['询盘ID'])).filter(Boolean));
    const linkedIds = new Set(confirmedOrders.map((r) => txt(r['询盘ID'])).filter((id) => inquiryIds.has(id)));
    const stageIds = Object.entries(data.stages || {}).filter(([id, s]) => inquiryIds.has(id) && s.stage === '已成交' && txt(s.evidence)).map(([id]) => id);
    const wonIds = new Set([...linkedIds, ...stageIds]);
    const outcome = wonIds.size > 0;
    const closedIds = new Set([...wonIds, ...Object.entries(data.stages || {})
      .filter(([id, s]) => inquiryIds.has(id) && ['已流失', '无效询盘'].includes(s.stage) && txt(s.evidence)).map(([id]) => id)]);
    return {
      level: hasCustomer && hasInquiry ? (outcome ? '已有成交证据' : hasChat ? '机会可评估' : '线索可用') : '待导入',
      counts: { 客户: n('customer'), 公海: n('public_customer'), 询盘: n('inquiry'), 聊天: n('chat'), 订单: n('order'), 已确认订单: confirmed,
        已关联成交询盘: wonIds.size, 已核实结局询盘: closedIds.size },
      missing: [!hasCustomer && '客户', !hasInquiry && '询盘', !hasChat && '近期聊天', !confirmed && !stageIds.length && '已确认订单或核实成交阶段',
        confirmed && !wonIds.size && '订单与询盘关联', hasInquiry && closedIds.size < inquiryIds.size && '部分询盘结果待核实'].filter(Boolean),
    };
  }
  const api = { blank, key, mergeFiles, digest, amount, wonOrder, readiness };
  if (typeof self !== 'undefined') self.AliDataCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
