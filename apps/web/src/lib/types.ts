/** Shapes of the backend's JSON responses that the web app reads. */

export type Role = 'viewer' | 'editor' | 'admin' | 'owner';
export type AuthType = 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type PluginSource = 'official' | 'community' | 'custom';
export type VersionStatus = 'testing' | 'pending_review' | 'active' | 'rejected' | 'revoked';
export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/** `first`: no accounts yet, the next one administers this server. */
export type SignupState = 'first' | 'open' | 'closed';

export type Session =
  | { authenticated: false; signup?: SignupState }
  | {
      authenticated: true;
      user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
      workspace: { id: string; name: string };
      role: Role;
      workspaces: { id: string; name: string; role: Role }[];
      csrfToken: string;
    };

export type SignedInSession = Extract<Session, { authenticated: true }>;

export type Category = { slug: string; name: string; icon: string | undefined; sortOrder: number; isSystem: boolean };

export type MarketplacePlugin = {
  id: string;
  name: string;
  provider: string;
  category: string;
  description: string | undefined;
  source: PluginSource;
  version: string;
  status: VersionStatus;
  icon: string | undefined;
  limitations: string[];
  registeredAt: number;
  ports: { inputs: number; outputs: number };
  installs: number;
  installed: boolean;
};

export type JsonSchema = {
  type?: JsonType;
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: (string | number | boolean | null)[];
  default?: unknown;
  maxLength?: number;
};

export type ManifestAction = {
  key: string;
  name: string;
  description: string | undefined;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  request: { method: HttpMethod; path: string } | undefined;
};

export type Manifest = {
  id: string;
  name: string;
  version: string;
  provider: string;
  category: string;
  description: string | undefined;
  runtime: 'http' | 'native';
  auth: { type: AuthType };
  baseUrl: string | undefined;
  permissions: string[];
  actions: ManifestAction[];
  limitations: string[];
  docs: string | undefined;
};

export type DataPort = { key: string; label: string; type: JsonType | 'any'; required: boolean; description: string | undefined };

export type ConfigField = {
  key: string;
  label: string;
  widget: 'text' | 'textarea' | 'number' | 'toggle' | 'select' | 'json';
  required: boolean;
  options: (string | number | boolean | null)[] | undefined;
  defaultValue: unknown;
  description: string | undefined;
};

export type PortAnchor = { key: string; x: number; y: number; z: number };

/** Sizes in scene units from the node generator; Spatial Studio decides the look. */
export type NodeGeometry = {
  width: number;
  height: number;
  depth: number;
  dataInputs: PortAnchor[];
  dataOutputs: PortAnchor[];
  flowInputs: PortAnchor[];
  flowOutputs: PortAnchor[];
};

export type NodeDefinition = {
  type: string;
  source: { kind: 'plugin'; pluginId: string; version: string; key: string; role: 'action' | 'trigger' } | { kind: 'builtin'; nodeKind: NodeKind };
  title: string;
  subtitle: string;
  description: string | undefined;
  icon: string;
  color: string;
  category: string;
  dataInputs: DataPort[];
  dataOutputs: DataPort[];
  flowInputs: string[];
  flowOutputs: string[];
  configFields: ConfigField[];
  auth: { type: AuthType; required: boolean };
  limitations: string[];
  geometry: NodeGeometry;
};

export type CredentialStatus = 'connected' | 'expired' | 'error';

export type Credential = {
  id: string;
  pluginId: string;
  authType: AuthType;
  status: CredentialStatus;
  fieldNames: string[];
  createdAt: number;
  expiresAt: number | undefined;
};

export type InstalledIntegration = {
  pluginId: string;
  name: string;
  provider: string;
  category: string;
  icon: string | undefined;
  source: PluginSource;
  version: string;
  status: VersionStatus;
  enabled: boolean;
  grantedPermissions: string[];
  limitations: string[];
  updateAvailable: string | undefined;
};

export type IntegrationDetail = {
  integration: InstalledIntegration;
  manifest: Manifest;
  permissions: { declared: string[]; granted: string[] };
  nodes: NodeDefinition[];
  credentials: Credential[];
};

export type PluginDetail = {
  manifest: Manifest;
  source: PluginSource;
  versions: { version: string; status: VersionStatus; registeredAt: number }[];
  nodes: NodeDefinition[];
};

export type Issue = { path: string; message: string };

