// AI 配置本地加密：AES-256-GCM。
// 密钥由扩展后台生成并保存在扩展源 IndexedDB（不可导出 CryptoKey），
// chrome.storage.local 只保存密文；内容脚本/扩展页面统一通过后台消息读写。
(function () {
  'use strict';
  const DB_NAME = 'ali_secure_store';
  const STORE = 'keys';
  const KEY_ID = 'ai-config-key';
  const ALG = 'AES-GCM';
  const VERSION = 1;
  const ENC_FLAG = '__ali_enc';

  function isEnvelope(value) {
    return !!(value && typeof value === 'object' && value[ENC_FLAG] === 1
      && value.v === VERSION && value.alg === ALG && value.iv && value.ct);
  }

  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function unb64(text) {
    const bin = atob(String(text || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function aadBytes(aad) {
    return new TextEncoder().encode(String(aad || ''));
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    });
  }

  async function readKey() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY_ID);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('读取密钥失败'));
    });
  }

  async function writeKey(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(key, KEY_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('保存密钥失败'));
      tx.onabort = () => reject(tx.error || new Error('保存密钥被中止'));
    });
  }

  async function getCryptoKey() {
    if (typeof indexedDB === 'undefined' || !crypto || !crypto.subtle) {
      throw new Error('当前环境不支持 AES-GCM 安全存储');
    }
    const existing = await readKey();
    if (existing && existing.type === 'secret') return existing;
    const key = await crypto.subtle.generateKey({ name: ALG, length: 256 }, false, ['encrypt', 'decrypt']);
    await writeKey(key);
    return key;
  }

  async function encryptWithKey(key, plainText, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt(
      { name: ALG, iv: iv, additionalData: aadBytes(aad) },
      key,
      new TextEncoder().encode(String(plainText)),
    );
    return {
      [ENC_FLAG]: 1,
      v: VERSION,
      alg: ALG,
      iv: b64(iv),
      ct: b64(new Uint8Array(cipher)),
    };
  }

  async function decryptWithKey(key, envelope, aad) {
    if (!isEnvelope(envelope)) throw new Error('不是加密配置');
    const plain = await crypto.subtle.decrypt(
      { name: ALG, iv: unb64(envelope.iv), additionalData: aadBytes(aad) },
      key,
      unb64(envelope.ct),
    );
    return new TextDecoder().decode(plain);
  }

  async function encryptJson(value, aad) {
    const key = await getCryptoKey();
    return encryptWithKey(key, JSON.stringify(value), aad);
  }

  async function decryptJson(envelope, aad) {
    const key = await getCryptoKey();
    return JSON.parse(await decryptWithKey(key, envelope, aad));
  }

  const api = {
    isEnvelope: isEnvelope,
    getCryptoKey: getCryptoKey,
    encryptWithKey: encryptWithKey,
    decryptWithKey: decryptWithKey,
    encryptJson: encryptJson,
    decryptJson: decryptJson,
  };
  if (typeof self !== 'undefined') self.AliSecureStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
