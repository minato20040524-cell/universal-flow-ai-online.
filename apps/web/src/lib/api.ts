import type {
  Activation,
  Category,
  Credential,
  Execution,
  ExecutionDetail,
  LiveTriggers,
  WorkflowGraph,
  WorkflowRecord,
  WorkflowSettings,
  WorkflowVersion,
  InstalledIntegration,
  IntegrationDetail,
  Issue,
  MarketplacePlugin,
  NodeDefinition,
  PluginDetail,
  Session,
  SignedInSession,
  TestReport,
  UpdatePreview,
} from './types.js';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: Issue[];

  constructor(status: number, code: string, message: string, issues: Issue[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export type ApiClientOptions = {
  fetch?: Fetch;
  baseUrl?: string;
  /** The current session's CSRF token, sent with every change. */
  csrfToken: () => string | undefined;
  /** Called on 401 so the app can return to the sign-in page. */
  onUnauthenticated?: () => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const toIssues = (value: unknown): Issue[] =>
  Array.isArray(value)
    ? value.flatMap((item) => (isRecord(item) && typeof item.path === 'string' && typeof item.message === 'string' ? [{ path: item.path, message: item.message }] : []))
    : [];

/** Turns any non-2xx response into an ApiError with the server's code, message and field issues. */
export const errorFromBody = (status: number, body: unknown): ApiError => {
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  return new ApiError(
    status,
    typeof error.code === 'string' ? error.code : 'HTTP_ERROR',
    typeof error.message === 'string' ? error.message : `The server answered ${status}`,
    toIssues(error.issues),
  );
};

export const createApiClient = (options: ApiClientOptions) => {
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl ?? '';

  /**
   * The backend is part of this repository and deployed with this app, so its
   * responses are trusted to match the declared types; errors are checked.
   */
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const csrf = method === 'GET' ? undefined : options.csrfToken();
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      if (response.status === 401) options.onUnauthenticated?.();
      throw errorFromBody(response.status, parsed);
    }
    return parsed as T;
  };

  const query = (params: Record<string, string | undefined>): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
    const text = search.toString();
    return text ? `?${text}` : '';
  };

  const id = encodeURIComponent;

  return {
    session: () => request<Session>('GET', '/v1/auth/session'),
    login: (email: string, password: string) => request<SignedInSession>('POST', '/v1/auth/login', { email, password }),
    signup: (input: { email: string; name: string; password: string; workspaceName: string }) => request<SignedInSession>('POST', '/v1/auth/signup', input),
    logout: () => request<undefined>('POST', '/v1/auth/logout', {}),
    switchWorkspace: (workspaceId: string) => request<SignedInSession>('POST', '/v1/auth/workspace', { workspaceId }),
    createWorkspace: (name: string) => request<SignedInSession>('POST', '/v1/auth/workspaces', { name }),

    categories: async () => (await request<{ categories: Category[] }>('GET', '/v1/categories')).categories,
    marketplace: async (filters: { text?: string; category?: string; source?: string } = {}) =>
      (await request<{ plugins: MarketplacePlugin[] }>('GET', `/v1/marketplace${query(filters)}`)).plugins,
    plugin: (pluginId: string) => request<PluginDetail>('GET', `/v1/marketplace/${id(pluginId)}`),
    submitPlugin: (manifest: unknown) => request<{ status: string }>('POST', '/v1/marketplace/submissions', { manifest }),

    integrations: async () => (await request<{ integrations: InstalledIntegration[] }>('GET', '/v1/integrations')).integrations,
    integration: (pluginId: string) => request<IntegrationDetail>('GET', `/v1/integrations/${id(pluginId)}`),
    createCustom: (manifest: unknown) => request<{ plugin: { id: string }; status: string; nodes: NodeDefinition[] }>('POST', '/v1/integrations/custom', { manifest }),
    importManifest: (manifest: unknown) => request<{ plugin: { id: string }; status: string }>('POST', '/v1/integrations/import', { manifest }),
    install: (pluginId: string, grantPermissions: string[]) => request<InstalledIntegration>('POST', `/v1/integrations/${id(pluginId)}/install`, { grantPermissions }),
    previewUpdate: (pluginId: string) => request<UpdatePreview>('GET', `/v1/integrations/${id(pluginId)}/update-preview`),
    update: (pluginId: string, grantPermissions: string[]) => request<InstalledIntegration>('POST', `/v1/integrations/${id(pluginId)}/update`, { grantPermissions }),
    setEnabled: (pluginId: string, enabled: boolean) => request<InstalledIntegration>('POST', `/v1/integrations/${id(pluginId)}/${enabled ? 'enable' : 'disable'}`, {}),
    uninstall: (pluginId: string, force = false) => request<undefined>('DELETE', `/v1/integrations/${id(pluginId)}${force ? '?force=true' : ''}`),
    test: (pluginId: string, input: { action: string; input: Record<string, unknown>; credentialId?: string }) =>
      request<{ report: TestReport; activated: boolean }>('POST', `/v1/integrations/${id(pluginId)}/test`, input),
    nodes: async () => (await request<{ nodes: NodeDefinition[] }>('GET', '/v1/nodes')).nodes,

    credentials: async () => (await request<{ credentials: Credential[] }>('GET', '/v1/credentials')).credentials,
    connect: (pluginId: string, values: Record<string, string>) => request<Credential>('POST', '/v1/credentials', { pluginId, values }),
    disconnect: (credentialId: string) => request<undefined>('DELETE', `/v1/credentials/${id(credentialId)}`),
    startOAuth: (pluginId: string, clientId: string, clientSecret: string | undefined) =>
      request<{ authorizationUrl: string; credentialId: string }>('POST', `/v1/oauth/${id(pluginId)}/start`, { clientId, ...(clientSecret ? { clientSecret } : {}) }),

    workflows: async () => (await request<{ workflows: WorkflowRecord[] }>('GET', '/v1/workflows')).workflows,
    workflow: (workflowId: string, version?: number) =>
      request<{ workflow: WorkflowRecord; version: WorkflowVersion }>('GET', `/v1/workflows/${id(workflowId)}${query({ version: version === undefined ? undefined : String(version) })}`),
    createWorkflow: (input: { name: string; graph: WorkflowGraph; settings?: WorkflowSettings }) => request<WorkflowRecord>('POST', '/v1/workflows', input),
    saveWorkflow: (workflowId: string, input: { name: string; graph: WorkflowGraph; settings: WorkflowSettings; expectedVersion: number }) =>
      request<WorkflowRecord>('PUT', `/v1/workflows/${id(workflowId)}`, input),
    deleteWorkflow: (workflowId: string) => request<undefined>('DELETE', `/v1/workflows/${id(workflowId)}`),
    activate: (workflowId: string, version: number) => request<Activation>('POST', `/v1/workflows/${id(workflowId)}/activate`, { version }),
    deactivate: (workflowId: string) => request<WorkflowRecord>('POST', `/v1/workflows/${id(workflowId)}/deactivate`, {}),
    liveTriggers: (workflowId: string) => request<LiveTriggers>('GET', `/v1/workflows/${id(workflowId)}/triggers`),
    /** Admin only: includes the signing secrets, so the caller shows them once and keeps nothing. */
    webhookSecrets: async (workflowId: string) =>
      (await request<{ webhooks: { triggerNodeId: string; url: string; secret: string }[] }>('GET', `/v1/workflows/${id(workflowId)}/webhooks`)).webhooks,
    run: (workflowId: string, input: { version: number; payload: unknown; triggerNodeId?: string }) =>
      request<{ executionId: string; jobId: string }>('POST', `/v1/workflows/${id(workflowId)}/run`, input),

    executions: async (filters: { workflowId?: string; limit?: number } = {}) =>
      (await request<{ executions: Execution[] }>('GET', `/v1/executions${query({ workflowId: filters.workflowId, limit: filters.limit === undefined ? undefined : String(filters.limit) })}`)).executions,
    execution: (executionId: string) => request<ExecutionDetail>('GET', `/v1/executions/${id(executionId)}`),
    decide: (executionId: string, nodeId: string, decision: { approved: boolean; comment?: string }) =>
      request<{ executionId: string }>('POST', `/v1/executions/${id(executionId)}/approvals/${id(nodeId)}`, decision),
    cancelExecution: (executionId: string) => request<Execution>('POST', `/v1/executions/${id(executionId)}/cancel`, {}),
  };
};

export type ApiClient = ReturnType<typeof createApiClient>;
