'use strict';

// 数据总览：六类当前态、数据源健康、优先缺口与数据版本
(() => {
  const { api, fmtTime, fmtRows, el, mount } = window.CloudData;
  const $ = (id) => document.getElementById(id);
  const KIND_LABEL = {
    inquiry: '询盘', chat: '聊天', customer: '我的客户',
    public_customer: '公海客户', order: '订单', visitor: '访客', ad_report: '投流报表',
  };
  const STATUS_LABEL = { ok: '正常', stale: '延迟', empty: '空' };

  function renderKpis(summary, home) {
    const box = $('kpis');
    box.textContent = '';
    const sources = summary.sources || [];
    const identity = home.identity || null;
    const bad = sources.filter((src) => src.status !== 'ok').length;
    const gaps = summary.gaps || [];
    const highGaps = gaps.filter((g) => g.level === 'high').length;
    const items = [
      ['六类当前记录', fmtRows(summary.totals && summary.totals.rows), '已入库业务资料'],
      ['数据源异常', bad, bad ? '查看下方数据源状态' : '当前来源状态正常'],
      ['客户档案', identity ? fmtRows(identity.profiles) : '—', identity ? '身份归并后的档案数' : '等待身份统计'],
      ['重复档案', identity ? fmtRows(identity.duplicateGroups) : '—', identity ? '需要主数据合并核对' : '等待身份统计'],
      ['资料缺口', gaps.length, highGaps ? highGaps + ' 项高优先级' : '暂无高优先级缺口'],
    ];
    items.forEach(([label, value, hint]) => {
      const card = el('div', 'kpi');
      card.appendChild(el('div', 'k', label));
      card.appendChild(el('div', 'v', String(value)));
      card.appendChild(el('div', 'h', hint));
      box.appendChild(card);
    });
  }

  function renderBriefing(summary, home) {
    $('briefing-text').textContent = home.headline || '暂无业务简报，先在扩展里完成一次同步。';
    const bad = (summary.sources || []).filter((src) => src.status !== 'ok').length;
    const gaps = (summary.gaps || []).length;
    const badge = $('quality-badge');
    badge.className = 'quality-badge' + (bad || gaps ? ' warn' : '');
    badge.textContent = bad ? bad + ' 个数据源需核对' : gaps ? gaps + ' 项资料缺口' : '数据源状态正常';
  }

  function renderSources(summary) {
    const body = $('sources').querySelector('tbody');
    body.textContent = '';
    const sources = summary.sources || [];
    if (!sources.length) {
      const tr = el('tr');
      const td = el('td', 'muted', '还没有任何数据源，先在扩展里完成一次同步');
      td.colSpan = 6;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    sources.forEach((src) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, KIND_LABEL[src.kind] || src.kind));
      tr.appendChild(el('td', null, fmtRows(src.rows)));
      tr.appendChild(el('td', null, src.batches));
      tr.appendChild(el('td', null, fmtTime(src.last_success_at)));
      tr.appendChild(el('td', null, fmtTime(src.last_business_at)));
      const td = el('td');
      const pill = el('span', 'pill ' + src.status, STATUS_LABEL[src.status] || src.status);
      td.appendChild(pill);
      if (src.status === 'stale' && src.age_hours) td.appendChild(el('span', 'muted', ' ' + src.age_hours + ' 小时前'));
      tr.appendChild(td);
      body.appendChild(tr);
    });
  }

  function renderGaps(summary) {
    const box = $('gaps');
    box.textContent = '';
    const gaps = (summary.gaps || []).slice(0, 6);
    if (!gaps.length) {
      box.appendChild(el('p', 'muted', '没有发现超过阈值的缺口。'));
      return;
    }
    gaps.forEach((gap) => {
      const card = el('div', 'gap');
      const head = el('div', 'gap-head');
      head.appendChild(el('span', 'gap-title', gap.title));
      head.appendChild(el('span', 'lv ' + gap.level, gap.level));
      card.appendChild(head);
      if (gap.total) card.appendChild(el('div', 'muted', gap.count + ' / ' + gap.total + '（' + gap.ratio + '%）'));
      if (gap.detail) card.appendChild(el('div', 'gap-detail', gap.detail));
      if (gap.action) card.appendChild(el('div', 'gap-action', '建议：' + gap.action));
      box.appendChild(card);
    });
  }

  function renderMeta(payload, summary, home) {
    const box = $('meta');
    box.textContent = '';
    const identity = home.identity || null;
    const rows = [
      ['店铺', payload.seller_id || '—'],
      ['数据版本', fmtTime(payload.generated_at)],
      ['当前记录合计', fmtRows(summary.totals && summary.totals.rows)],
      ['数据源数量', (summary.sources || []).length],
      ['客户档案', identity ? fmtRows(identity.profiles) : '—'],
      ['重复档案', identity ? fmtRows(identity.duplicateGroups) : '—'],
    ];
    rows.forEach(([label, value]) => {
      const item = el('div', 'meta-item');
      item.appendChild(el('span', 'meta-k', label));
      item.appendChild(el('span', 'meta-v', String(value)));
      box.appendChild(item);
    });
  }

  async function load() {
    const payload = await api('/api/overview');
    const summary = payload.summary || {};
    const home = payload.home || {};
    $('seller').textContent = '店铺 · ' + (payload.seller_id || '—');
    $('updated').textContent = '更新于 ' + fmtTime(payload.generated_at);
    renderBriefing(summary, home);
    renderKpis(summary, home);
    renderSources(summary);
    renderGaps(summary);
    renderMeta(payload, summary, home);
  }

  mount(load);
})();
