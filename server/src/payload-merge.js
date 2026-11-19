'use strict';

// 云端采集器只有询盘列表字段，没有客户补全（买家等级/公司/联系方式等）。
// 这类批次入库时按「非空覆盖」合并：已有规范字段不被空值冲掉，采集器的新值仍能更新。

function isBlank(v) {
  if (v === undefined || v === null) return true;
  const s = String(v).trim();
  return s === '' || s === '-' || s === 'NA' || s === 'N/A';
}

function mergePayload(prev, incoming) {
  const out = Object.assign({}, prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {});
  const src = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  Object.keys(src).forEach((k) => {
    if (!isBlank(src[k])) out[k] = src[k];
  });
  return out;
}

module.exports = { isBlank, mergePayload };
