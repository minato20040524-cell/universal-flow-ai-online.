import {
  ENGINE_VERSION,
  createApiConnector,
  createCategoryRegistry,
  createNativeHandlers,
  createOAuthRefresher,
  createPluginActionRunner,
  createPluginRegistry,
  createSecretStore,
  createWorkflowEngine,
  redactValue,
  systemClock,
  type ApiConnector,
  type CategoryRegistry,
  type Clock,
  type EngineEvent,
  type HttpClient,
  type KeyProvider,
  type NativeHandler,
  type NativeHandlers,
  type PluginRegistry,
  type SecretStore,
  type WorkflowEngine,
} from '@universal-flow/core-engine';
import type { SqlClient } from './db/sql.js';
import { createPgJobQueue, type JobQueue } from './queue/job-queue.js';
import { createPgExecutionStore, type PgExecutionStore } from './repositories/execution-store.js';
import { createPgCategoryStore, createPgPluginStore } from './repositories/registry-stores.js';
import { createPgSecretRepository } from './repositories/secret-repository.js';
import { createPgTriggerRepository, type TriggerRepository } from './repositories/trigger-repository.js';
import { createPgWorkflowRepository, type WorkflowRepository } from './repositories/workflow-repository.js';
import { createPgWorkspaceRepository, type WorkspaceRepository } from './repositories/workspace-repository.js';

export type OfficialPlugin = {
  manifest: unknown;
  /** Native handlers keyed by action key; only for runtime "native". */
  handlers?: Record<string, NativeHandler>;
};

export type ContextOptions = {
  sql: SqlClient;
  keyProvider: KeyProvider;
  /** Outbound client for plugin calls and OAuth; createFetchHttpClient() in production. */
  outboundHttp: HttpClient;
  /** Public origin of this API, e.g. https://api.universalflow.ai; used for webhook and OAuth callback URLs. */
  publicBaseUrl: string;
  clock?: Clock;
  officialPlugins?: readonly OfficialPlugin[];
  onEngineEvent?: (event: EngineEvent) => void;
};

export type AppContext = {
  sql: SqlClient;
  clock: Clock;
  publicBaseUrl: string;
  outboundHttp: HttpClient;
  categories: CategoryRegistry;
  plugins: PluginRegistry;
  secrets: SecretStore;
  connector: ApiConnector;
  native: NativeHandlers;
  engine: WorkflowEngine;
  executions: PgExecutionStore;
  workflows: WorkflowRepository;
  workspaces: WorkspaceRepository;
  triggers: TriggerRepository;
  queue: JobQueue;
};

export const createContext = async (options: ContextOptions): Promise<AppContext> => {
  const clock = options.clock ?? systemClock;
  const { sql } = options;
  const workflows = createPgWorkflowRepository(sql);
  const categories = createCategoryRegistry({ store: createPgCategoryStore(sql) });
  await categories.ensureDefaults();

  const plugins = createPluginRegistry({
    categories,
    engineVersion: ENGINE_VERSION,
    store: createPgPluginStore(sql),
    clock,
    isPluginInUse: (workspaceId, pluginId) => workflows.isPluginUsedByActiveWorkflow(workspaceId, pluginId),
  });
  const secrets = createSecretStore({ keyProvider: options.keyProvider, repository: createPgSecretRepository(sql), clock });
  const connector = createApiConnector({ http: options.outboundHttp, secrets, clock, refreshOAuth: createOAuthRefresher(options.outboundHttp) });
  const native = createNativeHandlers();

  for (const official of options.officialPlugins ?? []) {
    const record = await plugins.register(official.manifest, { source: 'official' });
    for (const [actionKey, handler] of Object.entries(official.handlers ?? {})) native.register(record.manifest.id, actionKey, handler);
  }

  const executions = createPgExecutionStore(sql);
  const engine = createWorkflowEngine({
    runAction: createPluginActionRunner({ registry: plugins, connector, secrets, native }),
    store: executions,
    clock,
    redact: (value) => redactValue(value),
    ...(options.onEngineEvent ? { onEvent: options.onEngineEvent } : {}),
  });

  return {
    sql,
    clock,
    publicBaseUrl: options.publicBaseUrl.replace(/\/+$/, ''),
    outboundHttp: options.outboundHttp,
    categories,
    plugins,
    secrets,
    connector,
    native,
    engine,
    executions,
    workflows,
    workspaces: createPgWorkspaceRepository(sql),
    triggers: createPgTriggerRepository(sql),
    queue: createPgJobQueue(sql, clock.now),
  };
};
