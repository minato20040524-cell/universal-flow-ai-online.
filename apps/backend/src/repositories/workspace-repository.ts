import { createHash, randomBytes } from 'node:crypto';
import { EngineError, createId, isRecord } from '@universal-flow/core-engine';
import { col, jsonParam, ts, type SqlClient, type SqlRow } from '../db/sql.js';

export const ROLES = ['viewer', 'editor', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export const roleRank = (role: Role): number => ROLES.indexOf(role);
export const isRole = (value: unknown): value is Role => ROLES.some((role) => role === value);

export type Workspace = { id: string; name: string; createdAt: number };

export type ApiTokenInfo = {
  id: string;
  workspaceId: string;
  name: string;
  role: Role;
  isPlatformAdmin: boolean;
  createdAt: number;
  lastUsedAt: number | undefined;
};

export type AuditEntry = {
  workspaceId: string | undefined;
  actor: string;
  action: string;
  target: string;
  details?: Record<string, unknown>;
};

const TOKEN_PREFIX = 'uf_';

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const toWorkspace = (row: SqlRow): Workspace => ({ id: col.string(row, 'id'), name: col.string(row, 'name'), createdAt: col.epoch(row, 'created_at') });

const toToken = (row: SqlRow): ApiTokenInfo => {
  const role = col.string(row, 'role');
  if (!isRole(role)) throw new EngineError('WORKFLOW', `Unexpected role ${role}`);
  return {
    id: col.string(row, 'id'),
    workspaceId: col.string(row, 'workspace_id'),
    name: col.string(row, 'name'),
    role,
    isPlatformAdmin: col.boolean(row, 'is_platform_admin'),
    createdAt: col.epoch(row, 'created_at'),
    lastUsedAt: col.optionalEpoch(row, 'last_used_at'),
  };
};

export type WorkspaceRepository = {
  createWorkspace: (name: string, now: number) => Promise<Workspace>;
  getWorkspace: (id: string) => Promise<Workspace | undefined>;
  /** Returns the plaintext token exactly once; only its hash is stored. */
  createToken: (input: { workspaceId: string; name: string; role: Role; isPlatformAdmin?: boolean; now: number }) => Promise<{ token: string; info: ApiTokenInfo }>;
  authenticate: (token: string, now: number) => Promise<ApiTokenInfo | undefined>;
  listTokens: (workspaceId: string) => Promise<ApiTokenInfo[]>;
  revokeToken: (workspaceId: string, tokenId: string, now: number) => Promise<void>;
  audit: (entry: AuditEntry, now: number) => Promise<void>;
  listAudit: (workspaceId: string, limit: number) => Promise<(AuditEntry & { id: number; createdAt: number })[]>;
};

export const createPgWorkspaceRepository = (sql: SqlClient): WorkspaceRepository => ({
  createWorkspace: async (name, now) => {
    const [row] = await sql.query('INSERT INTO workspaces (id, name, created_at) VALUES ($1, $2, $3::timestamptz) RETURNING *', [createId('ws'), name, ts(now)]);
    if (!row) throw new EngineError('CONFLICT', 'Workspace could not be created');
    return toWorkspace(row);
  },

  getWorkspace: async (id) => {
    const [row] = await sql.query('SELECT * FROM workspaces WHERE id = $1', [id]);
    return row ? toWorkspace(row) : undefined;
  },

  createToken: async ({ workspaceId, name, role, isPlatformAdmin = false, now }) => {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const [row] = await sql.query(
      `INSERT INTO api_tokens (id, workspace_id, name, token_hash, role, is_platform_admin, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::boolean, $7::timestamptz) RETURNING *`,
      [createId('tok'), workspaceId, name, hashToken(token), role, isPlatformAdmin, ts(now)],
    );
    if (!row) throw new EngineError('CONFLICT', 'Token could not be created');
    return { token, info: toToken(row) };
  },

  authenticate: async (token, now) => {
    if (!token.startsWith(TOKEN_PREFIX)) return undefined;
    const [row] = await sql.query(
      `UPDATE api_tokens SET last_used_at = $2::timestamptz WHERE token_hash = $1 AND revoked_at IS NULL RETURNING *`,
      [hashToken(token), ts(now)],
    );
    return row ? toToken(row) : undefined;
  },

  listTokens: async (workspaceId) =>
    (await sql.query('SELECT * FROM api_tokens WHERE workspace_id = $1 AND revoked_at IS NULL ORDER BY created_at', [workspaceId])).map(toToken),

  revokeToken: async (workspaceId, tokenId, now) => {
    const rows = await sql.query('UPDATE api_tokens SET revoked_at = $3::timestamptz WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING id', [
      workspaceId,
      tokenId,
      ts(now),
    ]);
    if (rows.length === 0) throw new EngineError('NOT_FOUND', `Token ${tokenId} does not exist`);
  },

  audit: async ({ workspaceId, actor, action, target, details = {} }, now) => {
    await sql.query(
      'INSERT INTO audit_log (workspace_id, actor, action, target, details, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz) RETURNING id',
      [workspaceId ?? null, actor, action, target, jsonParam(details), ts(now)],
    );
  },

  listAudit: async (workspaceId, limit) =>
    (await sql.query('SELECT * FROM audit_log WHERE workspace_id = $1 ORDER BY id DESC LIMIT $2::int', [workspaceId, limit])).map((row) => {
      const details = col.json(row, 'details');
      return {
        id: col.number(row, 'id'),
        workspaceId: col.optionalString(row, 'workspace_id'),
        actor: col.string(row, 'actor'),
        action: col.string(row, 'action'),
        target: col.string(row, 'target'),
        details: isRecord(details) ? details : {},
        createdAt: col.epoch(row, 'created_at'),
      };
    }),
});
