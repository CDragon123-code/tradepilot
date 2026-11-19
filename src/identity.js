// 客户身份统一层：把询盘、我的客户、公海客户、聊天会话归并到同一个客户档案
// 原则：强标识优先（客户ID/邮箱/登录名），公司名作为次强标识，姓名只做别名不做合并依据
(function () {
  'use strict';

  // 通用空值（不包含 NA：NA 也是纳米比亚的国家代码，只在公司名字段按占位处理）
  const PLACEHOLDERS = new Set(['n/a', 'none', 'null', 'undefined', 'unknown', '-', '无', '未填写', '暂无', '未提供', '不适用']);
  const isBlankValue = (v) => {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!s || s === '-') return true;
    if (/[*?]/.test(s) && /@/.test(s)) return true;   // 脱敏邮箱（p***7@gmail.com）不能当身份依据
    const low = s.toLowerCase().replace(/[\s\u3000]+/g, ' ');
    if (low === 'username') return true;
    return PLACEHOLDERS.has(low);
  };
  // 平台自动生成的占位公司名：NA / nocompany / NoCompanyName_170005796245 / Pas dentreprise_... / NA_...
  const isPlaceholderCompany = (v) => {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!s || s === '-') return true;
    const low = s.toLowerCase().replace(/[\s\u3000]+/g, ' ');
    if (/^(?:n\/?a|no ?company(?: ?name)?|pas d['’]?entreprise|b2b ?company)(?:_[0-9]+)?$/.test(low)) return true;
    return isBlankValue(s);
  };
  const fold = (v) => String(v === undefined || v === null ? '' : v)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');   // é/ñ 等变音符号折叠，避免同名不同写法漏匹配
  const norm = (v) => fold(v)
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,，。:：;；'"“”‘’!！?？()（）[\]【】{}<>《》/\\|&·\-_+*#@]/g, '')
    .trim();
  const emailOf = (v) => {
    const s = fold(v).trim();
    if (!s || /[*?]/.test(s)) return '';   // 脱敏邮箱直接忽略，禁止截取局部（p***7@gmail.com ≠ 7@gmail.com）
    const m = s.match(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/);
    return m ? m[0] : '';
  };
  const phoneOf = (v) => String(v === undefined || v === null ? '' : v).replace(/\D/g, '');
  const pick = (o, keys) => {
    for (const k of keys) {
      const v = o ? o[k] : '';
      if (v !== undefined && v !== null && !isBlankValue(v)) return String(v).trim();
    }
    return '';
  };
  const pickCompany = (o) => {
    const v = pick(o, ['公司名称', 'companyName']);
    return v && !isPlaceholderCompany(v) ? v : '';
  };
  // 姓名词序无关键：Vincenzo Cerbone / Cerbone Vincenzo、Fernando NunezCamelino / Nunez Camelino 都能对上
  const tokenKeyOf = (v) => {
    const t = fold(v).match(/[a-z0-9]{2,}/g) || [];
    if (t.length < 2 || t.length > 4) return '';
    return t.slice().sort().join('');
  };

  // 从客户行提取强标识
  function customerKeys(c) {
    const out = [];
    const cid = pick(c, ['客户ID', 'customerId']);
    if (cid) out.push('cid:' + cid);
    const em = emailOf(pick(c, ['邮箱', '电子邮件', 'email']));
    if (em) out.push('email:' + em);
    const login = norm(pick(c, ['登录名', '客户登录名', 'AliID', '旺旺', '参考ID', 'loginId']));
    if (login) out.push('login:' + login);
    const company = norm(pickCompany(c));
    if (company && company.length >= 3) out.push('company:' + company);
    return out;
  }

  function makeProfile(uid, display, source) {
    return {
      uid: uid,
      display: display || '未命名客户',
      company: '',
      country: '',
      aliases: new Set(),
      aliasList: [],
      customerIds: [],
      inquiryIds: [],
      chatSessions: [],
      sources: new Set(source ? [source] : []),
      mineCount: 0,
      publicCount: 0,
      primaryCustomer: null,
      chatCount: 0,
      lastChat: '',
    };
  }

  function addAlias(p, v, isCompany) {
    const raw = String(v === undefined || v === null ? '' : v).trim();
    if (!raw || /[*?]/.test(raw) || isBlankValue(raw)) return;   // 脱敏值/占位值不作别名
    if (isCompany && isPlaceholderCompany(raw)) return;
    const s = norm(raw);
    if (!s || s.length < 2 || p.aliases.has(s)) return;
    p.aliases.add(s);
    p.aliasList.push(raw);
  }

  function profileFromCustomer(row, source, uid) {
    const cid = pick(row, ['客户ID', 'customerId']);
    const p = makeProfile(uid || ('crm:' + (cid || norm(pickCompany(row) || pick(row, ['联系人'])))), '', source);
    p.company = pickCompany(row);
    p.country = pick(row, ['国家/地区', '国家', 'countryCode', '国家地区']);
    p.display = pick(row, ['联系人']) || pickCompany(row) || pick(row, ['登录名', '客户ID']) || '未命名客户';
    if (source === 'mine') p.primaryCustomer = row;
    if (cid) p.customerIds.push(cid);
    ['公司名称', '联系人', '登录名', '客户登录名', 'AliID', '旺旺', '邮箱', '电子邮件']
      .forEach((k) => addAlias(p, row[k], k === '公司名称'));
    return p;
  }

  function mergeProfiles(a, b) {
    // 保留先创建的档案作为主档案（我的客户优先）
    if (!a) return b;
    if (!b || a === b) return a;
    if (b.mineCount > a.mineCount) { const t = a; a = b; b = t; }
    b.customerIds.forEach((id) => { if (a.customerIds.indexOf(id) < 0) a.customerIds.push(id); });
    b.aliases.forEach((s) => { if (!a.aliases.has(s)) a.aliases.add(s); });
    b.aliasList.forEach((s) => { if (a.aliasList.indexOf(s) < 0) a.aliasList.push(s); });
    b.chatSessions.forEach((s) => { if (a.chatSessions.indexOf(s) < 0) a.chatSessions.push(s); });
    b.sources.forEach((s) => a.sources.add(s));
    a.mineCount += b.mineCount;
    a.publicCount += b.publicCount;
    a.chatCount += b.chatCount;
    if (!a.primaryCustomer && b.primaryCustomer) a.primaryCustomer = b.primaryCustomer;
    if (!a.company && b.company) a.company = b.company;
    if (!a.country && b.country) a.country = b.country;
    if (a.display === '未命名客户' && b.display) a.display = b.display;
    if (!a.lastChat || (b.lastChat && b.lastChat > a.lastChat)) a.lastChat = b.lastChat;
    return a;
  }

  function build(data) {
    const mine = data.customer || [];
    const pub = data.public_customer || [];
    const inv = data.inquiry || [];
    const chats = data.chat || [];

    const profiles = [];
    const keyMap = new Map();      // strong key -> profile
    const aliasMap = new Map();    // normalized alias -> Set(profile)
    const tokenMap = new Map();    // 排序词集 -> Set(profile)，用于词序/空格差异
    const crmNameMap = new Map();  // 我的客户/公海客户 联系人/公司 -> Set(profile)
    const customerUidById = new Map();  // 客户ID -> profile（保证同步到 MCP 时同一客户拿到同一 UID）

    const registerAliases = (p) => {
      p.aliases.forEach((s) => {
        let set = aliasMap.get(s);
        if (!set) { set = new Set(); aliasMap.set(s, set); }
        set.add(p);
      });
      p.aliasList.forEach((raw) => {
        const tk = tokenKeyOf(raw);
        if (!tk) return;
        let set = tokenMap.get(tk);
        if (!set) { set = new Set(); tokenMap.set(tk, set); }
        set.add(p);
      });
    };

    const rebind = (oldP, newP) => {
      keyMap.forEach((v, k) => { if (v === oldP) keyMap.set(k, newP); });
      customerUidById.forEach((v, k) => { if (v === oldP) customerUidById.set(k, newP); });
      [aliasMap, tokenMap, crmNameMap].forEach((map) => {
        map.forEach((set) => {
          if (set.has(oldP)) { set.delete(oldP); set.add(newP); }
        });
      });
    };

    const upsertCustomer = (row, source) => {
      const keys = customerKeys(row);
      const hits = [];
      keys.forEach((k) => { const p = keyMap.get(k); if (p && hits.indexOf(p) < 0) hits.push(p); });
      let p = hits.length ? hits[0] : profileFromCustomer(row, source);
      hits.slice(1).forEach((other) => {
        const merged = mergeProfiles(p, other);
        if (merged !== p) rebind(p, merged);
        rebind(other, merged);
        p = merged;
      });
      profiles.push(p);
      keys.forEach((k) => keyMap.set(k, p));
      if (source === 'mine') {
        p.mineCount += 1;
        p.primaryCustomer = row;
        p.sources.add('mine');
      } else {
        p.publicCount += 1;
        if (!p.primaryCustomer) p.primaryCustomer = row;
        p.sources.add('public');
      }
      const cid = pick(row, ['客户ID', 'customerId']);
      if (cid && p.customerIds.indexOf(cid) < 0) p.customerIds.push(cid);
      if (cid) customerUidById.set(cid, p);
      ['公司名称', '联系人', '登录名', '客户登录名', 'AliID', '旺旺', '邮箱', '电子邮件']
        .forEach((k) => addAlias(p, row[k], k === '公司名称'));
      ['联系人', '公司名称'].forEach((k) => {
        const s = norm(k === '公司名称' ? pickCompany(row) : pick(row, [k]));
        if (!s || s.length < 2) return;
        let set = crmNameMap.get(s);
        if (!set) { set = new Set(); crmNameMap.set(s, set); }
        set.add(p);
      });
      registerAliases(p);
      return p;
    };

    // 先我的客户，再公海：主档案优先保留我的客户
    mine.forEach((c) => upsertCustomer(c, 'mine'));
    pub.forEach((c) => upsertCustomer(c, 'public'));

    const uniqueProfiles = () => {
      const seen = new Set();
      for (let i = profiles.length - 1; i >= 0; i--) {
        const p = profiles[i];
        if (!p || seen.has(p)) profiles.splice(i, 1); else seen.add(p);
      }
    };
    uniqueProfiles();

    const findCustomerProfile = (x) => {
      const em = emailOf(pick(x, ['电子邮件', '邮箱', 'email']));
      if (em && keyMap.get('email:' + em)) return keyMap.get('email:' + em);
      const company = norm(pickCompany(x));
      if (company && keyMap.get('company:' + company)) return keyMap.get('company:' + company);
      const cid = pick(x, ['客户ID', 'customerId']);
      if (cid && keyMap.get('cid:' + cid)) return keyMap.get('cid:' + cid);
      return null;
    };

    // 询盘无强标识时：联系人姓名在客户库中唯一、且公司/国家不冲突，才并入客户档案
    const findCrmByName = (x) => {
      const contact = norm(pick(x, ['客户名称']));
      if (!contact) return null;
      const set = crmNameMap.get(contact);
      if (!set || set.size !== 1) return null;
      const p = Array.from(set)[0];
      const company = norm(pickCompany(x));
      const pc = norm(p.company);
      if (company && pc && company !== pc && !(tokenKeyOf(company) && tokenKeyOf(company) === tokenKeyOf(pc))) return null;
      const c1 = norm(pick(x, ['国家']));
      const c2 = norm(pick(p.primaryCustomer, ['国家/地区', '国家']));
      if (c1 && c2 && c1 !== c2) return null;
      return p;
    };

    // 询盘归并
    const invProfiles = new Map();
    const invProfileById = new Map();
    inv.forEach((x) => {
      let p = findCustomerProfile(x);
      let groupKey = '';
      if (!p) {
        const company = norm(pickCompany(x));
        const contact = norm(pick(x, ['客户名称']));
        // 公司名缺失/占位（NA、nocompany）时按联系人归并，避免所有无公司询盘塌缩成同一档案
        groupKey = company || contact || String(pick(x, ['询盘ID']));
        p = invProfiles.get(groupKey) || findCrmByName(x);
        if (!p) {
          p = makeProfile('inv:' + groupKey, pick(x, ['客户名称']) || pickCompany(x) || '未命名客户', 'inquiry');
          profiles.push(p);
        }
        invProfiles.set(groupKey, p);
      }
      const iid = pick(x, ['询盘ID']);
      if (iid && p.inquiryIds.indexOf(iid) < 0) p.inquiryIds.push(iid);
      if (iid) invProfileById.set(String(iid), p);
      ['客户名称', '公司名称', '电子邮件'].forEach((k) => addAlias(p, x[k], k === '公司名称'));
      if (!p.company) p.company = pickCompany(x);
      if (!p.country) p.country = pick(x, ['国家']);
      p.sources.add('inquiry');
      registerAliases(p);
    });
    uniqueProfiles();

    // 会话名/客户名匹配：精确别名 → 词序无关词集 → 包含关系（均要求唯一命中，歧义不猜）
    // 同名命中多个档案时，若其中只有一个「我的客户/公海客户」档案，优先认它，避免把会话判成陌生人
    const uniqueCrm = (set) => {
      if (!set) return null;
      if (set.size === 1) return Array.from(set)[0];
      const crm = Array.from(set).filter((p) => p.customerIds.length > 0);
      return crm.length === 1 ? crm[0] : null;
    };
    const matchName = (name) => {
      const q = norm(name);
      if (!q) return null;
      const exact = aliasMap.get(q);
      if (exact) return uniqueCrm(exact);
      const tk = tokenKeyOf(name);
      if (tk) {
        const set = tokenMap.get(tk);
        if (set) return uniqueCrm(set);
      }
      if (q.length < 5) return null;
      const cands = new Set();
      profiles.forEach((p) => {
        p.aliases.forEach((a) => {
          if (a.length >= 5 && (q.indexOf(a) >= 0 || a.indexOf(q) >= 0)) cands.add(p);
        });
      });
      return uniqueCrm(cands);
    };

    // 聊天会话：先按会话名聚合，再匹配档案
    const sessionMap = new Map();  // norm(session) -> {name,count,last}
    chats.forEach((m) => {
      const name = pick(m, ['会话']);
      if (!name) return;
      const k = norm(name);
      const s = sessionMap.get(k) || { k: k, name: name, count: 0, last: '' };
      s.count += 1;
      const t = pick(m, ['发送时间']);
      if (t && t > s.last) s.last = t;
      sessionMap.set(k, s);
    });
    const chatOnly = [];
    const sessionProfile = new Map();   // norm(session) -> profile
    sessionMap.forEach((s) => {
      let p = matchName(s.name);
      const isNew = !p;
      if (isNew) {
        // 未匹配到客户/询盘的会话只作为弱证据：留在 chatOnly，不进入客户档案，也不注册全局别名
        p = makeProfile('chat:' + s.k, s.name, 'chat');
        chatOnly.push(p);
      }
      sessionProfile.set(s.k, p);
      if (p.chatSessions.indexOf(s.name) < 0) p.chatSessions.push(s.name);
      p.chatCount += s.count;
      if (s.last && s.last > p.lastChat) p.lastChat = s.last;
      addAlias(p, s.name);
      p.sources.add('chat');
      if (!isNew) registerAliases(p);
    });

    uniqueProfiles();

    const byUid = new Map();
    profiles.forEach((p) => byUid.set(p.uid, p));

    const lookup = matchName;

    const uidOfName = (name) => {
      const p = lookup(name);
      return p ? p.uid : ('name:' + norm(name));
    };
    const uidOfInquiry = (x) => {
      const iid = pick(x, ['询盘ID']);
      if (iid && invProfileById.has(String(iid))) return invProfileById.get(String(iid)).uid;
      const p = findCustomerProfile(x) || lookup(pick(x, ['客户名称']) || pickCompany(x));
      return p ? p.uid : ('inv:' + (norm(pickCompany(x)) || norm(pick(x, ['客户名称'])) || iid));
    };
    const uidOfCustomer = (row) => {
      const cid = pick(row, ['客户ID', 'customerId']);
      if (cid && customerUidById.has(cid)) return customerUidById.get(cid).uid;
      for (const k of customerKeys(row)) {
        const p = keyMap.get(k);
        if (p) return p.uid;
      }
      return 'name:' + (norm(pickCompany(row)) || norm(pick(row, ['联系人', '客户ID'])));
    };
    const customerRowOf = (name) => {
      const p = lookup(name);
      return p ? p.primaryCustomer : null;
    };

    const duplicateGroups = profiles.filter((p) => p.customerIds.length > 1 || (p.mineCount && p.publicCount));
    const linkedInv = inv.filter((x) => {
      const iid = pick(x, ['询盘ID']);
      const p = iid ? invProfileById.get(String(iid)) : findCustomerProfile(x);
      return !!(p && p.customerIds.length);
    }).length;
    const chatOnlySet = new Set(chatOnly);
    let linkedChatSessions = 0;      // 能对上客户档案 / 询盘档案
    let linkedChatSessionsCrm = 0;   // 能对上「我的客户/公海客户」档案
    sessionMap.forEach((s) => {
      const p = sessionProfile.get(s.k);
      if (!p || chatOnlySet.has(p)) return;
      linkedChatSessions += 1;
      if (p.customerIds.length) linkedChatSessionsCrm += 1;
    });

    return {
      profiles: profiles,
      byUid: byUid,
      lookup: lookup,
      uidOfName: uidOfName,
      uidOfInquiry: uidOfInquiry,
      uidOfCustomer: uidOfCustomer,
      customerRowOf: customerRowOf,
      duplicateGroups: duplicateGroups,
      chatOnly: chatOnly,
      stats: {
        profiles: profiles.length,
        customers: mine.length + pub.length,
        duplicateGroups: duplicateGroups.length,
        linkedInquiries: linkedInv,
        inquiries: inv.length,
        chatSessions: sessionMap.size,
        linkedChatSessions: linkedChatSessions,
        linkedChatSessionsCrm: linkedChatSessionsCrm,
        chatMessages: chats.length,
        aliases: profiles.reduce((n, p) => n + p.aliases.size, 0),
      },
    };
  }

  const api = { build, normalize: norm, emailOf: emailOf, phoneOf: phoneOf };
  if (typeof self !== 'undefined') self.AliIdentity = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
