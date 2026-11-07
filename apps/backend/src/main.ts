import { hkdfSync } from 'node:crypto';
import { createFetchHttpClient, createLocalKeyProvider } from '@universal-flow/core-engine';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPgClient } from './db/pg-client.js';
import { createHttpServer } from './http/server.js';

/**
 * One binary, three roles. Run `ROLE=api` behind a load balancer, `ROLE=worker`
 * as many times as needed, and `ROLE=scheduler` once or more (it is safe to
 * run several). `ROLE=all` runs everything in one process for development.
 */
const main = async (): Promise<void> => {
  const config = loadConfig();
  const sql = await createPgClient({ connectionString: config.databaseUrl, ssl: config.databaseSsl });
  if (config.autoMigrate) {
    const applied = await migrate(sql);
    if (applied.length > 0) console.log(JSON.stringify({ level: 'info', message: 'migrations applied', applied }));
  }

  const app = await createApp({
    sql,
    // Development key provider; swap in a KMS-backed KeyProvider for production.
    keyProvider: createLocalKeyProvider(config.masterKey, config.masterKeyId),
    outboundHttp: createFetchHttpClient(),
    publicBaseUrl: config.publicBaseUrl,
    // A separate key for sessions, derived so the master key itself never signs anything.
    sessionSecret: Buffer.from(hkdfSync('sha256', config.masterKey, Buffer.alloc(0), 'universal-flow/session', 32)),
    allowSignup: config.allowSignup,
    sessionTtlMs: config.sessionTtlHours * 3_600_000,
    ...(config.webDistDir ? { webDistDir: config.webDistDir } : {}),
    worker: { batchSize: config.workerBatchSize },
  });

  const runsApi = config.role === 'all' || config.role === 'api';
  const runsWorker = config.role === 'all' || config.role === 'worker';
  const runsScheduler = config.role === 'all' || config.role === 'scheduler';

  const server = runsApi ? createHttpServer({ ...app.http, corsOrigins: config.corsOrigins, trustProxy: config.trustProxy }) : undefined;
  server?.listen(config.port, config.host, () => console.log(JSON.stringify({ level: 'info', message: 'api listening', host: config.host, port: config.port })));
  if (runsWorker) app.worker.start();
  if (runsScheduler) app.scheduler.start();
  console.log(JSON.stringify({ level: 'info', message: 'started', role: config.role }));

  const shutdown = async (signal: string) => {
    console.log(JSON.stringify({ level: 'info', message: 'shutting down', signal }));
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await Promise.all([app.worker.stop(), app.scheduler.stop()]);
    await sql.close?.();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
