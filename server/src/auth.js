'use strict';

// 密码与会话：scrypt 哈希（Node 内置，无第三方依赖），会话令牌只存 sha256
const crypto = require('node:crypto');

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const buf = crypto.scryptSync(String(password), salt, PARAMS.keylen, {
    N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: PARAMS.maxmem,
  });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('hex'), buf.toString('hex')].join('$');
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[5], 'hex');
  try {
    const buf = crypto.scryptSync(String(password), Buffer.from(parts[4], 'hex'), expected.length, {
      N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]), maxmem: PARAMS.maxmem,
    });
    return buf.length === expected.length && crypto.timingSafeEqual(buf, expected);
  } catch (e) {
    return false;
  }
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { hashPassword, verifyPassword, newToken, tokenHash };
