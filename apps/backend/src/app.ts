import { createContext, type AppContext, type ContextOptions } from './context.js';
import type { ServerOptions } from './http/server.js';
import type { AuthContext, Route } from './http/types.js';
import { authRoutes } from './http/routes/auth.js';
import { integrationRoutes } from './http/routes/integrations.js';
import { createStaticSite } from './http/static-site.js';
import { createPgUserRepository, type UserRepository } from './repositories/user-repository.js';
import { createAuthService } from './services/auth.js';
import { systemRoutes } from './http/routes/system.js';
import { workflowRoutes } from './http/routes/workflows.js';
import { createJobHandlers } from './queue/handlers.js';
import { createScheduler, type Scheduler } from './queue/scheduler.js';
import { createWorker, type Worker } from './queue/worker.js';
import { createCredentialService } from './services/credentials.js';
import { createExecutionService } from './services/executions.js';
import { createIntegrationService } from './services/integrations.js';
import { createWorkflowService } from './services/workflows.js';

export type AppOptions = ContextOptions & {
  /** 32+ random bytes, derived from the master key in main.ts; signs CSRF tokens. */
  sessionSecret: Buffer;
  allowSignup?: boolean;
  sessionTtlMs?: number;
  /** Built web app to serve at /; omit to run the API alone. */
  webDistDir?: string;
  workerId?: string;
  worker?: { batchSize?: number; leaseMs?: number; pollIntervalMs?: number; baseRetryDelayMs?: number };
  scheduler?: { pollIntervalMs?: number };
};

export type App = {
  context: AppContext;
  users: UserRepository;
  routes: Route[];
  /** Everything createHttpServer needs besides deployment settings (CORS, proxy). */
  http: Pick<ServerOptions, 'routes' | 'authenticate' | 'fallback' | 'trustedOrigins'>;
  worker: Worker;
  scheduler: Scheduler;
};

const DEFAULT_SESSION_TTL_MS = 14 * 24 * 3_600_000;

/** Builds the whole backend; main.ts decides which parts (API, worker, scheduler) a process runs. */
export const createApp = async (options: AppOptions): Promise<App> => {
  const context = await createContext(options);
  const integrations = createIntegrationService(context);
  const credentials = createCredentialService(context);
  const workflows = createWorkflowService(context);
  const executions = createExecutionService(context);

  const users = createPgUserRepository(context.sql);
  const auth = createAuthService(context, {
    users,
    sessionSecret: options.sessionSecret,
    secureCookies: context.publicBaseUrl.startsWith('https://'),
    allowSignup: options.allowSignup ?? true,
    sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
  });

  const routes = [...authRoutes(auth), ...systemRoutes(context, credentials), ...integrationRoutes(integrations), ...workflowRoutes(workflows, executions)];

  const authenticateToken = async (token: string): Promise<AuthContext | undefined> => {
    const info = await context.workspaces.authenticate(token, context.clock.now());
    return info
      ? { via: 'token', workspaceId: info.workspaceId, role: info.role, tokenId: info.id, isPlatformAdmin: info.isPlatformAdmin, actor: `token:${info.id}`, userId: undefined, csrfToken: undefined }
      : undefined;
  };

  const authenticate: ServerOptions['authenticate'] = async ({ bearer, sessionToken }) => {
    if (bearer) return authenticateToken(bearer);
    return sessionToken ? auth.authenticate(sessionToken) : undefined;
  };

  const worker = createWorker({
    queue: context.queue,
    handlers: createJobHandlers(context),
    workerId: options.workerId ?? `worker-${process.pid}`,
    clock: context.clock,
    ...options.worker,
    onError: (job, error) => console.error(JSON.stringify({ level: 'warn', job: job.id, type: job.type, attempt: job.attempts, error: error instanceof Error ? error.message : String(error) })),
  });
  const scheduler = createScheduler({ triggers: context.triggers, queue: context.queue, clock: context.clock, ...options.scheduler });

  const http: App['http'] = {
    routes,
    authenticate,
    trustedOrigins: [new URL(context.publicBaseUrl).origin],
    ...(options.webDistDir ? { fallback: createStaticSite(options.webDistDir) } : {}),
  };

  return { context, users, routes, http, worker, scheduler };
};
