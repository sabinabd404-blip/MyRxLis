/**
 * Password hashing (scrypt) and opaque bearer tokens.
 *
 * Tokens and API keys are long random strings; only their SHA-256 hash is
 * stored, so a database leak does not leak working credentials.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

const N = 2 ** 15, R = 8, P = 1, KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/** Hash a password as `scrypt$N$r$p$salt$hash` (base64url parts). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Check a password against a stored hash in constant time. A missing or malformed hash never matches. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = (stored ?? DUMMY_HASH).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64 = '', keyB64 = ''] = parts;
  const expected = Buffer.from(keyB64, 'base64url');
  if (expected.length < 16) return false;
  try {
    const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
    return stored !== null && timingSafeEqual(key, expected);
  } catch {
    return false; // unusable parameters
  }
}

// Used when the account does not exist, so a wrong username takes as long as a wrong password.
const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(KEYLEN).toString('base64url')}`;

export const hashToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/** A staff session token: `mrxs_<43 chars>`. */
export const newSessionToken = (): string => `mrxs_${randomBytes(32).toString('base64url')}`;

/** A DX API key: `mrxk_<8-char id>_<43-char secret>`; the `mrxk_<id>` part is safe to display. */
export function newApiKey(): { key: string; prefix: string } {
  const prefix = `mrxk_${randomBytes(6).toString('base64url')}`;
  return { key: `${prefix}_${randomBytes(32).toString('base64url')}`, prefix };
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m?.[1] ?? null;
}
