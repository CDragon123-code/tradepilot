'use strict';

// 敏感字段封装：AES-256-GCM，主密钥来自环境变量 SECRET_KEY（至少 32 位）
const crypto = require('node:crypto');

function masterKey() {
  const raw = String(process.env.SECRET_KEY || '').trim();
  if (raw.length < 32) throw new Error('缺少 SECRET_KEY（至少 32 位），无法保存第三方密钥');
  return crypto.createHash('sha256').update(raw).digest();
}

function seal(plain) {
  const text = String(plain === undefined || plain === null ? '' : plain);
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return 'v1:' + iv.toString('base64') + ':' + cipher.getAuthTag().toString('base64') + ':' + enc.toString('base64');
}

function open(packed) {
  const raw = String(packed || '');
  if (!raw) return '';
  const parts = raw.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('密钥格式不正确');
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const data = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { seal, open };
