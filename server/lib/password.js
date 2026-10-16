import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hashHex] = String(stored ?? '').split(':');
  if (!salt || !hashHex) return false;

  const hash = await scryptAsync(password, salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  // timingSafeEqual throws on a length mismatch (corrupt stored hash)
  return expected.length === hash.length && timingSafeEqual(hash, expected);
}
