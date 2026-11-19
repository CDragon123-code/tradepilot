'use strict';

// 领域模块加载器：复用扩展里已验证的纯逻辑（无 DOM / 无 chrome API）
// 查找顺序：环境变量 → 镜像内 domain-src → 本地仓库扩展 src/
const fs = require('node:fs');
const path = require('node:path');

let cached = null;

function candidates() {
  return [
    process.env.DOMAIN_SRC,
    path.join(__dirname, '..', 'domain-src'),
    path.join(__dirname, '..', '..', 'src'),
  ].filter(Boolean);
}

function loadDomain() {
  if (cached) return cached;
  const dir = candidates().find((d) => fs.existsSync(path.join(d, 'data-core.js')));
  if (!dir) throw new Error('未找到领域模块目录（缺少 data-core.js）');
  if (typeof global.self === 'undefined') global.self = {};
  const dataCore = require(path.join(dir, 'data-core.js'));
  global.self.AliDataCore = dataCore;
  const identity = require(path.join(dir, 'identity.js'));
  global.self.AliIdentity = identity;
  const analyze = require(path.join(dir, 'analyze.js'));
  const importMap = require(path.join(dir, 'import-map.js'));
  const customerProfile = require(path.join(dir, 'customer-profile.js'));
  const dify = require(path.join(dir, 'dify.js'));
  global.self.AliAnalyze = analyze;
  global.self.AliImportMap = importMap;
  global.self.AliCustomerProfile = customerProfile;
  global.self.AliDify = dify;
  cached = { dir: dir, dataCore: dataCore, identity: identity, analyze: analyze, importMap: importMap, customerProfile: customerProfile, dify: dify };
  return cached;
}

module.exports = { loadDomain };
