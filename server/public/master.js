'use strict';

// 主数据：重复候选、档案完整度与人工合并 / 取消合并
(() => {
  const { api, fmtTime, fmtRows, el, mount } = window.CloudData;
  const $ = (id) => document.getElementById(id);
  const FILTERS = [['all', '全部档案'], ['duplicates', '重复候选'], ['incomplete', '资料待补']];
  const state = { filter: 'all', q: '', admin: false, data: null };

  function setStatus(message) {
    $('action-status').textContent = message || '';
  }

  function renderKpis(data) {
    const box = $('kpis');
    box.textContent = '';
    const summary = data.summary || {};
    const items = [
      ['客户档案', fmtRows(summary.profiles), '人工合并后的档案数'],
      ['重复候选', fmtRows(summary.duplicate_groups), '公司名 / 联系人相同'],
      ['资料不完整', fmtRows(summary.incomplete), '缺公司/联系人或联系方式'],
      ['未匹配聊天', fmtRows(summary.unlinked_chats), '没有对上客户档案的会话'],
      ['已合并档案', fmtRows(summary.merges), '人工确认的合并关系'],
    ];
    items.forEach(([label, value, hint]) => {
      const card = el('div', 'kpi');
      card.appendChild(el('div', 'k', label));
      card.appendChild(el('div', 'v', String(value)));
      card.appendChild(el('div', 'h', hint));
      box.appendChild(card);
    });
  }

  function renderBriefing(data) {
    const summary = data.summary || {};
    $('briefing-text').textContent = '客户档案 ' + summary.profiles + ' 份，重复候选 '
      + summary.duplicate_groups + ' 组，资料不完整 ' + summary.incomplete + ' 份，未匹配聊天 '
      + summary.unlinked_chats + ' 个；已人工合并 ' + summary.merges + ' 份。';
    const badge = $('master-badge');
    const warn = summary.duplicate_groups > 0 || summary.incomplete > 0;
    badge.className = 'quality-badge' + (warn ? ' warn' : '');
    badge.textContent = summary.duplicate_groups ? summary.duplicate_groups + ' 组重复待确认'
      : summary.merges ? '已合并 ' + summary.merges + ' 份' : '主数据状态正常';
  }

  function memberLine(member) {
    const parts = [];
    if (member.customer_count) parts.push('客户 ' + member.customer_count);
    if (member.inquiry_count) parts.push('询盘 ' + member.inquiry_count);
    if (member.completeness !== undefined) parts.push('完整度 ' + member.completeness + '%');
    return parts.join(' · ') || '暂无关联记录';
  }

  function renderGroups(data) {
    const box = $('groups');
    box.textContent = '';
    const groups = data.duplicate_groups || [];
    $('groups-note').textContent = groups.length
      ? groups.length + ' 组 · 按公司名 / 联系人聚合'
      : '没有发现需要人工确认的重复档案';
    if (!groups.length) {
      box.appendChild(el('p', 'empty-state', '身份归并后没有剩余重复候选；新数据同步后会自动重新计算。'));
      return;
    }
    groups.forEach((group) => {
      const card = el('div', 'group-card');
      const head = el('div', 'group-head');
      head.appendChild(el('strong', null, group.label));
      head.appendChild(el('span', 'count', String(group.members.length)));
      card.appendChild(head);
      group.members.forEach((member) => {
        const row = el('div', 'member-row');
        const info = el('div', 'member-info');
        info.appendChild(el('div', 'member-name', member.name || '未命名客户'));
        info.appendChild(el('div', 'muted', [member.company, member.country].filter(Boolean).join(' · ') || '—'));
        info.appendChild(el('div', 'member-meta', memberLine(member)));
        row.appendChild(info);
        if (state.admin) {
          const button = el('button', 'mini', '以此为主合并其余');
          button.type = 'button';
          button.onclick = () => mergeGroup(group, member.uid);
          row.appendChild(button);
        }
        card.appendChild(row);
      });
      if (!state.admin) card.appendChild(el('p', 'muted', '合并操作仅管理员可执行。'));
      box.appendChild(card);
    });
  }

  function renderProfiles(data) {
    const body = $('profiles').querySelector('tbody');
    body.textContent = '';
    const profiles = data.profiles || [];
    const groupUids = new Set();
    (data.duplicate_groups || []).forEach((group) => group.members.forEach((m) => groupUids.add(m.uid)));
    if (!profiles.length) {
      const tr = el('tr');
      const td = el('td', 'muted', state.q ? '没有匹配的档案。' : '还没有客户档案，先在扩展里同步客户与询盘。');
      td.colSpan = 8;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    profiles.forEach((profile) => {
      const tr = el('tr');
      const name = el('td');
      name.appendChild(el('div', 'member-name', profile.name || '未命名客户'));
      if (profile.company && profile.company !== profile.name) name.appendChild(el('div', 'muted', profile.company));
      tr.appendChild(name);
      tr.appendChild(el('td', null, profile.country || '—'));
      tr.appendChild(el('td', null, profile.level || '—'));
      tr.appendChild(el('td', null, profile.owner || '—'));
      tr.appendChild(el('td', null, '客户 ' + profile.customer_ids.length + ' · 询盘 '
        + profile.inquiry_count + ' · 聊天 ' + profile.chat_count));
      const complete = el('td', 'ratio-cell');
      complete.appendChild(el('span', null, profile.completeness.percent + '%'));
      const bar = el('div', 'bar');
      const fill = el('i');
      fill.style.width = Math.max(0, Math.min(100, profile.completeness.percent)) + '%';
      bar.appendChild(fill);
      complete.appendChild(bar);
      tr.appendChild(complete);
      const tags = el('td', 'tag-cell');
      if (profile.merged_uids.length) tags.appendChild(el('span', 'pill ok', '已合并 ' + profile.merged_uids.length));
      if (groupUids.has(profile.uid)) tags.appendChild(el('span', 'pill stale', '重复候选'));
      if (profile.dnc) tags.appendChild(el('span', 'pill stale', 'DNC'));
      if (!tags.childNodes.length) tags.appendChild(el('span', 'muted', '—'));
      tr.appendChild(tags);
      const actions = el('td', 'tag-cell');
      if (state.admin && profile.merged_uids.length) {
        const button = el('button', 'mini', '取消合并');
        button.type = 'button';
        button.onclick = () => unmergeAll(profile);
        actions.appendChild(button);
      } else {
        actions.appendChild(el('span', 'muted', '—'));
      }
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }

  function renderMerges(data) {
    const body = $('merges').querySelector('tbody');
    body.textContent = '';
    const merges = data.merges || [];
    if (!merges.length) {
      const tr = el('tr');
      const td = el('td', 'muted', '还没有人工合并记录。');
      td.colSpan = 6;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    merges.forEach((merge) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, merge.primary_name || merge.primary_uid));
      tr.appendChild(el('td', null, merge.merged_name || merge.merged_uid));
      tr.appendChild(el('td', 'muted', merge.note || '—'));
      tr.appendChild(el('td', null, merge.actor_id || '—'));
      tr.appendChild(el('td', null, fmtTime(merge.created_at)));
      const actions = el('td');
      if (state.admin && merge.status === 'applied') {
        const button = el('button', 'mini', '取消合并');
        button.type = 'button';
        button.onclick = () => unmergeOne(merge.merged_uid, merge.merged_name);
        actions.appendChild(button);
      } else {
        actions.appendChild(el('span', 'muted', merge.status === 'skipped' ? '已失效' : '—'));
      }
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }

  function renderFilters() {
    const box = $('filter-tabs');
    box.textContent = '';
    FILTERS.forEach(([key, label]) => {
      const button = el('button', 'tab' + (state.filter === key ? ' active' : ''), label);
      button.type = 'button';
      button.onclick = () => {
        if (state.filter === key) return;
        state.filter = key;
        load();
      };
      box.appendChild(button);
    });
  }

  async function mergeGroup(group, primaryUid) {
    if (!state.admin) return;
    const others = group.members.filter((member) => member.uid !== primaryUid);
    if (!others.length) return;
    const primary = group.members.find((member) => member.uid === primaryUid);
    const name = (primary && (primary.name || primary.company)) || primaryUid;
    if (!window.confirm('确认把其余 ' + others.length + ' 份档案并入「' + name + '」？')) return;
    setStatus('正在合并…');
    try {
      for (const member of others) {
        await api('/api/master-data/merge', {
          method: 'POST', body: { primary_uid: primaryUid, merged_uid: member.uid },
        });
      }
      setStatus('已合并 ' + others.length + ' 份档案到「' + name + '」');
      await load();
    } catch (e) {
      setStatus('合并失败：' + e.message);
    }
  }

  async function unmergeOne(mergedUid, name) {
    if (!state.admin) return;
    if (!window.confirm('确认取消合并「' + (name || mergedUid) + '」？')) return;
    setStatus('正在取消合并…');
    try {
      await api('/api/master-data/unmerge', { method: 'POST', body: { merged_uid: mergedUid } });
      setStatus('已取消合并「' + (name || mergedUid) + '」');
      await load();
    } catch (e) {
      setStatus('取消合并失败：' + e.message);
    }
  }

  async function unmergeAll(profile) {
    if (!state.admin) return;
    const name = profile.name || profile.uid;
    if (!window.confirm('确认取消「' + name + '」下全部 ' + profile.merged_uids.length + ' 条合并关系？')) return;
    setStatus('正在取消合并…');
    try {
      for (const uid of profile.merged_uids) {
        await api('/api/master-data/unmerge', { method: 'POST', body: { merged_uid: uid } });
      }
      setStatus('已取消「' + name + '」的合并关系');
      await load();
    } catch (e) {
      setStatus('取消合并失败：' + e.message);
    }
  }

  function exportCsv() {
    const data = state.data || {};
    const profiles = data.profiles || [];
    if (!profiles.length) {
      setStatus('当前列表没有可导出的档案。');
      return;
    }
    const rows = [['uid', '名称', '公司', '国家', '等级', '负责人', '客户记录', '询盘数', '聊天数', '完整度', '缺失字段', '已合并档案']];
    profiles.forEach((profile) => {
      rows.push([
        profile.uid, profile.name, profile.company, profile.country, profile.level, profile.owner,
        profile.customer_ids.join(' / '), profile.inquiry_count, profile.chat_count,
        profile.completeness.percent + '%', profile.completeness.missing.join(' / '),
        profile.merged_uids.join(' / '),
      ]);
    });
    const escape = (value) => '"' + String(value === undefined || value === null ? '' : value)
      .replace(/"/g, '""') + '"';
    const lines = rows.map((row) => row.map(escape).join(','));
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'master-data-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setStatus('已导出 ' + profiles.length + ' 份档案。');
  }

  async function load() {
    const query = '/api/master-data?filter=' + encodeURIComponent(state.filter)
      + '&q=' + encodeURIComponent(state.q) + '&limit=300';
    const [me, data] = await Promise.all([api('/auth/me'), api(query)]);
    state.admin = me.role === 'admin';
    state.data = data;
    $('seller').textContent = '店铺 · ' + (data.seller_id || '—');
    $('updated').textContent = '更新于 ' + fmtTime(data.generated_at);
    renderBriefing(data);
    renderKpis(data);
    renderFilters();
    renderGroups(data);
    renderProfiles(data);
    renderMerges(data);
  }

  function search() {
    state.q = $('search').value.trim();
    load().catch((e) => setStatus('读取失败：' + e.message));
  }

  $('search-go').onclick = search;
  $('search').addEventListener('keydown', (event) => { if (event.key === 'Enter') search(); });
  $('export-profiles').onclick = exportCsv;
  mount(load);
})();
