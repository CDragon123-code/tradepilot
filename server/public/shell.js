'use strict';

(() => {
  document.body.classList.add('with-rail');
  const current = location.pathname;
  const nav = document.createElement('nav');
  nav.className = 'app-rail';
  nav.setAttribute('aria-label', '云端工作台导航');
  const brand = document.createElement('a');
  brand.className = 'rail-brand';
  brand.href = '/';
  brand.innerHTML = '<span class="rail-logo" aria-hidden="true">贸</span><span><strong>外贸数据中台</strong><small>TradePilot · 云端数据与能力</small></span>';
  nav.appendChild(brand);
  const label = document.createElement('div');
  label.className = 'rail-label';
  label.textContent = '工作空间';
  nav.appendChild(label);
  const links = document.createElement('div');
  links.className = 'rail-links';
  [
    ['/', '01', '数据总览'],
    ['/business', '02', '经营总览'],
    ['/data-assets', '03', '数据资产'],
    ['/master-data', '04', '主数据'],
    ['/data-quality', '05', '数据质量'],
    ['/agents', '06', 'AI 智能体'],
    ['/admin', '07', 'API 与权限'],
  ].forEach(([href, icon, name]) => {
    const a = document.createElement('a');
    a.href = href;
    if (current === href || (href === '/' && (current === '/dashboard'))) a.setAttribute('aria-current', 'page');
    const badge = document.createElement('span');
    badge.className = 'rail-icon'; badge.setAttribute('aria-hidden', 'true'); badge.textContent = icon;
    a.appendChild(badge);
    a.appendChild(document.createTextNode(name));
    links.appendChild(a);
  });
  nav.appendChild(links);
  const foot = document.createElement('div');
  foot.className = 'rail-foot';
  foot.innerHTML = '<strong>数据中台 · 经营总览</strong><span>经营与运营状态已上线，接入同步 / 系统设置将在后续上线</span>';
  nav.appendChild(foot);
  document.body.prepend(nav);
})();
