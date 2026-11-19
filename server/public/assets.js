'use strict';

// 数据资产：按数据源查看字段覆盖率、样本记录与同步新鲜度
(() => {
  const { api, fmtTime, fmtRows, el, mount } = window.CloudData;
  const $ = (id) => document.getElementById(id);
  const KINDS = [
    ['inquiry', '询盘'], ['customer', '我的客户'], ['public_customer', '公海客户'],
    ['chat', '聊天'], ['order', '订单'], ['visitor', '访客'], ['ad_report', '投流报表'],
  ];
  const LABEL = {};
  KINDS.forEach(([kind, name]) => { LABEL[kind] = name; });
  let current = 'inquiry';
  let payload = null;

  const text = (value) => {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch (e) { return String(value); }
    }
    return String(value);
  };
  const short = (value, size) => {
    const s = text(value).trim();
    return s.length > size ? s.slice(0, size) + '…' : s;
  };

  function renderTabs() {
    const box = $('kind-tabs');
    box.textContent = '';
    const counts = new Map(((payload && payload.kinds) || []).map((row) => [row.kind, row.rows]));
    KINDS.forEach(([kind, name]) => {
      const button = el('button', 'tab' + (kind === current ? ' active' : ''), name);
      button.type = 'button';
      button.appendChild(el('span', 'tab-count', fmtRows(counts.get(kind) || 0)));
      button.onclick = () => {
        if (kind === current) return;
        current = kind;
        load();
      };
      box.appendChild(button);
    });
  }

  function freshness(src) {
    if (!src || !src.rows) return { cls: 'empty', label: '空' };
    if (!src.last_success_at) return { cls: 'empty', label: '未同步' };
    const age = Date.now() - Date.parse(src.last_success_at);
    if (!Number.isFinite(age)) return { cls: 'empty', label: '未知' };
    if (age <= 30 * 60000) return { cls: 'ok', label: '新鲜' };
    if (age <= 120 * 60000) return { cls: 'stale', label: '延迟' };
    return { cls: 'stale', label: '过期' };
  }

  function renderKpis() {
    const box = $('kpis');
    box.textContent = '';
    const fields = payload.fields || [];
    const strong = fields.filter((field) => field.ratio >= 90).length;
    const items = [
      ['当前记录', fmtRows(payload.total), LABEL[payload.kind] || payload.kind],
      ['抽样条数', fmtRows(payload.sample_size), '字段覆盖率统计口径'],
      ['字段数', fmtRows(fields.length), '样本中出现的字段'],
      ['高覆盖字段', fmtRows(strong), '覆盖率 ≥ 90%'],
      ['最近同步', fmtTime(payload.freshness && payload.freshness.last_success_at), '数据源成功同步时间'],
    ];
    items.forEach(([label, value, hint]) => {
      const card = el('div', 'kpi');
      card.appendChild(el('div', 'k', label));
      card.appendChild(el('div', 'v', String(value)));
      card.appendChild(el('div', 'h', hint));
      box.appendChild(card);
    });
  }

  function renderBriefing() {
    const fresh = freshness(payload.freshness);
    const fields = payload.fields || [];
    const strong = fields.filter((field) => field.ratio >= 90).length;
    const label = LABEL[payload.kind] || payload.kind;
    $('briefing-text').textContent = label + ' 当前 ' + fmtRows(payload.total) + ' 条，抽样 '
      + fmtRows(payload.sample_size) + ' 条，共 ' + fields.length + ' 个字段，其中 ' + strong
      + ' 个字段覆盖率 ≥ 90%；最近成功同步 ' + fmtTime(payload.freshness && payload.freshness.last_success_at) + '。';
    const badge = $('asset-badge');
    badge.className = 'quality-badge' + (fresh.cls === 'ok' ? '' : fresh.cls === 'stale' ? ' warn' : '');
    badge.textContent = label + ' · ' + fresh.label;
  }

  function renderFields() {
    const body = $('fields').querySelector('tbody');
    body.textContent = '';
    $('fields-note').textContent = '基于样本 ' + fmtRows(payload.sample_size) + ' 条 · 字段 ' + (payload.fields || []).length + ' 个';
    const fields = payload.fields || [];
    if (!fields.length) {
      const tr = el('tr');
      const td = el('td', 'muted', '这个数据源还没有记录，先在扩展里完成一次同步。');
      td.colSpan = 4;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    fields.forEach((field) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, field.key));
      tr.appendChild(el('td', null, fmtRows(field.filled)));
      const ratio = el('td', 'ratio-cell');
      ratio.appendChild(el('span', null, field.ratio + '%'));
      const bar = el('div', 'bar');
      const fill = el('i');
      fill.style.width = Math.max(0, Math.min(100, field.ratio)) + '%';
      bar.appendChild(fill);
      ratio.appendChild(bar);
      tr.appendChild(ratio);
      tr.appendChild(el('td', 'muted', field.example ? short(field.example, 60) : '—'));
      body.appendChild(tr);
    });
  }

  function renderSamples() {
    const rows = payload.rows || [];
    const table = $('samples');
    const head = table.querySelector('thead tr');
    const body = table.querySelector('tbody');
    head.textContent = '';
    body.textContent = '';
    $('samples-note').textContent = rows.length
      ? '展示前 ' + rows.length + ' 条样本；导出包含当前样本的全部字段。'
      : '当前数据源没有可展示的样本。';
    if (!rows.length) {
      head.appendChild(el('th', null, '—'));
      const tr = el('tr');
      const td = el('td', 'muted', '暂无样本记录。');
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    const keys = [];
    rows.forEach((row) => Object.keys(row || {}).forEach((key) => {
      if (key.indexOf('__') === 0) return;
      if (keys.indexOf(key) < 0) keys.push(key);
    }));
    const columns = keys.slice(0, 14);
    head.appendChild(el('th', 'idx', '#'));
    columns.forEach((key) => head.appendChild(el('th', null, key)));
    rows.forEach((row, index) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'muted', String(index + 1)));
      columns.forEach((key) => tr.appendChild(el('td', null, short(row[key], 40) || '—')));
      body.appendChild(tr);
    });
  }

  function exportCsv() {
    const rows = payload.rows || [];
    if (!rows.length) {
      $('samples-note').textContent = '没有可导出的样本。';
      return;
    }
    const keys = [];
    rows.forEach((row) => Object.keys(row || {}).forEach((key) => {
      if (key.indexOf('__') === 0) return;
      if (keys.indexOf(key) < 0) keys.push(key);
    }));
    const escape = (value) => '"' + text(value).replace(/"/g, '""') + '"';
    const lines = [keys.map(escape).join(',')];
    rows.forEach((row) => lines.push(keys.map((key) => escape(row[key])).join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'data-assets-' + payload.kind + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function load() {
    payload = await api('/api/data-assets?kind=' + encodeURIComponent(current) + '&sample=500&rows=20');
    $('seller').textContent = '店铺 · ' + (payload.seller_id || '—');
    $('updated').textContent = '更新于 ' + fmtTime(payload.generated_at);
    renderBriefing();
    renderKpis();
    renderTabs();
    renderFields();
    renderSamples();
  }

  $('export').onclick = exportCsv;
  mount(load);
})();
