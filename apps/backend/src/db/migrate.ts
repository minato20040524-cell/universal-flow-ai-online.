import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { col, type SqlClient } from './sql.js';

const MIGRATION_NAME = /^\d{3}_[a-z0-9_]+\.sql$/;

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

/**
 * Applies pending migrations in name order. Each file is sent as one
 * multi-statement query together with its bookkeeping row; PostgreSQL runs
 * such a query as a single implicit transaction, so a failure leaves nothing behind.
 */
export const migrate = async (sql: SqlClient, directory = DEFAULT_MIGRATIONS_DIR): Promise<string[]> => {
  await sql.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = new Set((await sql.query('SELECT name FROM schema_migrations')).map((row) => col.string(row, 'name')));
  const files = (await readdir(directory)).filter((name) => MIGRATION_NAME.test(name)).sort();
  const newlyApplied: string[] = [];

  for (const name of files) {
    if (applied.has(name)) continue;
    const body = await readFile(`${directory}/${name}`, 'utf8');
    try {
      await sql.query(`${body}\nINSERT INTO schema_migrations (name) VALUES ('${name}');`);
    } catch (error) {
      const nowApplied = await sql.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      // Another instance applied it at the same moment.
      if (nowApplied.length > 0) continue;
      throw new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    newlyApplied.push(name);
  }
  return newlyApplied;
};
