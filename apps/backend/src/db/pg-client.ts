import type { SqlClient, SqlParam, SqlRow } from './sql.js';

/**
 * Production driver: node-postgres. It is loaded at runtime so the rest of the
 * backend has no compile-time dependency on it, and is checked before use.
 */

type PgPool = {
  query: (text: string, values?: readonly SqlParam[]) => Promise<{ rows: SqlRow[] }>;
  end: () => Promise<void>;
};

const isPgModule = (value: unknown): value is { default: { Pool: new (config: object) => PgPool } } =>
  typeof value === 'object' &&
  value !== null &&
  'default' in value &&
  typeof value.default === 'object' &&
  value.default !== null &&
  'Pool' in value.default &&
  typeof value.default.Pool === 'function';

export type PgClientOptions = {
  connectionString: string;
  maxConnections?: number;
  ssl?: boolean;
};

export const createPgClient = async ({ connectionString, maxConnections = 10, ssl = false }: PgClientOptions): Promise<SqlClient> => {
  const moduleName = 'pg';
  const loaded: unknown = await import(moduleName);
  if (!isPgModule(loaded)) throw new Error('The "pg" package is missing or has an unexpected shape; run pnpm install');
  const pool = new loaded.default.Pool({
    connectionString,
    max: maxConnections,
    ...(ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  return {
    query: async (text, params = []) => (await pool.query(text, params)).rows,
    close: () => pool.end(),
  };
};
