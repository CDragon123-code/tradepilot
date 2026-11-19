'use strict';

// 经营总览：经营结果、转化漏斗、市场/渠道结构与运营健康度
(() => {
  const { api, fmtTime, fmtRows, el, mount } = window.CloudData;
  const $ = (id) => document.getElementById(id);
  const state = { owner: '', payload: null, gradeFilter: 'all', gradeRows: [] };

  function pct(a, b) {
    return b ? Math.round((a / b) * 1000) / 10 + '%' : '—';
  }

  function renderBriefing(payload) {
    $('briefing-text').textContent = payload.headline || '暂无经营数据，先在扩展里完成一次同步。';
    const quality = payload.quality_recent || payload.quality || [];
    const freshness = payload.freshness || [];
    const high = quality.filter((item) => item.level === 'high').length;
    const stale = freshness.filter((item) => item.status === 'stale').length;
    const badge = $('business-badge');
    badge.className = 'quality-badge' + (high || stale ? ' warn' : '');
    badge.textContent = high ? high + ' 项高优先级缺口'
      : stale ? stale + ' 个数据源需核对' : '经营状态正常';
  }

  function renderKpis(payload) {
    const box = $('kpis');
    box.textContent = '';
    (payload.kpis || []).forEach(([label, value, hint]) => {
      const card = el('div', 'kpi');
      card.appendChild(el('div', 'k', label));
      const text = String(value);
      const node = el('div', 'v' + (text.length > 12 ? ' small' : ''), text);
      card.appendChild(node);
      card.appendChild(el('div', 'h', hint || ''));
      box.appendChild(card);
    });
  }

  function svgNode(tag, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach((key) => node.setAttribute(key, String(attrs[key])));
    return node;
  }

  function renderBars(box, rows, field, color) {
    box.textContent = '';
    if (!rows.length) {
      box.appendChild(el('p', 'muted', '暂无趋势数据。'));
      return;
    }
    const width = 640;
    const height = 170;
    const padX = 26;
    const padTop = 20;
    const padBottom = 30;
    const gap = 16;
    const max = Math.max(1, ...rows.map((row) => Number(row[field]) || 0));
    const barWidth = (width - padX * 2 - gap * (rows.length - 1)) / rows.length;
    const svg = svgNode('svg', {
      viewBox: '0 0 ' + width + ' ' + height,
      role: 'img',
      'aria-label': field === 'inquiries' ? '近 6 个月询盘趋势' : '近 6 个月已确认订单趋势',
    });
    svg.appendChild(svgNode('line', {
      x1: padX, y1: height - padBottom, x2: width - padX, y2: height - padBottom,
      stroke: '#e6eef8', 'stroke-width': 1,
    }));
    rows.forEach((row, index) => {
      const value = Number(row[field]) || 0;
      const barHeight = Math.max(2, (value / max) * (height - padTop - padBottom));
      const x = padX + index * (barWidth + gap);
      const y = height - padBottom - barHeight;
      const rect = svgNode('rect', {
        x: x, y: y, width: barWidth, height: barHeight,
        rx: 4, fill: color, opacity: value ? 0.92 : 0.25,
      });
      rect.appendChild(svgNode('title', {})).textContent = row.label + '：' + value;
      svg.appendChild(rect);
      const valueText = svgNode('text', {
        x: x + barWidth / 2, y: y - 5, 'text-anchor': 'middle',
        'font-size': 11, fill: '#526581', 'font-weight': 700,
      });
      valueText.textContent = String(value);
      svg.appendChild(valueText);
      const labelText = svgNode('text', {
        x: x + barWidth / 2, y: height - 10, 'text-anchor': 'middle',
        'font-size': 11, fill: '#8292a7',
      });
      labelText.textContent = row.label;
      svg.appendChild(labelText);
    });
    box.appendChild(svg);
  }

  function renderTrend(payload) {
    const rows = payload.trend || [];
    const inquiries = rows.reduce((sum, row) => sum + (Number(row.inquiries) || 0), 0);
    const orders = rows.reduce((sum, row) => sum + (Number(row.orders) || 0), 0);
    $('trend-inquiries-total').textContent = '合计 ' + fmtRows(inquiries) + ' 条';
    $('trend-orders-total').textContent = '合计 ' + fmtRows(orders) + ' 笔';
    renderBars($('trend-inquiries'), rows, 'inquiries', '#2759d8');
    renderBars($('trend-orders'), rows, 'orders', '#e6a433');
  }

  function renderFunnel(payload) {
    const box = $('funnel');
    box.textContent = '';
    const rows = payload.funnel || [];
    if (!rows.length) {
      box.appendChild(el('p', 'muted', '暂无可计算的转化漏斗。'));
      return;
    }
    rows.forEach((stage) => {
      const row = el('div', 'funnel-row');
      const head = el('div', 'funnel-head');
      head.appendChild(el('span', 'funnel-label', stage.label));
      head.appendChild(el('span', 'funnel-value', fmtRows(stage.count) + ' · '
        + (stage.rate == null ? '—' : stage.rate + '%')));
      row.appendChild(head);
      const track = el('div', 'funnel-track');
      const fill = el('i');
      fill.style.width = Math.max(0, Math.min(100, Number(stage.rate) || 0)) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      if (stage.hint) row.appendChild(el('div', 'funnel-hint', stage.hint));
      box.appendChild(row);
    });
  }

  function renderShare(tableId, rows) {
    const body = $(tableId).querySelector('tbody');
    body.textContent = '';
    if (!rows.length) {
      const tr = el('tr');
      const td = el('td', 'muted', '暂无数据。');
      td.colSpan = 3;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    rows.forEach((row) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, row.name || '—'));
      tr.appendChild(el('td', null, fmtRows(row.count)));
      const ratio = el('td', 'ratio-cell');
      ratio.appendChild(el('span', null, row.rate == null ? '—' : row.rate + '%'));
      const bar = el('div', 'bar');
      const fill = el('i');
      fill.style.width = Math.max(0, Math.min(100, Number(row.rate) || 0)) + '%';
      bar.appendChild(fill);
      ratio.appendChild(bar);
      tr.appendChild(ratio);
      body.appendChild(tr);
    });
  }

  function amountsText(list) {
    return (list || []).map((item) => (item.currency === '未标注币种' ? '' : item.currency + ' ')
      + Number(item.amount).toLocaleString('zh-CN', { maximumFractionDigits: 2 })).join(' / ') || '—';
  }

  function renderDirectDeals(payload) {
    const box = $('direct-deals');
    box.textContent = '';
    const deals = payload.direct_deals || [];
    if (!deals.length) return;
    box.appendChild(el('h3', null, '直接成交（无询盘来源）'));
    const wrap = el('div', 'table-scroll');
    const table = el('table');
    const head = el('thead');
    const headRow = el('tr');
    ['客户', '公司', '订单', '金额'].forEach((label) => headRow.appendChild(el('th', null, label)));
    head.appendChild(headRow);
    table.appendChild(head);
    const body = el('tbody');
    deals.forEach((deal) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, deal.customer || deal.name || '—'));
      tr.appendChild(el('td', null, deal.company || '—'));
      tr.appendChild(el('td', null, deal.orders + ' 笔'));
      tr.appendChild(el('td', null, amountsText(deal.amounts)));
      body.appendChild(tr);
    });
    table.appendChild(body);
    wrap.appendChild(table);
    box.appendChild(wrap);
    const summary = payload.direct_summary || {};
    box.appendChild(el('p', 'muted', '共 ' + fmtRows(summary.orders) + ' 笔直接成交 / '
      + amountsText(summary.amounts) + '；已在「订单未关联询盘」缺口说明中单列。'));
  }

  function renderGmv(payload) {
    const box = $('gmv');
    box.textContent = '';
    const gmv = payload.gmv || [];
    const orderKpi = (payload.kpis || []).find((item) => item[0] === '累计订单');
    if (orderKpi) {
      const item = el('div', 'meta-item');
      item.appendChild(el('span', 'meta-k', '累计订单'));
      item.appendChild(el('span', 'meta-v', String(orderKpi[1]) + ' 笔'));
      box.appendChild(item);
    }
    if (!gmv.length) {
      box.appendChild(el('p', 'muted', '暂无已确认成交额。'));
      renderDirectDeals(payload);
      return;
    }
    gmv.forEach((row) => {
      const item = el('div', 'meta-item');
      item.appendChild(el('span', 'meta-k', row.currency === '未标注币种' ? '未标注币种' : row.currency));
      const amount = Number(row.amount) || 0;
      item.appendChild(el('span', 'meta-v', amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })));
      box.appendChild(item);
    });
    renderDirectDeals(payload);
  }

  function renderOps(payload) {
    const box = $('ops');
    box.textContent = '';
    const freshness = payload.freshness || [];
    const identity = payload.identity || {};
    const ai = payload.ai || {};
    const agents = ai.agents || {};
    const items = ai.items || {};
    const stale = freshness.filter((row) => row.status === 'stale').length;
    const empty = freshness.filter((row) => row.status === 'empty').length;
    const ok = freshness.filter((row) => row.status === 'ok').length;
    const rows = [
      ['数据源', ok + ' 正常 · ' + stale + ' 延迟 · ' + empty + ' 空'],
      ['客户档案', fmtRows(identity.profiles) + ' 份'],
      ['重复档案', fmtRows(identity.duplicateGroups) + ' 组'],
      ['询盘匹配率', pct(identity.linkedInquiries, identity.inquiries)],
      ['聊天匹配率', pct(identity.linkedChatSessions, identity.chatSessions)],
      ['AI 智能体', (agents.active || 0) + ' / ' + (agents.total || 0) + ' 启用'],
      ['AI 待处理', fmtRows((items.pending || 0) + (items.drafted || 0) + (items.review_required || 0))],
      ['数据版本', fmtTime(payload.data_version)],
    ];
    rows.forEach(([label, value]) => {
      const item = el('div', 'meta-item');
      item.appendChild(el('span', 'meta-k', label));
      item.appendChild(el('span', 'meta-v', String(value)));
      box.appendChild(item);
    });
  }

  function renderGapTable(tableId, rows, recent) {
    const body = $(tableId).querySelector('tbody');
    body.textContent = '';
    if (!rows.length) {
      const tr = el('tr');
      const td = el('td', 'muted', recent ? '近 30 天没有影响经营的资料缺口。' : '没有历史资料缺口。');
      td.colSpan = 4;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    rows.forEach((row) => {
      const count = recent ? row.recent_count : row.history_count;
      const total = recent ? row.recent_total : row.history_total;
      const tr = el('tr');
      tr.appendChild(el('td', null, row.label));
      tr.appendChild(el('td', null, total ? count + ' / ' + total : fmtRows(count)));
      const level = el('td');
      const map = { high: ['高', 'stale'], mid: ['中', 'stale'], low: ['低', 'empty'] };
      const item = map[row.level] || [row.level || '—', 'empty'];
      level.appendChild(el('span', 'pill ' + item[1], item[0]));
      tr.appendChild(level);
      tr.appendChild(el('td', 'muted', row.hint || '—'));
      body.appendChild(tr);
    });
  }

  function renderQuality(payload) {
    renderGapTable('quality-recent', payload.quality_recent || [], true);
    renderGapTable('quality-history', payload.quality_history || [], false);
  }

  function ownerLabel(name) {
    if (!name) return '';
    const labels = (state.payload && state.payload.owner_labels) || {};
    return labels[name] || name;
  }

  function ownerRaw(input) {
    const value = String(input || '').trim();
    if (!value) return '';
    const labels = (state.payload && state.payload.owner_labels) || {};
    const hit = Object.keys(labels).find((raw) => labels[raw] === value);
    return hit || value;
  }

  function renderGrade(payload) {
    const all = payload.grade_missing || [];
    const summary = payload.grade_missing_summary || {};
    const filters = [
      ['all', '全部', all.length],
      ['app', 'APP 端详情页商机', all.filter((row) => row.source === 'APP端详情页商机').length],
      ['sub', ownerLabel('Sub Account'), all.filter((row) => row.owner === 'Sub Account').length],
    ];
    if (state.gradeFilter !== 'all'
      && !filters.find((item) => item[0] === state.gradeFilter && item[2])) {
      state.gradeFilter = 'all';
    }
    const tabs = $('grade-filters');
    tabs.textContent = '';
    filters.forEach(([key, label, count]) => {
      if (key !== 'all' && !count) return;
      const button = el('button', 'tab' + (state.gradeFilter === key ? ' active' : ''), label);
      button.type = 'button';
      button.appendChild(el('span', 'tab-count', String(count)));
      button.onclick = () => {
        state.gradeFilter = key;
        renderGrade(state.payload);
      };
      tabs.appendChild(button);
    });
    const rows = all.filter((row) => (state.gradeFilter === 'all' ? true
      : state.gradeFilter === 'app' ? row.source === 'APP端详情页商机'
        : row.owner === 'Sub Account'));
    state.gradeRows = rows;
    const sources = (summary.sources || []).slice(0, 3)
      .map((item) => item.name + ' ' + item.count).join(' · ');
    const owners = (summary.owners || []).slice(0, 3)
      .map((item) => ownerLabel(item.name) + ' ' + item.count).join(' · ');
    $('grade-summary').textContent = all.length
      ? '近 30 天共 ' + all.length + ' 条待补；来源：' + sources + '；负责人：' + owners
        + '。已按 APP 端详情页商机、Sub Account 优先排序。'
      : '近 30 天没有需要补买家等级的询盘。';
    const body = $('grade-items').querySelector('tbody');
    body.textContent = '';
    if (!rows.length) {
      const tr = el('tr');
      const td = el('td', 'muted', '当前筛选下没有待补等级的询盘。');
      td.colSpan = 6;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    rows.forEach((row) => {
      const tr = el('tr');
      const inquiry = el('td');
      inquiry.appendChild(el('div', 'mono', row.inquiry_id || '—'));
      if (row.subject) inquiry.appendChild(el('div', 'muted', row.subject));
      tr.appendChild(inquiry);
      const customer = el('td');
      customer.appendChild(el('div', null, row.customer || '—'));
      if (row.company) customer.appendChild(el('div', 'muted', row.company));
      tr.appendChild(customer);
      tr.appendChild(el('td', null, row.source || '—'));
      tr.appendChild(el('td', null, ownerLabel(row.owner) || '—'));
      tr.appendChild(el('td', 'muted', row.country || '—'));
      tr.appendChild(el('td', 'muted', row.created_at || '—'));
      body.appendChild(tr);
    });
  }

  function csvEscape(value) {
    return '"' + String(value === undefined || value === null ? '' : value)
      .replace(/"/g, '""') + '"';
  }

  function exportGradeCsv() {
    const rows = state.gradeRows || [];
    if (!rows.length) {
      $('grade-summary').textContent = '当前清单为空，没有可导出的询盘。';
      return;
    }
    const header = ['询盘ID', '客户', '公司', '来源', '负责人', '国家', '主题', '创建时间', '回复状态'];
    const lines = [header.map(csvEscape).join(',')];
    rows.forEach((row) => {
      lines.push([row.inquiry_id, row.customer, row.company, row.source, ownerLabel(row.owner),
        row.country, row.subject, row.created_at, row.replied].map(csvEscape).join(','));
    });
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pending-grades-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function render(payload) {
    $('seller').textContent = '店铺 · ' + (payload.seller_id || '—') + ' · 负责人 '
      + (payload.owner ? ownerLabel(payload.owner) : '全部');
    $('updated').textContent = '更新于 ' + fmtTime(payload.generated_at);
    $('owner-status').textContent = '负责人：' + (payload.owner ? ownerLabel(payload.owner) : '全部');
    renderBriefing(payload);
    renderKpis(payload);
    renderTrend(payload);
    renderFunnel(payload);
    renderShare('countries', payload.countries || []);
    renderShare('sources', payload.sources || []);
    renderGmv(payload);
    renderOps(payload);
    renderQuality(payload);
    renderGrade(payload);
  }

  async function load() {
    const query = '/api/business/overview' + (state.owner ? '?owner=' + encodeURIComponent(state.owner) : '');
    state.payload = await api(query);
    render(state.payload);
  }

  function applyOwner() {
    state.owner = ownerRaw($('owner-filter').value);
    state.gradeFilter = 'all';
    load().catch((error) => {
      $('owner-status').textContent = '读取失败：' + error.message;
    });
  }

  function clearOwner() {
    state.owner = '';
    state.gradeFilter = 'all';
    $('owner-filter').value = '';
    load().catch((error) => {
      $('owner-status').textContent = '读取失败：' + error.message;
    });
  }

  $('owner-apply').onclick = applyOwner;
  $('owner-clear').onclick = clearOwner;
  $('export-grade').onclick = exportGradeCsv;
  $('owner-filter').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyOwner();
  });
  mount(load);
})();
