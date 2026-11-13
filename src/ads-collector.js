// 直通车报告采集：在 i.alibaba.com/ads/* 页面内自动设置时间范围、切换报表并导出，
// 再由看板读取「下载中心」拿到 xlsx。仅操作当前登录账号自己的后台页面。
(function () {
  'use strict';
  // 同一页面只注册一次：扩展重载后由看板补注入时，避免重复监听导致响应冲突
  if (self.__ALI_ADS_COLLECTOR__) return;
  self.__ALI_ADS_COLLECTOR__ = true;

  const MONTHS = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  const LABELS = { account: '账户概览', plan: '计划', product: '商品', geo: '账户分地域', term: '搜索词' };
  // 下载中心记录标题不一定与页签同名（如「账户报告」），按别名匹配，避免误取其它报表
  const LABEL_RE = {
    account: /账户概览|账户报告/,
    plan: /计划/,
    product: /商品/,
    geo: /账户分地域|地域分布/,
    term: /搜索词/,
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findButton(text, exact) {
    const list = document.querySelectorAll('button');
    for (let i = 0; i < list.length; i += 1) {
      const t = (list[i].textContent || '').trim();
      if (exact ? t === text : t.indexOf(text) >= 0) return list[i];
    }
    return null;
  }

  function findTab(text) {
    const list = document.querySelectorAll('[role="tab"], .next-tabs-tab, [class*="tab"]');
    for (let i = 0; i < list.length; i += 1) {
      const t = (list[i].textContent || '').trim();
      if (t === text) return list[i];
    }
    return findButton(text, true);
  }

  function click(el) {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.click();
    return true;
  }

  function dateInput() {
    const list = document.querySelectorAll('input');
    for (let i = 0; i < list.length; i += 1) {
      if (String(list[i].value || '').indexOf(' - ') > 0) return list[i];
    }
    return null;
  }

  function currentRange() {
    const el = dateInput();
    return el ? String(el.value || '') : '';
  }

  function monthIndex(label, year) {
    const m = MONTHS.indexOf(label);
    if (m < 0 || !year) return null;
    return Number(year) * 12 + m;
  }

  function pickerState() {
    const months = [];
    const years = [];
    const list = document.querySelectorAll('button.next-calendar-btn');
    for (let i = 0; i < list.length; i += 1) {
      const t = (list[i].textContent || '').trim();
      if (MONTHS.indexOf(t) >= 0) months.push(t);
      else if (/^\d{4}$/.test(t)) years.push(t);
    }
    if (!months.length || !years.length) return null;
    return { first: monthIndex(months[0], years[0]), second: monthIndex(months[1], years[1]) };
  }

  async function openPicker() {
    const input = dateInput();
    if (!input) throw new Error('未找到日期范围输入框');
    click(input);
    for (let i = 0; i < 10; i += 1) {
      if (pickerState()) return true;
      await sleep(200);
    }
    throw new Error('日期选择面板未打开');
  }

  async function gotoMonth(target) {
    for (let i = 0; i < 24; i += 1) {
      const st = pickerState();
      if (!st) throw new Error('日期面板状态异常');
      if (st.first === target) return true;
      const dir = st.first < target ? '.next-calendar-btn-next-month' : '.next-calendar-btn-prev-month';
      const btn = document.querySelector(dir);
      if (!btn) throw new Error('月份切换按钮缺失');
      btn.click();
      await sleep(150);
    }
    throw new Error('月份切换超限');
  }

  async function clickDay(day) {
    const grid = document.querySelectorAll('[role="grid"]')[0];
    if (!grid) throw new Error('日历网格缺失');
    const cells = grid.querySelectorAll('.next-calendar-cell');
    for (let i = 0; i < cells.length; i += 1) {
      const t = (cells[i].textContent || '').trim();
      if (t !== String(day)) continue;
      const cls = String(cells[i].className || '');
      if (cls.indexOf('disabled') >= 0 || cells[i].getAttribute('aria-disabled') === 'true') continue;
      cells[i].click();
      return true;
    }
    throw new Error('未找到可点击的日期：' + day);
  }

  async function setRange(start, end) {
    await openPicker();
    // ① 先选「自定义」：会把区间重置为今天~今天，便于一次性选定完整区间
    const opts = document.querySelectorAll('.date-options-item');
    let custom = null;
    for (let i = 0; i < opts.length; i += 1) {
      if ((opts[i].textContent || '').trim() === '自定义') { custom = opts[i]; break; }
    }
    if (!custom) throw new Error('未找到「自定义」选项');
    custom.click();
    // 等面板重置为今天~今天，确认自定义已生效（最多 3 秒，不强制）
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    for (let i = 0; i < 15; i += 1) {
      await sleep(200);
      if (currentRange().indexOf(today) >= 0 && currentRange().indexOf(today + ' - ') >= 0) break;
    }
    const s = start.split('-').map(Number);
    const e = end.split('-').map(Number);
    // ② 先点结束日（早于今天 → 区间变成 结束日~今天）
    await gotoMonth(e[0] * 12 + (e[1] - 1));
    await clickDay(e[2]);
    await sleep(350);
    // ③ 再点开始日（早于当前开始 → 区间变成 开始日~结束日）
    await gotoMonth(s[0] * 12 + (s[1] - 1));
    await clickDay(s[2]);
    await sleep(350);
    const ok = findButton('确定', true);
    if (!ok) throw new Error('未找到确定按钮');
    ok.click();
    for (let i = 0; i < 25; i += 1) {
      const v = currentRange();
      if (v.indexOf(start) >= 0 && v.indexOf(end) >= 0) return v;
      await sleep(200);
    }
    throw new Error('时间范围未生效：' + currentRange());
  }

  async function waitTab(name) {
    for (let i = 0; i < 80; i += 1) {
      const el = findTab(name);
      if (el) return el;
      await sleep(250);
    }
    return null;
  }

  async function selectReport(kind) {
    if (kind === 'geo') {
      const main = await waitTab('账户报告');
      if (!main) throw new Error('报告页未加载出页签（账户报告）');
      click(main);
      await sleep(900);
      const sub = await waitTab('地域分布');
      if (!sub) throw new Error('未找到地域分布子页签');
      sub.click();
      await sleep(1400);
      return;
    }
    const name = { account: '账户报告', plan: '计划报告', product: '商品报告', term: '搜索词报告' }[kind];
    const tab = await waitTab(name);
    if (!tab) throw new Error('报告页未加载出页签（' + name + '），当前页 ' + location.pathname + '，可能是网络慢或未登录');
    tab.click();
    await sleep(1400);
  }

  async function waitTable() {
    for (let i = 0; i < 50; i += 1) {
      const t = document.body.innerText || '';
      if (t.indexOf('详细数据') >= 0 && findButton('导出', true)) return true;
      await sleep(300);
    }
    return false;
  }

  // 页面「数据概览」里的花费，用来判断切区间后数据是否真的刷新（只改输入框不算）
  function summarySpend() {
    const m = (document.body.innerText || '').match(/花费\s*[￥¥]\s*[\d,.]+/);
    return m ? m[0].replace(/\s+/g, '') : '';
  }

  // 选定区间后，等表格/概览真正切到新区间再返回；否则导出会带旧区间生成记录
  async function waitRangeApplied(start, end, beforeSpend) {
    const s = start.replace(/[./]/g, '-');
    let sawStart = false;
    for (let i = 0; i < 40; i += 1) {
      // 明细表里任意一行出现新的开始日，说明查询已按新区间刷新（行首不一定是日期）
      const rows = document.querySelectorAll('table tr');
      for (let j = 0; j < rows.length && j < 30; j += 1) {
        const t = (rows[j].innerText || '').replace(/[./]/g, '-');
        if (t.indexOf(s) >= 0) { sawStart = true; break; }
      }
      const spend = summarySpend();
      const changed = !!beforeSpend && !!spend && spend !== beforeSpend;
      // 表格已到开始日，且概览花费已变化（或等了 10 秒给平台一点缓冲）
      if (sawStart && (changed || i >= 10)) return true;
      await sleep(500);
    }
    return sawStart;
  }

  async function prepare(kind, start, end) {
    await selectReport(kind);
    const ok = await waitTable();
    if (!ok) throw new Error('报表未加载完成（未出现详细数据）');
    // 搜索词报告平台只支持 7 天，不改时间范围
    if (!start || !end) return currentRange();
    // 平台切页签会继承上一次区间：已经是目标区间时直接跳过日历操作（少一步就少一次失败）
    const cur = currentRange();
    if (cur.indexOf(start) >= 0 && cur.indexOf(end) >= 0) {
      await waitTable();
      return cur;
    }
    const beforeSpend = summarySpend();
    const range = await setRange(start, end);
    const applied = await waitRangeApplied(start, end, beforeSpend);
    if (!applied) throw new Error('时间范围未生效：数据未刷新到 ' + start + ' ~ ' + end);
    await waitTable();
    return range;
  }

  /* ---------------- 账户报：直接读页面明细（绕开下载中心排队） ---------------- */
  function readAccountTable() {
    const tables = document.querySelectorAll('table');
    const headers = [];
    for (let i = 0; i < tables.length && !headers.length; i += 1) {
      const ths = tables[i].querySelectorAll('thead th');
      if (ths.length && (ths[0].innerText || '').indexOf('日期') >= 0) {
        for (let j = 0; j < ths.length; j += 1) headers.push((ths[j].innerText || '').trim());
      }
    }
    const body = [];
    for (let i = 0; i < tables.length; i += 1) {
      const rows = tables[i].querySelectorAll('tbody tr');
      for (let j = 0; j < rows.length; j += 1) {
        const cells = rows[j].querySelectorAll('td');
        if (!cells.length) continue;
        const vals = [];
        for (let k = 0; k < cells.length; k += 1) vals.push((cells[k].innerText || '').trim());
        if (/^\d{4}-\d{2}-\d{2}$/.test(vals[0])) body.push(vals);
      }
    }
    return { headers: headers, body: body };
  }

  async function collectAccountByDom(start, end) {
    await selectReport('account');
    if (!(await waitTable())) throw new Error('账户报表明细未加载');
    if (start && end) {
      const beforeSpend = summarySpend();
      await setRange(start, end);
      const applied = await waitRangeApplied(start, end, beforeSpend);
      if (!applied) throw new Error('账户报表区间未生效');
    }
    // 每页 50 条，减少翻页次数
    const sizeBtn = Array.from(document.querySelectorAll('button.next-pagination-size-selector-btn'))
      .find((b) => (b.textContent || '').trim() === '50');
    if (sizeBtn) { sizeBtn.click(); await sleep(1200); }
    const all = [];
    for (let page = 0; page < 20; page += 1) {
      const part = readAccountTable();
      const firstRow = part.body.length ? part.body[0][0] : '';
      if (part.body.length) all.push.apply(all, part.body);
      const next = document.querySelector('button.next-pagination-item.next-next');
      const disabled = !next || next.disabled || String(next.className).indexOf('disabled') >= 0;
      if (disabled) break;
      next.click();
      let changed = false;
      for (let i = 0; i < 20; i += 1) {
        await sleep(300);
        const now = readAccountTable();
        if (now.body.length && now.body[0][0] !== firstRow) { changed = true; break; }
      }
      if (!changed) break;
    }
    const headers = readAccountTable().headers;
    if (!headers.length || !all.length) throw new Error('未能读取账户明细');
    return { headers: headers, body: all, pages: Math.ceil(all.length / 50) };
  }

  async function doExport() {
    const exp = findButton('导出', true);
    if (!exp) throw new Error('未找到导出按钮');
    exp.click();
    return true;
  }

  function base64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  async function newestRecord(kind, start, end, baseline) {
    const label = LABELS[kind];
    const re = LABEL_RE[kind] || new RegExp(label);
    const needRange = !!(start && end);
    const skip = new Set(baseline || []);
    const seen = [];
    let pending = '';
    for (let i = 0; i < 200; i += 1) {
      const rows = document.querySelectorAll('tr');
      for (let j = 0; j < rows.length; j += 1) {
        const txt = (rows[j].innerText || '').replace(/\s+/g, ' ');
        if (!re.test(txt)) continue;
        const a = rows[j].querySelector('a[href]');
        const brief = txt.slice(0, 120);
        // 日期分隔符平台可能用 / 或 .，统一成 - 再比对
        const norm = txt.replace(/[./]/g, '-');
        const rangeOk = !needRange || (norm.indexOf(start) >= 0 && norm.indexOf(end) >= 0);
        if (rangeOk && (txt.indexOf('加载中') >= 0 || txt.indexOf('处理中') >= 0)) pending = brief;
        if (!a || skip.has(a.href)) continue;   // 基线里已有的记录属于上一次导出
        if (!rangeOk) {
          // 前 40 秒只认日期范围；之后只要「新出现」且报表名匹配就接受，避免标题口径不同卡死
          if (i < 80) {
            if (seen.indexOf(brief.slice(0, 80)) < 0) seen.push(brief.slice(0, 80));
            continue;
          }
        }
        return { title: brief, href: a.href };
      }
      // 记录已生成但平台还在处理：等 60 秒仍无下载链接就给可读原因，别让员工等满超时
      if (pending && i >= 120) {
        throw new Error('下载中心记录仍在生成（加载中）：' + pending + '。请稍后重试，其余报表已保留');
      }
      await sleep(500);
    }
    throw new Error('下载中心未生成 ' + label + ' 记录（导出可能未成功或仍在生成）'
      + (seen.length ? '；现有记录：' + seen.slice(0, 3).join(' / ') : '；当前没有匹配该报表的记录'));
  }

  // 下载中心现有记录（给看板做「导出前基线」，避免抓到上一次的旧文件）
  function listRecords() {
    const out = [];
    const rows = document.querySelectorAll('tr');
    for (let i = 0; i < rows.length; i += 1) {
      const a = rows[i].querySelector('a[href]');
      if (!a) continue;
      out.push({ title: (rows[i].innerText || '').replace(/\s+/g, ' ').slice(0, 120), href: a.href });
    }
    return out;
  }

  async function grabAndFetch(kind, start, end, baseline) {
    const rec = await newestRecord(kind, start, end, baseline);
    const res = await fetch(rec.href, { credentials: 'include' });
    if (!res.ok) throw new Error('下载失败：HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    return { ok: true, kind, name: rec.title, base64: base64(buf), size: buf.byteLength };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return undefined;
    const run = async () => {
      if (msg.type === 'adsCollectPing') return { ok: true, page: location.pathname };
      if (msg.type === 'adsCollectList') return { ok: true, rows: listRecords() };
      if (msg.type === 'adsCollectPrepare') return { ok: true, range: await prepare(msg.kind, msg.start, msg.end) };
      if (msg.type === 'adsCollectAccountDom') return Object.assign({ ok: true }, await collectAccountByDom(msg.start, msg.end));
      if (msg.type === 'adsCollectExport') return { ok: await doExport(), range: currentRange() };
      if (msg.type === 'adsCollectGrab') return grabAndFetch(msg.kind, msg.start, msg.end, msg.baseline);
      return { ok: false, error: '未知指令' };
    };
    run().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e && e.message || String(e) }));
    return true;
  });
})();