export type TestReport = {
  ok: boolean;
  status: number | undefined;
  durationMs: number;
  request: { method: string; url: string; headers: Record<string, string> } | undefined;
  rawResponse: unknown;
  output: unknown;
  warnings: Issue[];
  error: { message: string; code: string } | undefined;
};

export type UpdatePreview = { from: string; to: string; permissions: { added: string[]; removed: string[] } };

/* ---------- Workflows (mirrors the core engine's workflow types) ---------- */

export type Position3D = { x: number; y: number; z: number };
export type RetryPolicy = { maxAttempts: number; backoffMs: number; factor?: number; maxBackoffMs?: number };

type NodeBase = { id: string; name?: string; position?: Position3D };

export type TriggerType = 'manual' | 'webhook' | 'schedule' | 'plugin';
export type TriggerNode = NodeBase & { kind: 'trigger'; trigger: TriggerType; schedule?: string; timezone?: string; plugin?: string; key?: string };
export type ActionNode = NodeBase & {
  kind: 'action';
  plugin: string;
  action: string;
  credentialId?: string;
  input: Record<string, unknown>;
  retry?: RetryPolicy;
  continueOnError?: boolean;
};

export type ComparisonOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'startsWith' | 'exists' | 'empty';
export type Comparison = { op: ComparisonOp; left: unknown; right?: unknown };
export type Condition = Comparison | { all: Condition[] } | { any: Condition[] } | { not: Condition };

export type ConditionNode = NodeBase & { kind: 'condition'; when: Condition };
export type LoopNode = NodeBase & { kind: 'loop'; items: string; body: WorkflowGraph; concurrency?: number; maxIterations?: number };
export type DelayNode = NodeBase & { kind: 'delay'; ms: number };
export type ApprovalNode = NodeBase & { kind: 'approval'; message: string };
export type TransformNode = NodeBase & { kind: 'transform'; output: Record<string, unknown> };

export type WorkflowNode = TriggerNode | ActionNode | ConditionNode | LoopNode | DelayNode | ApprovalNode | TransformNode;
export type NodeKind = WorkflowNode['kind'];
export type WorkflowEdge = { id: string; from: string; port?: string; to: string };
export type WorkflowGraph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
export type WorkflowSettings = { concurrency?: number };

export type WorkflowRecord = {
  id: string;
  workspaceId: string;
  name: string;
  currentVersion: number;
  active: boolean;
  activeVersion: number | undefined;
  createdAt: number;
  updatedAt: number;
};

export type WorkflowVersion = { workflowId: string; version: number; graph: WorkflowGraph; settings: WorkflowSettings; pluginIds: string[]; createdAt: number };

export type LiveWebhook = { triggerNodeId: string; webhookId: string; url: string };
export type LiveSchedule = { triggerNodeId: string; cron: string; timezone: string; nextRunAt: number };
export type LiveTriggers = { active: boolean; version: number | undefined; webhooks: LiveWebhook[]; schedules: LiveSchedule[] };
export type Activation = { workflow: WorkflowRecord; webhooks: LiveWebhook[]; schedules: LiveSchedule[] };

export type Failure = { message: string; code: string };
export type NodeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting';
export type EdgeState = 'pending' | 'fired' | 'dead';
export type NodeRun = {
  status: NodeStatus;
  attempts: number;
  output?: unknown;
  port?: string;
  error?: Failure;
  startedAt?: number;
  finishedAt?: number;
  waitingFor?: 'approval' | 'delay';
  resumeAt?: number;
};

export type ExecutionStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

export type Execution = {
  id: string;
  workflowId: string;
  workflowVersion: number;
  workspaceId: string;
  status: ExecutionStatus;
  trigger: { nodeId: string; payload: unknown };
  nodes: Record<string, NodeRun>;
  edges: Record<string, EdgeState>;
  startedAt: number;
  finishedAt?: number;
  error?: Failure & { nodeId: string };
};

/** A run the worker has not picked up yet has no engine state. */
export type QueuedExecution = { id: string; status: 'queued' | 'failed'; error?: string };

export type StepRecord = {
  executionId: string;
  nodeId: string;
  attempt: number;
  status: 'succeeded' | 'failed' | 'skipped' | 'waiting';
  port?: string;
  input?: unknown;
  output?: unknown;
  error?: Failure;
  startedAt: number;
  durationMs: number;
};

export type ExecutionDetail = { execution: Execution | QueuedExecution; steps: StepRecord[] };
