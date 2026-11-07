import { AUTH_TYPES, EngineError, isStringArray, type AuthType, type EncryptedCredential, type SecretRepository } from '@universal-flow/core-engine';
import { col, jsonParam, optionalTs, ts, type SqlClient, type SqlRow } from '../db/sql.js';

const toAuthType = (value: string): AuthType => {
  const match = AUTH_TYPES.find((type) => type === value);
  if (!match) throw new EngineError('WORKFLOW', `Unexpected auth type "${value}" in database`);
  return match;
};

const toRecord = (row: SqlRow): EncryptedCredential => {
  const fieldNames = col.json(row, 'field_names');
  return {
    id: col.string(row, 'id'),
    workspaceId: col.string(row, 'workspace_id'),
    pluginId: col.string(row, 'plugin_id'),
    authType: toAuthType(col.string(row, 'auth_type')),
    keyId: col.string(row, 'key_id'),
    wrappedKey: col.string(row, 'wrapped_key'),
    iv: col.string(row, 'iv'),
    authTag: col.string(row, 'auth_tag'),
    ciphertext: col.string(row, 'ciphertext'),
    fieldNames: isStringArray(fieldNames) ? fieldNames : [],
    createdAt: col.epoch(row, 'created_at'),
    updatedAt: col.epoch(row, 'updated_at'),
    expiresAt: col.optionalEpoch(row, 'expires_at'),
    errored: col.boolean(row, 'errored'),
  };
};

export const createPgSecretRepository = (sql: SqlClient): SecretRepository => ({
  save: async (record) => {
    await sql.query(
      `INSERT INTO credentials
         (id, workspace_id, plugin_id, auth_type, key_id, wrapped_key, iv, auth_tag, ciphertext, field_names, created_at, updated_at, expires_at, errored)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz, $12::timestamptz, $13::timestamptz, $14::boolean)
       ON CONFLICT (id) DO UPDATE SET
         key_id = EXCLUDED.key_id, wrapped_key = EXCLUDED.wrapped_key, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
         ciphertext = EXCLUDED.ciphertext, field_names = EXCLUDED.field_names, updated_at = EXCLUDED.updated_at,
         expires_at = EXCLUDED.expires_at, errored = EXCLUDED.errored
       RETURNING id`,
      [
        record.id,
        record.workspaceId,
        record.pluginId,
        record.authType,
        record.keyId,
        record.wrappedKey,
        record.iv,
        record.authTag,
        record.ciphertext,
        jsonParam(record.fieldNames),
        ts(record.createdAt),
        ts(record.updatedAt),
        optionalTs(record.expiresAt),
        record.errored,
      ],
    );
  },
  find: async (id) => {
    const [row] = await sql.query('SELECT * FROM credentials WHERE id = $1', [id]);
    return row ? toRecord(row) : undefined;
  },
  delete: async (id) => {
    await sql.query('DELETE FROM credentials WHERE id = $1 RETURNING id', [id]);
  },
  listByWorkspace: async (workspaceId) =>
    (await sql.query('SELECT * FROM credentials WHERE workspace_id = $1 ORDER BY created_at', [workspaceId])).map(toRecord),
});
