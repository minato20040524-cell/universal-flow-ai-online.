import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { SqlClient, SqlParam, SqlRow } from '../../src/db/sql.js';

/**
 * Test-only SqlClient that runs every query through the psql CLI against a
 * real PostgreSQL server. Parameters become psql variables (:'p1'), which psql
 * quotes as SQL literals, so the repositories' SQL is exercised unchanged.
 * Each test suite gets its own schema.
 */

export type PsqlOptions = {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
};

const env = (key: string, fallback: string) => process.env[key] ?? fallback;

const escapeVariable = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll("'", "''").replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t');

/**
 * psql prints text, so the harness asks PostgreSQL for JSON instead: the final
 * statement becomes a CTE and its rows are aggregated with json_agg. Statements
 * that already start with WITH get one more CTE appended, because a
 * data-modifying WITH cannot be nested inside another one.
 */
const MAIN_KEYWORD = /\b(select|insert|update|delete)\b/iy;

const findMainStatement = (sql: string): number => {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql.charAt(index);
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0 && index > 0) {
      MAIN_KEYWORD.lastIndex = index;
      if (/\W/.test(sql.charAt(index - 1)) && MAIN_KEYWORD.test(sql)) return index;
    }
  }
  return -1;
};

const asJsonQuery = (sql: string): string => {
  const aggregate = "SELECT coalesce(json_agg(__rows), '[]'::json) FROM __rows";
  if (!/^with\b/i.test(sql)) return `WITH __rows AS (${sql}) ${aggregate}`;
  const main = findMainStatement(sql);
  if (main < 0) throw new Error(`Cannot find the main statement of: ${sql}`);
  return `${sql.slice(0, main).trimEnd()}, __rows AS (${sql.slice(main)}) ${aggregate}`;
};

const runPsql = (args: readonly string[], script: string, password: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('psql', args, { env: { ...process.env, PGPASSWORD: password } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else {
        const sqlState = /ERROR:\s+(.*)/.exec(stderr)?.[1] ?? stderr.trim();
        const error = Object.assign(new Error(`psql: ${sqlState}`), { code: /duplicate key value/.test(stderr) ? '23505' : 'PSQL' });
        reject(error);
      }
    });
    child.stdin.end(script);
  });

export type TestDatabase = SqlClient & { schema: string; drop: () => Promise<void> };

export const createTestDatabase = async (options: PsqlOptions = {}): Promise<TestDatabase> => {
  const host = options.host ?? env('PGHOST', '127.0.0.1');
  const port = options.port ?? Number(env('PGPORT', '5432'));
  const user = options.user ?? env('PGUSER', 'universal');
  const password = options.password ?? env('PGPASSWORD', 'universal');
  const database = options.database ?? env('PGDATABASE', 'universal_test');
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const args = ['-X', '-q', '-A', '-t', '-1', '-v', 'ON_ERROR_STOP=1', '-h', host, '-p', String(port), '-U', user, '-d', database, '-f', '-'];

  const query = async (text: string, params: readonly SqlParam[] = []): Promise<SqlRow[]> => {
    const lines = [`SET search_path TO ${schema};`, "SET TIME ZONE 'UTC';"];
    params.forEach((param, index) => {
      if (param !== null) lines.push(`\\set p${index + 1} '${escapeVariable(String(param))}'`);
    });
    const sql = text.trim().replace(/;\s*$/, '').replace(/\$(\d+)/g, (_match, digits: string) => {
      const index = Number(digits) - 1;
      return params[index] === null ? 'NULL' : `:'p${digits}'`;
    });
    const returnsRows = /^(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql);
    lines.push(returnsRows ? `${asJsonQuery(sql)};` : `${sql};`);
    const output = await runPsql(args, `${lines.join('\n')}\n`, password);
    if (!returnsRows) return [];
    // Only the final statement prints anything (-q -t), and json_agg may span lines.
    const parsed: unknown = JSON.parse(output.trim() || '[]');
    return Array.isArray(parsed) ? parsed : [];
  };

  await runPsql(args, `CREATE SCHEMA ${schema};\n`, password);
  return {
    schema,
    query,
    drop: async () => {
      await runPsql(args, `DROP SCHEMA ${schema} CASCADE;\n`, password);
    },
  };
};
