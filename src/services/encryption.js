'use strict';

const crypto = require('crypto');
const ALGO   = 'aes-256-gcm';

function getKey() {
  const hex = process.env.AES_256_KEY;
  if (!hex || hex.startsWith('CHANGE_ME') || hex.length !== 64) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('AES_256_KEY must be a 64-character hex string. Generate: openssl rand -hex 32');
    }
    // Dev-only deterministic key — logs a warning but never crashes startup
    console.warn('[ENCRYPTION] WARNING: Using dev AES key. Set AES_256_KEY before deploying.');
    return Buffer.alloc(32, 0);
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const key    = getKey();
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc    = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(stored) {
  if (!stored) return null;
  try {
    const [ivHex, tagHex, ctHex] = stored.split(':');
    const key     = getKey();
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(ctHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };
