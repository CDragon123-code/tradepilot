'use strict';

// 数据质量：身份归并、字段缺口、数据源新鲜度与导入批次
(() => {
  const { api, fmtTime, fmtRows, el, mount } = window.CloudData;
  const $ = (id) => document.getElementById(id);
  const KIND_LABEL = {
    inquiry: '询盘', chat: '聊天', customer: '我的客户',
    public_customer: '公海客户', order: '订单', visitor: '访客', ad_report: '投流报表',
  };
  const STATUS_LABEL = { ok: '正常', stale: '延迟', empty: '空' };
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + '%' : '—');

  function renderKpis(summary, identity) {
    const box = $('kpis');
    box.textContent = '';
    const gaps = summary.gaps || [];
    const items = [
      ['客户档案', identity ? fmtRows(identity.profiles) : '—', '身份归并后的档案数'],
      ['重复档案', identity ? fmtRows(identity.duplicateGroups) : '—', '需要主数据合并核对'],
      ['询盘匹配率', identity ? pct(identity.linkedInquiries, identity.inquiries) : '—', identity ? identity.linkedInquiries + ' / ' + identity.inquiries : '等待统计'],
      ['聊天匹配率', identity ? pct(identity.linkedChatSessions, identity.chatSessions) : '—', identity ? identity.linkedChatSessions + ' / ' + identity.chatSessions : '等待统计'],
      ['资料缺口', gaps.length, gaps.length ? '按影响排序' : '暂无超过阈值缺口'],
    ];
    items.forEach(([label, value, hint]) => {
      const card = el('div', 'kpi');
      card.appendChild(el('div', 'k', label));
      card.appendChild(el('div', 'v', String(value)));
      card.appendChild(el('div', 'h', hint));
      box.appendChild(card);
    });
  }

  function renderBriefing(summary, identity) {
    const gaps = summary.gaps || [];
    const dup = identity ? identity.duplicateGroups : 0;
    const parts = [];
    if (identity) {
      parts.push('客户档案 ' + identity.profiles + ' 个');
      parts.push('重复档案 ' + dup + ' 组');
      parts.push('询盘匹配 ' + pct(identity.linkedInquiries, identity.inquiries));
      parts.push('聊天匹配 ' + pct(identity.linkedChatSessions, identity.chatSessions));
    } else {
      parts.push('身份统计暂不可用');
    }
    if (gaps.length) parts.push('资料缺口 ' + gaps.length + ' 项');
    $('briefing-text').textContent = parts.join('；') + '。';
    const badge = $('quality-badge');
    const bad = gaps.filter((g) => g.level === 'high').length;
    badge.className = 'quality-badge' + (bad || dup ? ' warn' : '');
    badge.textContent = bad ? bad + ' 项高优先级缺口' + (dup ? ' · ' + dup + ' 组重复档案' : '') : dup ? dup + ' 组重复档案' : '质量状态正常';
  }

  function renderIdentity(identity) {
    const box = $('identity');
    box.textContent = '';
    if (!identity) {
      box.appendChild(el('span', 'muted', '身份统计暂不可用（需要先同步客户、询盘与聊天）'));
      return;
    }
    const rows = [
      ['客户记录', identity.customers],
      ['客户档案', identity.profiles],
      ['重复档案', identity.duplicateGroups],
      ['询盘总数', identity.inquiries],
      ['已关联询盘', identity.linkedInquiries],
      ['聊天会话', identity.chatSessions],
      ['已关联聊天', identity.linkedChatSessions],
      ['已关联客户档案', identity.linkedChatSessionsCrm],
      ['别名数量', identity.aliases],
      ['聊天消息', identity.chatMessages],
    ];
    rows.forEach(([label, value]) => {
      const item = el('div', 'meta-item');
      item.appendChild(el('span', 'meta-k', label));
      item.appendChild(el('span', 'meta-v', fmtRows(value)));
      box.appendChild(item);
    });
  }

  function renderGaps(summary) {
    const body = $('gaps').querySelector('tbody');
    body.textContent = '';
    const gaps = summary.gaps || [];
    if (!gaps.length) {
      const tr = el('tr');
      const td = el('td', 'muted', '没有发现超过阈值的缺口。');
      td.colSpan = 5;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    gaps.forEach((gap) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, gap.title));
      tr.appendChild(el('td', null, gap.total ? gap.count + ' / ' + gap.total : fmtRows(gap.count)));
      tr.appendChild(el('td', null, gap.ratio !== undefined ? gap.ratio + '%' : '—'));
      const level = el('td');
      level.appendChild(el('span', 'pill ' + (gap.level === 'high' ? 'stale' : gap.level === 'mid' ? 'stale' : 'ok'), gap.level));
      tr.appendChild(level);
      tr.appendChild(el('td', 'muted', gap.action || '—'));
      body.appendChild(tr);
    });
  }

  function renderSources(summary) {
    const body = $('sources').querySelector('tbody');
    body.textContent = '';
    const sources = summary.sources || [];
    if (!sources.length) {
      const tr = el('tr');
      const td = el('td', 'muted', '还没有任何数据源，先在扩展里完成一次同步');
      td.colSpan = 5;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    sources.forEach((src) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, KIND_LABEL[src.kind] || src.kind));
      tr.appendChild(el('td', null, fmtRows(src.rows)));
      tr.appendChild(el('td', null, fmtTime(src.last_success_at)));
      tr.appendChild(el('td', null, fmtTime(src.last_business_at)));
      const td = el('td');
      td.appendChild(el('span', 'pill ' + src.status, STATUS_LABEL[src.status] || src.status));
      if (src.status === 'stale' && src.age_hours) td.appendChild(el('span', 'muted', ' ' + src.age_hours + ' 小时前'));
      tr.appendChild(td);
      body.appendChild(tr);
    });
  }

  function renderRecent(summary) {
    const body = $('recent').querySelector('tbody');
    body.textContent = '';
    const recent = summary.recent || [];
    if (!recent.length) {
      const tr = el('tr');
      const td = el('td', 'muted', '还没有已提交的导入批次。');
      td.colSpan = 4;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    recent.forEach((batch) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, String(batch.id || '').slice(0, 8)));
      tr.appendChild(el('td', null, KIND_LABEL[batch.kind] || batch.kind));
      tr.appendChild(el('td', null, fmtRows(batch.rows)));
      tr.appendChild(el('td', null, fmtTime(batch.committed_at)));
      body.appendChild(tr);
    });
  }

  async function load() {
    const payload = await api('/api/overview');
    const summary = payload.summary || {};
    const identity = (payload.home && payload.home.identity) || null;
    $('seller').textContent = '店铺 · ' + (payload.seller_id || '—');
    $('updated').textContent = '更新于 ' + fmtTime(payload.generated_at);
    renderBriefing(summary, identity);
    renderKpis(summary, identity);
    renderIdentity(identity);
    renderGaps(summary);
    renderSources(summary);
    renderRecent(summary);
  }

  mount(load);
})();
