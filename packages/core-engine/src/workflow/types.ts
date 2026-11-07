import type { Failure } from '../errors.js';

export type RetryPolicy = {
  /** Total attempts including the first one (1 = no retry). */
  maxAttempts: number;
  backoffMs: number;
  factor?: number;
  maxBackoffMs?: number;
};

export type Position3D = { x: number; y: number; z: number };

type NodeBase = { id: string; name?: string; position?: Position3D };

export type TriggerNode = NodeBase & {
  kind: 'trigger';
  trigger: 'manual' | 'webhook' | 'schedule' | 'plugin';
  /** Cron expression (5 fields) for schedule triggers. */
  schedule?: string;
  /** IANA time zone for the cron expression, e.g. Asia/Makassar. Defaults to UTC. */
  timezone?: string;
  /** For plugin triggers: `pluginId@version` and the trigger key. */
  plugin?: string;
  key?: string;
};

export type ActionNode = NodeBase & {
  kind: 'action';
  /** Pinned plugin version, `pluginId@1.2.0`, so plugin updates never change a saved workflow. */
  plugin: string;
  action: string;
  credentialId?: string;
  /** Templated input, e.g. `{ "prompt": "{{nodes.telegram.output.text}}" }`. */
  input: Record<string, unknown>;
  retry?: RetryPolicy;
  /** Treat a failure as a normal output instead of stopping the workflow. */
  continueOnError?: boolean;
};

export type Comparison = {
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'startsWith' | 'exists' | 'empty';
  left: unknown;
  right?: unknown;
};

export type Condition = Comparison | { all: Condition[] } | { any: Condition[] } | { not: Condition };

export type ConditionNode = NodeBase & { kind: 'condition'; when: Condition };

export type LoopNode = NodeBase & {
  kind: 'loop';
  /** Expression that renders to an array, e.g. `{{nodes.sheet.output.rows}}`. */
  items: string;
  /** Subgraph run once per item; inside it `{{item}}` and `{{index}}` are available. */
  body: WorkflowGraph;
  concurrency?: number;
  maxIterations?: number;
};

export type DelayNode = NodeBase & { kind: 'delay'; ms: number };
export type ApprovalNode = NodeBase & { kind: 'approval'; message: string };
export type TransformNode = NodeBase & { kind: 'transform'; output: Record<string, unknown> };

export type WorkflowNode = TriggerNode | ActionNode | ConditionNode | LoopNode | DelayNode | ApprovalNode | TransformNode;
export type NodeKind = WorkflowNode['kind'];

/** Control flow: when `from` finishes on `port` (default `out`), `to` may run. */
export type WorkflowEdge = { id: string; from: string; port?: string; to: string };

export type WorkflowGraph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

export type WorkflowSettings = { concurrency?: number };

export type Workflow = {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  graph: WorkflowGraph;
  settings?: WorkflowSettings;
};

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

export type StepRecord = {
  executionId: string;
  /** Node id; inside loops `loopId[index].nodeId`. */
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
