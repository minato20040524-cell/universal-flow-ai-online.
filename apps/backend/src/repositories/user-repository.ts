import { createHash, randomBytes } from 'node:crypto';
import { EngineError, createId } from '@universal-flow/core-engine';
import { col, isUniqueViolation, ts, type SqlClient, type SqlRow } from '../db/sql.js';
import { isRole, type Role } from './workspace-repository.js';

export type User = { id: string; email: string; name: string; isPlatformAdmin: boolean; createdAt: number };
export type UserWithHash = User & { passwordHash: string };
export type Membership = { workspaceId: string; workspaceName: string; role: Role };
export type Session = { id: string; userId: string; workspaceId: string; expiresAt: number };

/** A live session joined with its user and the user's role in the session's workspace. */
export type SessionContext = Session & { email: string; name: string; isPlatformAdmin: boolean; role: Role };

const SESSION_TOKEN_PREFIX = 'ufs_';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

const toUser = (row: SqlRow): UserWithHash => ({
  id: col.string(row, 'id'),
  email: col.string(row, 'email'),
  name: col.string(row, 'name'),
  isPlatformAdmin: col.boolean(row, 'is_platform_admin'),
  createdAt: col.epoch(row, 'created_at'),
  passwordHash: col.string(row, 'password_hash'),
});

const publicUser = ({ passwordHash: _hidden, ...user }: UserWithHash): User => user;

const toMembership = (row: SqlRow): Membership => {
  const role = col.string(row, 'role');
  if (!isRole(role)) throw new EngineError('WORKFLOW', `Unexpected role ${role}`);
  return { workspaceId: col.string(row, 'workspace_id'), workspaceName: col.string(row, 'workspace_name'), role };
};

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export type UserRepository = {
  create: (input: { email: string; name: string; passwordHash: string; isPlatformAdmin?: boolean; now: number }) => Promise<User>;
  findByEmail: (email: string) => Promise<UserWithHash | undefined>;
  /** Used to let the very first account in, even when sign-up is closed. */
  count: () => Promise<number>;
  get: (id: string) => Promise<User | undefined>;
  addMembership: (userId: string, workspaceId: string, role: Role, now: number) => Promise<void>;
  memberships: (userId: string) => Promise<Membership[]>;
  /** Returns the plaintext session token once; only its hash is stored. */
  createSession: (input: { userId: string; workspaceId: string; now: number; ttlMs: number }) => Promise<{ token: string; session: Session }>;
  /** Looks up a live session in one query, sliding its last-seen time forward. No membership, no session. */
  resolveSession: (token: string, now: number) => Promise<SessionContext | undefined>;
  switchWorkspace: (sessionId: string, workspaceId: string) => Promise<void>;
  revokeSession: (token: string, now: number) => Promise<void>;
  /** Counts a failed sign-in; returns when the key is locked until, if it now is. */
  recordFailure: (key: string, now: number, policy: { maxFailures: number; windowMs: number; lockMs: number }) => Promise<number | undefined>;
  lockedUntil: (key: string, now: number) => Promise<number | undefined>;
  clearFailures: (key: string) => Promise<void>;
};

