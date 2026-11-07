import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * scrypt password hashes, stored as `scrypt$N$r$p$salt$hash` (base64), so the
 * cost can be raised later and old hashes still verify.
 */

const COST = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

const derive = (password: string, salt: Buffer, cost: { N: number; r: number; p: number }): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { ...cost, maxmem: 128 * cost.N * cost.r * 2 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
};

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

/** Spent on unknown emails so a sign-in takes as long whether or not the account exists. */
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

export const passwordProblem = (password: string): string | undefined => {
  if (password.length < PASSWORD_MIN_LENGTH) return `must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > PASSWORD_MAX_LENGTH) return `must be at most ${PASSWORD_MAX_LENGTH} characters`;
  return undefined;
};
