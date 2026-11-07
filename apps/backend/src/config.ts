/** Reads and validates environment configuration once, at startup. */

export const PROCESS_ROLES = ['all', 'api', 'worker', 'scheduler'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

export type DatabaseConfig = { databaseUrl: string; databaseSsl: boolean };

export type Config = DatabaseConfig & {
  role: ProcessRole;
  host: string;
  port: number;
  publicBaseUrl: string;
  masterKey: Buffer;
  masterKeyId: string;
  corsOrigins: string[];
  autoMigrate: boolean;
  workerBatchSize: number;
  allowSignup: boolean;
  sessionTtlHours: number;
  trustProxy: boolean;
  webDistDir: string | undefined;
};

type Env = Record<string, string | undefined>;

const problem = (key: string, message: string) => `${key} ${message}`;

const required = (env: Env, key: string, problems: string[]): string => {
  const value = env[key]?.trim();
  if (!value) problems.push(problem(key, 'is required'));
  return value ?? '';
};

const integer = (env: Env, key: string, fallback: number, range: { min: number; max: number }, problems: string[]): number => {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < range.min || value > range.max) problems.push(problem(key, `must be an integer from ${range.min} to ${range.max}`));
  return value;
};

const flag = (env: Env, key: string, fallback: boolean): boolean => {
  const raw = env[key]?.toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
};

const fail = (problems: string[]): never => {
  throw new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);
};

export const loadDatabaseConfig = (env: Env = process.env): DatabaseConfig => {
  const problems: string[] = [];
  const databaseUrl = required(env, 'DATABASE_URL', problems);
  if (problems.length > 0) fail(problems);
  return { databaseUrl, databaseSsl: flag(env, 'DATABASE_SSL', false) };
};

export const loadConfig = (env: Env = process.env): Config => {
  const problems: string[] = [];
  const database = (() => {
    try {
      return loadDatabaseConfig(env);
    } catch (error) {
      problems.push(error instanceof Error ? error.message.replace('Invalid configuration:\n- ', '') : String(error));
      return { databaseUrl: '', databaseSsl: false };
    }
  })();

  const role = PROCESS_ROLES.find((candidate) => candidate === (env.ROLE ?? 'all'));
  if (!role) problems.push(problem('ROLE', `must be one of ${PROCESS_ROLES.join(', ')}`));

  // On Render the service's own https address is known without configuration.
  const publicBaseUrl = env.PUBLIC_BASE_URL?.trim() || env.RENDER_EXTERNAL_URL?.trim() || required(env, 'PUBLIC_BASE_URL', problems);
  if (publicBaseUrl && !/^https?:\/\//.test(publicBaseUrl)) problems.push(problem('PUBLIC_BASE_URL', 'must start with https:// (or http:// for local development)'));

  const masterKeyText = required(env, 'MASTER_KEY', problems);
  const masterKey = Buffer.from(masterKeyText, 'base64');
  if (masterKeyText && masterKey.length !== 32) problems.push(problem('MASTER_KEY', 'must be 32 bytes, base64-encoded (run: node dist/src/cli.js generate-master-key)'));

  const config: Config = {
    ...database,
    role: role ?? 'all',
    host: env.HOST ?? '0.0.0.0',
    port: integer(env, 'PORT', 8080, { min: 1, max: 65_535 }, problems),
    publicBaseUrl,
    masterKey,
    masterKeyId: env.MASTER_KEY_ID ?? 'local-1',
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
    autoMigrate: flag(env, 'AUTO_MIGRATE', false),
    workerBatchSize: integer(env, 'WORKER_BATCH_SIZE', 5, { min: 1, max: 100 }, problems),
    allowSignup: flag(env, 'ALLOW_SIGNUP', true),
    sessionTtlHours: integer(env, 'SESSION_TTL_HOURS', 336, { min: 1, max: 24 * 90 }, problems),
    trustProxy: flag(env, 'TRUST_PROXY', false),
    webDistDir: env.WEB_DIST_DIR?.trim() || undefined,
  };
  if (problems.length > 0) fail(problems);
  return config;
};