export const createPgUserRepository = (sql: SqlClient): UserRepository => ({
  create: async ({ email, name, passwordHash, isPlatformAdmin = false, now }) => {
    try {
      const [row] = await sql.query(
        `INSERT INTO users (id, email, name, password_hash, is_platform_admin, created_at)
         VALUES ($1, $2, $3, $4, $5::boolean, $6::timestamptz) RETURNING *`,
        [createId('usr'), normalizeEmail(email), name, passwordHash, isPlatformAdmin, ts(now)],
      );
      if (!row) throw new EngineError('CONFLICT', 'User could not be created');
      return publicUser(toUser(row));
    } catch (error) {
      if (isUniqueViolation(error)) throw new EngineError('CONFLICT', 'An account with this email already exists');
      throw error;
    }
  },

  count: async () => {
    const [row] = await sql.query('SELECT count(*)::int AS n FROM users', []);
    return row ? col.number(row, 'n') : 0;
  },

  findByEmail: async (email) => {
    const [row] = await sql.query('SELECT * FROM users WHERE email = $1', [normalizeEmail(email)]);
    return row ? toUser(row) : undefined;
  },

  get: async (id) => {
    const [row] = await sql.query('SELECT * FROM users WHERE id = $1', [id]);
    return row ? publicUser(toUser(row)) : undefined;
  },

  addMembership: async (userId, workspaceId, role, now) => {
    await sql.query(
      `INSERT INTO memberships (user_id, workspace_id, role, created_at) VALUES ($1, $2, $3, $4::timestamptz)
       ON CONFLICT (user_id, workspace_id) DO UPDATE SET role = EXCLUDED.role RETURNING user_id`,
      [userId, workspaceId, role, ts(now)],
    );
  },

  memberships: async (userId) =>
    (
      await sql.query(
        `SELECT m.workspace_id, m.role, w.name AS workspace_name FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = $1 ORDER BY m.created_at`,
        [userId],
      )
    ).map(toMembership),

  createSession: async ({ userId, workspaceId, now, ttlMs }) => {
    const token = `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const [row] = await sql.query(
      `INSERT INTO sessions (id, token_hash, user_id, workspace_id, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $6::timestamptz) RETURNING *`,
      [createId('ses'), hash(token), userId, workspaceId, ts(now), ts(now + ttlMs)],
    );
    if (!row) throw new EngineError('CONFLICT', 'Session could not be created');
    return { token, session: { id: col.string(row, 'id'), userId, workspaceId, expiresAt: col.epoch(row, 'expires_at') } };
  },

  resolveSession: async (token, now) => {
    if (!token.startsWith(SESSION_TOKEN_PREFIX)) return undefined;
    const [row] = await sql.query(
      `WITH live AS (
         UPDATE sessions SET last_seen_at = $2::timestamptz
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2::timestamptz RETURNING *
       )
       SELECT live.id, live.user_id, live.workspace_id, live.expires_at, u.email, u.name, u.is_platform_admin, m.role
       FROM live JOIN users u ON u.id = live.user_id
       JOIN memberships m ON m.user_id = live.user_id AND m.workspace_id = live.workspace_id`,
      [hash(token), ts(now)],
    );
    if (!row) return undefined;
    const role = col.string(row, 'role');
    if (!isRole(role)) return undefined;
    return {
      id: col.string(row, 'id'),
      userId: col.string(row, 'user_id'),
      workspaceId: col.string(row, 'workspace_id'),
      expiresAt: col.epoch(row, 'expires_at'),
      email: col.string(row, 'email'),
      name: col.string(row, 'name'),
      isPlatformAdmin: col.boolean(row, 'is_platform_admin'),
      role,
    };
  },

  switchWorkspace: async (sessionId, workspaceId) => {
    await sql.query('UPDATE sessions SET workspace_id = $2 WHERE id = $1 RETURNING id', [sessionId, workspaceId]);
  },

  revokeSession: async (token, now) => {
    await sql.query('UPDATE sessions SET revoked_at = $2::timestamptz WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id', [hash(token), ts(now)]);
  },

  recordFailure: async (key, now, { maxFailures, windowMs, lockMs }) => {
    // A new window starts once the old one is over; the lock engages on the failure that reaches the limit.
    const [row] = await sql.query(
      `INSERT INTO auth_throttle (key, failures, window_started_at) VALUES ($1, 1, $2::timestamptz)
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE WHEN auth_throttle.window_started_at < $2::timestamptz - ($3::int * interval '1 millisecond') THEN 1 ELSE auth_throttle.failures + 1 END,
         window_started_at = CASE WHEN auth_throttle.window_started_at < $2::timestamptz - ($3::int * interval '1 millisecond') THEN $2::timestamptz ELSE auth_throttle.window_started_at END
       RETURNING failures`,
      [key, ts(now), windowMs],
    );
    if (!row || col.number(row, 'failures') < maxFailures) return undefined;
    const lockedUntil = now + lockMs;
    await sql.query('UPDATE auth_throttle SET locked_until = $2::timestamptz, failures = 0, window_started_at = $3::timestamptz WHERE key = $1 RETURNING key', [
      key,
      ts(lockedUntil),
      ts(now),
    ]);
    return lockedUntil;
  },

  lockedUntil: async (key, now) => {
    const [row] = await sql.query('SELECT locked_until FROM auth_throttle WHERE key = $1 AND locked_until > $2::timestamptz', [key, ts(now)]);
    return row ? col.epoch(row, 'locked_until') : undefined;
  },

  clearFailures: async (key) => {
    await sql.query('DELETE FROM auth_throttle WHERE key = $1 RETURNING key', [key]);
  },
});
