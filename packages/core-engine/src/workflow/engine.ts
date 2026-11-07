import { EngineError, ValidationError, isRetryable, toFailure, type Failure } from '../errors.js';
import { renderTemplate, stringifyValue, type TemplateScope } from '../expression/template.js';
import { redactValue } from '../security/redact.js';
import { createId, groupBy, isRecord, systemClock, type Clock } from '../util.js';
import { evaluateCondition } from './condition.js';
import type { ExecutionStore } from './execution-store.js';
import { DEFAULT_PORT } from './ports.js';
import type {
  ActionNode,
  EdgeState,
  Execution,
  ExecutionStatus,
  LoopNode,
  NodeRun,
  NodeStatus,
  RetryPolicy,
  StepRecord,
  Workflow,
  WorkflowGraph,
  WorkflowNode,
} from './types.js';
import { assertValidWorkflow } from './validate-workflow.js';

/**
 * Execution model
 * - The graph is a DAG. A node runs once every incoming edge is settled and at
 *   least one of them fired; independent branches therefore run in parallel.
 * - A finished node fires the edges on the port it finished on and kills the
 *   rest. A node whose incoming edges are all dead is skipped, and its own
 *   edges die too (dead-path elimination), so branches after a condition or an
 *   approval join cleanly.
 * - Approvals and long delays pause the execution (status `waiting`); its state
 *   is persisted after every change, so a worker can resume it later.
 */

export type ActionInvocation = {
  workspaceId: string;
  executionId: string;
  nodeId: string;
  plugin: string;
  action: string;
  credentialId: string | undefined;
  input: Record<string, unknown>;
};

export type ActionRunner = (invocation: ActionInvocation) => Promise<unknown>;

export type EngineEvent =
  | { type: 'execution.started'; executionId: string; workflowId: string }
  | { type: 'node.started'; executionId: string; nodeId: string; attempt: number }
  | { type: 'node.retrying'; executionId: string; nodeId: string; attempt: number; delayMs: number; error: Failure }
  | { type: 'node.finished'; executionId: string; nodeId: string; status: NodeStatus; port: string | undefined }
  | { type: 'execution.finished'; executionId: string; status: ExecutionStatus };

export type WorkflowEngineOptions = {
  runAction: ActionRunner;
  store: ExecutionStore;
  clock?: Clock;
  /** Applied to step input/output before they are written to history. */
  redact?: (value: unknown) => unknown;
  concurrency?: number;
  /** Delays up to this length run in-process; longer ones pause the execution. */
  inlineDelayLimitMs?: number;
  onEvent?: (event: EngineEvent) => void;
};

export type StartOptions = {
  triggerNodeId?: string;
  payload?: unknown;
  /** Lets the API hand out the id before a worker starts the run. */
  executionId?: string;
};
export type ApprovalDecision = { approved: boolean; by?: string; comment?: string };
export type WorkflowLoader = (workflowId: string, version: number) => Promise<Workflow | undefined>;

export type WorkflowEngine = {
  start: (workflow: Workflow, options?: StartOptions) => Promise<Execution>;
  resolveApproval: (workflow: Workflow, executionId: string, nodeId: string, decision: ApprovalDecision) => Promise<Execution>;
  /** Resumes one paused delay node if it is due; returns the execution unchanged otherwise. */
  resumeDelay: (workflow: Workflow, executionId: string, nodeId: string) => Promise<Execution>;
  resumeDueDelays: (loadWorkflow: WorkflowLoader) => Promise<Execution[]>;
  cancel: (executionId: string) => Promise<Execution>;
  /** Continues an execution left `running` by a worker that died mid-run. */
  recover: (workflow: Workflow, executionId: string) => Promise<Execution>;
};

type GraphState = { nodes: Record<string, NodeRun>; edges: Record<string, EdgeState> };
type NodeView = { output: unknown; status: NodeStatus; port: string | undefined };
type RunScope = { trigger: unknown; outer: Record<string, NodeView>; item?: unknown; index?: number };

type GraphRun = {
  graph: WorkflowGraph;
  state: GraphState;
  scope: RunScope;
  workspaceId: string;
  executionId: string;
  stepPrefix: string;
  allowWaiting: boolean;
  concurrency: number;
  persist: () => Promise<void>;
  isCancelled: () => boolean;
};

type NodeOutcome =
  | { kind: 'done'; port: string; output: unknown; input?: unknown }
  | { kind: 'wait'; waitingFor: 'approval' | 'delay'; resumeAt?: number; output?: unknown }
  | { kind: 'error'; error: Failure; input?: unknown };

type GraphOutcome =
  | { status: 'completed' }
  | { status: 'waiting' }
  | { status: 'cancelled' }
  | { status: 'failed'; nodeId: string; error: Failure };

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_INLINE_DELAY_LIMIT_MS = 10_000;
const DEFAULT_MAX_ITERATIONS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

export const initialGraphState = (graph: WorkflowGraph): GraphState => ({
  nodes: Object.fromEntries(graph.nodes.map((node): [string, NodeRun] => [node.id, { status: 'pending', attempts: 0 }])),
  edges: Object.fromEntries(graph.edges.map((edge): [string, EdgeState] => [edge.id, 'pending'])),
});

export const backoffDelay = (policy: RetryPolicy, attempt: number): number =>
  Math.min(policy.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS, policy.backoffMs * (policy.factor ?? 2) ** (attempt - 1));

/** Fires the edges leaving `nodeId` on `port` and kills the others; no port kills them all. */
const settleEdges = (graph: WorkflowGraph, state: GraphState, nodeId: string, port: string | undefined): void => {
  for (const edge of graph.edges) {
    if (edge.from !== nodeId) continue;
    state.edges[edge.id] = port !== undefined && (edge.port ?? DEFAULT_PORT) === port ? 'fired' : 'dead';
  }
};

const nodeRunOf = (state: GraphState, nodeId: string): NodeRun => {
  const nodeRun = state.nodes[nodeId];
  if (!nodeRun) throw new EngineError('WORKFLOW', `Unknown node "${nodeId}"`);
  return nodeRun;
};

/** Delay nodes an execution is waiting on, so a scheduler can wake it at the right time. */
export const pendingResumes = (execution: Execution): { nodeId: string; resumeAt: number }[] =>
  Object.entries(execution.nodes).flatMap(([nodeId, nodeRun]) =>
    nodeRun.status === 'waiting' && nodeRun.waitingFor === 'delay' && nodeRun.resumeAt !== undefined ? [{ nodeId, resumeAt: nodeRun.resumeAt }] : [],
  );

/** Approval nodes an execution is waiting on. */
export const pendingApprovals = (execution: Execution): string[] =>
  Object.entries(execution.nodes).flatMap(([nodeId, nodeRun]) => (nodeRun.status === 'waiting' && nodeRun.waitingFor === 'approval' ? [nodeId] : []));

const done = (port: string, output: unknown, input?: unknown): NodeOutcome => ({ kind: 'done', port, output, input });

const patchRun = (nodeRun: NodeRun, patch: Partial<NodeRun>): void => {
  Object.assign(nodeRun, patch);
};

const collectViews = (state: GraphState): Record<string, NodeView> =>
  Object.fromEntries(
    Object.entries(state.nodes)
      .filter(([, nodeRun]) => nodeRun.status === 'succeeded' || nodeRun.status === 'failed')
      .map(([id, nodeRun]): [string, NodeView] => [id, { output: nodeRun.output, status: nodeRun.status, port: nodeRun.port }]),
  );

export const createWorkflowEngine = (options: WorkflowEngineOptions): WorkflowEngine => {
  const clock = options.clock ?? systemClock;
  const redact = options.redact ?? ((value: unknown) => redactValue(value));
  const inlineDelayLimitMs = options.inlineDelayLimitMs ?? DEFAULT_INLINE_DELAY_LIMIT_MS;
  const cancelled = new Set<string>();
  const locks = new Map<string, Promise<unknown>>();

  const emit = (event: EngineEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // A broken listener must never break a run.
    }
  };

  /** Serializes work on one execution inside this process. Across workers, use a row lock. */
  const withLock = async <T>(executionId: string, task: () => Promise<T>): Promise<T> => {
    const previous = locks.get(executionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    locks.set(executionId, current);
    try {
      return await current;
    } finally {
      if (locks.get(executionId) === current) locks.delete(executionId);
    }
  };

  const recordStep = (step: StepRecord): Promise<void> =>
    options.store.appendStep({ ...step, input: redact(step.input), output: redact(step.output) });

  const expressionScope = (run: GraphRun): TemplateScope => ({
    trigger: run.scope.trigger,
    nodes: { ...run.scope.outer, ...collectViews(run.state) },
    item: run.scope.item,
    index: run.scope.index,
  });

  const runActionNode = async (run: GraphRun, node: ActionNode, nodeRun: NodeRun): Promise<NodeOutcome> => {
    const input = renderTemplate(node.input, expressionScope(run));
    if (!isRecord(input)) return { kind: 'error', error: { message: 'Action input must render to an object', code: 'VALIDATION' } };
    const policy: RetryPolicy = node.retry ?? { maxAttempts: 1, backoffMs: 0 };
    const stepId = `${run.stepPrefix}${node.id}`;

    for (let attempt = 1; ; attempt += 1) {
      nodeRun.attempts = attempt;
      const startedAt = clock.now();
      try {
        const output = await options.runAction({
          workspaceId: run.workspaceId,
          executionId: run.executionId,
          nodeId: stepId,
          plugin: node.plugin,
          action: node.action,
          credentialId: node.credentialId,
          input,
        });
        return done(DEFAULT_PORT, output, input);
      } catch (error) {
        const failure = toFailure(error);
        if (attempt >= policy.maxAttempts || !isRetryable(error) || run.isCancelled()) {
          return { kind: 'error', error: failure, input };
        }
        const delayMs = backoffDelay(policy, attempt);
        await recordStep({ executionId: run.executionId, nodeId: stepId, attempt, status: 'failed', input, error: failure, startedAt, durationMs: clock.now() - startedAt });
        emit({ type: 'node.retrying', executionId: run.executionId, nodeId: stepId, attempt: attempt + 1, delayMs, error: failure });
        await clock.sleep(delayMs);
      }
    }
  };

  const collectOutputs = (state: GraphState): Record<string, unknown> =>
    Object.fromEntries(Object.entries(state.nodes).filter(([, nodeRun]) => nodeRun.status === 'succeeded').map(([id, nodeRun]) => [id, nodeRun.output]));

  const runLoopNode = async (run: GraphRun, node: LoopNode): Promise<NodeOutcome> => {
    const scope = expressionScope(run);
    const items = renderTemplate(node.items, scope);
    if (!Array.isArray(items)) return { kind: 'error', error: { message: `Loop items must render to an array (${node.items})`, code: 'VALIDATION' } };
    const limit = node.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    if (items.length > limit) return { kind: 'error', error: { message: `Loop has ${items.length} items; the limit is ${limit}`, code: 'VALIDATION' } };

    const outer = { ...run.scope.outer, ...collectViews(run.state) };
    const results: unknown[] = new Array<unknown>(items.length).fill(undefined);
    const progress: { next: number; failure?: Failure } = { next: 0 };

    const worker = async (): Promise<void> => {
      while (progress.failure === undefined && progress.next < items.length && !run.isCancelled()) {
        const index = progress.next;
        progress.next += 1;
        const bodyRun: GraphRun = {
          ...run,
          graph: node.body,
          state: initialGraphState(node.body),
          scope: { trigger: run.scope.trigger, outer, item: items[index], index },
          stepPrefix: `${run.stepPrefix}${node.id}[${index}].`,
          allowWaiting: false,
          persist: async () => undefined,
        };
        const outcome = await runGraph(bodyRun);
        if (outcome.status === 'failed') {
          progress.failure = { message: `Iteration ${index} failed at "${outcome.nodeId}": ${outcome.error.message}`, code: outcome.error.code };
          return;
        }
        results[index] = collectOutputs(bodyRun.state);
      }
    };
    const workers = Math.max(1, Math.min(node.concurrency ?? 1, items.length));
    await Promise.all(Array.from({ length: workers }, worker));
    if (progress.failure) return { kind: 'error', error: progress.failure };
    return done(DEFAULT_PORT, { count: items.length, results });
  };

  const executeNode = async (run: GraphRun, node: WorkflowNode, nodeRun: NodeRun): Promise<NodeOutcome> => {
    try {
      switch (node.kind) {
        case 'trigger':
          return done(DEFAULT_PORT, run.scope.trigger);
        case 'action':
          return await runActionNode(run, node, nodeRun);
        case 'condition': {
          const result = evaluateCondition(node.when, expressionScope(run));
          return done(result ? 'true' : 'false', { result });
        }
        case 'transform':
          return done(DEFAULT_PORT, renderTemplate(node.output, expressionScope(run)));
        case 'delay':
          if (node.ms <= inlineDelayLimitMs) {
            await clock.sleep(node.ms);
            return done(DEFAULT_PORT, { waitedMs: node.ms });
          }
          return { kind: 'wait', waitingFor: 'delay', resumeAt: clock.now() + node.ms };
        case 'approval':
          // The rendered message is kept on the waiting node so whoever decides can read it.
          return { kind: 'wait', waitingFor: 'approval', output: { message: stringifyValue(renderTemplate(node.message, expressionScope(run))) } };
        case 'loop':
          return await runLoopNode(run, node);
      }
    } catch (error) {
      return { kind: 'error', error: toFailure(error) };
    }
  };

  const runGraph = async (run: GraphRun): Promise<GraphOutcome> => {
    const { graph, state } = run;
    const incoming = groupBy(graph.edges, (edge) => edge.to);
    const incomingOf = (nodeId: string) => incoming.get(nodeId) ?? [];
    const running = new Map<string, Promise<void>>();
    const result: { failure?: { nodeId: string; error: Failure } } = {};

    const hasErrorRoute = (nodeId: string) => graph.edges.some((edge) => edge.from === nodeId && edge.port === 'error');

    const skipDeadNodes = async (): Promise<void> => {
      for (let changed = true; changed; ) {
        changed = false;
        for (const node of graph.nodes) {
          const nodeRun = nodeRunOf(state, node.id);
          const edges = incomingOf(node.id);
          if (nodeRun.status !== 'pending' || edges.length === 0) continue;
          if (!edges.every((edge) => state.edges[edge.id] === 'dead')) continue;
          nodeRun.status = 'skipped';
          settleEdges(graph, state, node.id, undefined);
          changed = true;
          const now = clock.now();
          await recordStep({ executionId: run.executionId, nodeId: `${run.stepPrefix}${node.id}`, attempt: 0, status: 'skipped', startedAt: now, durationMs: 0 });
          emit({ type: 'node.finished', executionId: run.executionId, nodeId: `${run.stepPrefix}${node.id}`, status: 'skipped', port: undefined });
        }
      }
    };

    const isReady = (node: WorkflowNode): boolean => {
      if (nodeRunOf(state, node.id).status !== 'pending') return false;
      const edges = incomingOf(node.id);
      if (edges.length === 0) return true;
      return edges.every((edge) => state.edges[edge.id] !== 'pending') && edges.some((edge) => state.edges[edge.id] === 'fired');
    };

    const applyOutcome = (node: WorkflowNode, nodeRun: NodeRun, outcome: NodeOutcome): void => {
      nodeRun.finishedAt = clock.now();
      if (outcome.kind === 'done') {
        patchRun(nodeRun, { status: 'succeeded', output: outcome.output, port: outcome.port });
        settleEdges(graph, state, node.id, outcome.port);
        return;
      }
      if (outcome.kind === 'wait') {
        if (run.allowWaiting) {
          patchRun(nodeRun, { status: 'waiting', waitingFor: outcome.waitingFor, resumeAt: outcome.resumeAt, output: outcome.output });
          return;
        }
        applyOutcome(node, nodeRun, { kind: 'error', error: { message: `${node.kind} nodes cannot pause inside a loop body`, code: 'WORKFLOW' } });
        return;
      }
      nodeRun.error = outcome.error;
      if (hasErrorRoute(node.id)) {
        patchRun(nodeRun, { status: 'failed', port: 'error', output: { error: outcome.error } });
        settleEdges(graph, state, node.id, 'error');
      } else if (node.kind === 'action' && node.continueOnError) {
        patchRun(nodeRun, { status: 'succeeded', port: DEFAULT_PORT, output: { error: outcome.error } });
        settleEdges(graph, state, node.id, DEFAULT_PORT);
      } else {
        nodeRun.status = 'failed';
        result.failure ??= { nodeId: `${run.stepPrefix}${node.id}`, error: outcome.error };
      }
    };

    const launch = (node: WorkflowNode): Promise<void> => {
      const nodeRun = nodeRunOf(state, node.id);
      const stepId = `${run.stepPrefix}${node.id}`;
      const startedAt = clock.now();
      patchRun(nodeRun, { status: 'running', startedAt, attempts: 1 });
      emit({ type: 'node.started', executionId: run.executionId, nodeId: stepId, attempt: 1 });

      const task = async (): Promise<void> => {
        await run.persist();
        const outcome = await executeNode(run, node, nodeRun);
        applyOutcome(node, nodeRun, outcome);
        await recordStep({
          executionId: run.executionId,
          nodeId: stepId,
          attempt: nodeRun.attempts,
          status: nodeRun.status === 'succeeded' ? 'succeeded' : nodeRun.status === 'waiting' ? 'waiting' : 'failed',
          port: nodeRun.port,
          input: outcome.kind === 'wait' ? undefined : outcome.input,
          output: nodeRun.output,
          error: nodeRun.error,
          startedAt,
          durationMs: clock.now() - startedAt,
        });
        emit({ type: 'node.finished', executionId: run.executionId, nodeId: stepId, status: nodeRun.status, port: nodeRun.port });
        await run.persist();
      };
      return task()
        .catch((error: unknown) => {
          nodeRun.status = 'failed';
          result.failure ??= { nodeId: stepId, error: toFailure(error) };
        })
        .finally(() => {
          running.delete(node.id);
        });
    };

    for (;;) {
      await skipDeadNodes();
      if (!result.failure && !run.isCancelled()) {
        for (const node of graph.nodes) {
          if (running.size >= run.concurrency) break;
          if (!running.has(node.id) && isReady(node)) running.set(node.id, launch(node));
        }
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }

    if (result.failure) return { status: 'failed', ...result.failure };
    if (run.isCancelled()) return { status: 'cancelled' };
    if (graph.nodes.some((node) => nodeRunOf(state, node.id).status === 'waiting')) return { status: 'waiting' };
    return { status: 'completed' };
  };

  const drive = async (workflow: Workflow, execution: Execution): Promise<Execution> => {
    const persist = () => options.store.save(execution);
    const run: GraphRun = {
      graph: workflow.graph,
      state: { nodes: execution.nodes, edges: execution.edges },
      scope: { trigger: execution.trigger.payload, outer: {} },
      workspaceId: execution.workspaceId,
      executionId: execution.id,
      stepPrefix: '',
      allowWaiting: true,
      concurrency: workflow.settings?.concurrency ?? options.concurrency ?? DEFAULT_CONCURRENCY,
      persist,
      isCancelled: () => cancelled.has(execution.id),
    };
    const outcome = await runGraph(run);
    const statusOf: Record<GraphOutcome['status'], ExecutionStatus> = {
      completed: 'succeeded',
      waiting: 'waiting',
      cancelled: 'cancelled',
      failed: 'failed',
    };
    execution.status = statusOf[outcome.status];
    if (outcome.status === 'failed') execution.error = { nodeId: outcome.nodeId, ...outcome.error };
    if (execution.status !== 'waiting') execution.finishedAt = clock.now();
    await persist();
    emit({ type: 'execution.finished', executionId: execution.id, status: execution.status });
    return structuredClone(execution);
  };

  const loadExecution = async (workflow: Workflow, executionId: string): Promise<Execution> => {
    const execution = await options.store.get(executionId);
    if (!execution) throw new EngineError('NOT_FOUND', `Execution ${executionId} does not exist`);
    if (execution.workflowId !== workflow.id || execution.workflowVersion !== workflow.version) {
      throw new EngineError('CONFLICT', `Execution ${executionId} belongs to ${execution.workflowId} v${execution.workflowVersion}`);
    }
    if (execution.status !== 'waiting') throw new EngineError('CONFLICT', `Execution ${executionId} is ${execution.status}, not waiting`);
    return execution;
  };

  /** A node left `running` by a crashed worker is run again (at-least-once). */
  const resetInterrupted = (execution: Execution): void => {
    for (const nodeRun of Object.values(execution.nodes)) {
      if (nodeRun.status === 'running') nodeRun.status = 'pending';
    }
  };

  const resumeNode = async (workflow: Workflow, execution: Execution, nodeId: string, port: string, output: unknown): Promise<Execution> => {
    const nodeRun = nodeRunOf({ nodes: execution.nodes, edges: execution.edges }, nodeId);
    const now = clock.now();
    patchRun(nodeRun, { status: 'succeeded', port, output, finishedAt: now, waitingFor: undefined, resumeAt: undefined });
    settleEdges(workflow.graph, { nodes: execution.nodes, edges: execution.edges }, nodeId, port);
    await recordStep({ executionId: execution.id, nodeId, attempt: 1, status: 'succeeded', port, output, startedAt: now, durationMs: 0 });
    emit({ type: 'node.finished', executionId: execution.id, nodeId, status: 'succeeded', port });
    execution.status = 'running';
    resetInterrupted(execution);
    return drive(workflow, execution);
  };

  return {
    start: async (workflow, { triggerNodeId, payload = {}, executionId } = {}) => {
      assertValidWorkflow(workflow);
      const triggers = workflow.graph.nodes.filter((node) => node.kind === 'trigger');
      const trigger = triggerNodeId ? triggers.find((node) => node.id === triggerNodeId) : triggers.at(0);
      if (!trigger) throw new ValidationError('Cannot start workflow', [{ path: 'triggerNodeId', message: `no trigger "${triggerNodeId ?? ''}"` }]);

      const now = clock.now();
      const state = initialGraphState(workflow.graph);
      const execution: Execution = {
        id: executionId ?? createId('exec'),
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        workspaceId: workflow.workspaceId,
        status: 'running',
        trigger: { nodeId: trigger.id, payload },
        nodes: state.nodes,
        edges: state.edges,
        startedAt: now,
      };
      // The chosen trigger has already happened; other triggers of this workflow stay silent.
      for (const node of triggers) {
        const nodeRun = nodeRunOf(state, node.id);
        if (node.id === trigger.id) {
          patchRun(nodeRun, { status: 'succeeded', attempts: 1, output: payload, port: DEFAULT_PORT, startedAt: now, finishedAt: now });
          settleEdges(workflow.graph, state, node.id, DEFAULT_PORT);
        } else {
          nodeRun.status = 'skipped';
          settleEdges(workflow.graph, state, node.id, undefined);
        }
      }
      if (executionId && (await options.store.get(executionId))) {
        throw new EngineError('CONFLICT', `Execution ${executionId} already exists`);
      }
      await options.store.save(execution);
      emit({ type: 'execution.started', executionId: execution.id, workflowId: workflow.id });
      await recordStep({ executionId: execution.id, nodeId: trigger.id, attempt: 1, status: 'succeeded', port: DEFAULT_PORT, output: payload, startedAt: now, durationMs: 0 });
      return withLock(execution.id, () => drive(workflow, execution));
    },

    resolveApproval: (workflow, executionId, nodeId, decision) =>
      withLock(executionId, async () => {
        const execution = await loadExecution(workflow, executionId);
        const nodeRun = execution.nodes[nodeId];
        if (!nodeRun || nodeRun.status !== 'waiting' || nodeRun.waitingFor !== 'approval') {
          throw new EngineError('CONFLICT', `Node "${nodeId}" is not waiting for approval`);
        }
        const output = { approved: decision.approved, by: decision.by, comment: decision.comment, decidedAt: clock.now() };
        return resumeNode(workflow, execution, nodeId, decision.approved ? 'approved' : 'rejected', output);
      }),

    resumeDelay: (workflow, executionId, nodeId) =>
      withLock(executionId, async () => {
        const execution = await options.store.get(executionId);
        if (!execution) throw new EngineError('NOT_FOUND', `Execution ${executionId} does not exist`);
        const nodeRun = execution.nodes[nodeId];
        const isDue = nodeRun?.status === 'waiting' && nodeRun.waitingFor === 'delay' && (nodeRun.resumeAt ?? Infinity) <= clock.now();
        if (execution.status !== 'waiting' || !isDue) return execution;
        return resumeNode(workflow, await loadExecution(workflow, executionId), nodeId, DEFAULT_PORT, { resumedAt: clock.now() });
      }),

    resumeDueDelays: async (loadWorkflow) => {
      const resumed: Execution[] = [];
      for (const waiting of await options.store.listWaiting()) {
        const now = clock.now();
        const dueNodeIds = Object.entries(waiting.nodes)
          .filter(([, nodeRun]) => nodeRun.status === 'waiting' && nodeRun.waitingFor === 'delay' && (nodeRun.resumeAt ?? Infinity) <= now)
          .map(([id]) => id);
        if (dueNodeIds.length === 0) continue;
        const workflow = await loadWorkflow(waiting.workflowId, waiting.workflowVersion);
        if (!workflow) continue;
        const execution = await withLock(waiting.id, async () => {
          let current = await loadExecution(workflow, waiting.id);
          for (const nodeId of dueNodeIds) {
            if (current.nodes[nodeId]?.status !== 'waiting') continue;
            current = await resumeNode(workflow, current, nodeId, DEFAULT_PORT, { resumedAt: clock.now() });
            if (current.status !== 'waiting') break;
          }
          return current;
        });
        resumed.push(execution);
      }
      return resumed;
    },

    recover: (workflow, executionId) =>
      withLock(executionId, async () => {
        const execution = await options.store.get(executionId);
        if (!execution) throw new EngineError('NOT_FOUND', `Execution ${executionId} does not exist`);
        if (execution.status !== 'running') return execution;
        resetInterrupted(execution);
        return drive(workflow, execution);
      }),

    cancel: async (executionId) => {
      cancelled.add(executionId);
      return withLock(executionId, async () => {
        const execution = await options.store.get(executionId);
        if (!execution) throw new EngineError('NOT_FOUND', `Execution ${executionId} does not exist`);
        if (execution.status === 'running' || execution.status === 'waiting') {
          for (const nodeRun of Object.values(execution.nodes)) {
            if (nodeRun.status === 'waiting' || nodeRun.status === 'pending') nodeRun.status = 'skipped';
          }
          execution.status = 'cancelled';
          execution.finishedAt = clock.now();
          await options.store.save(execution);
          emit({ type: 'execution.finished', executionId, status: 'cancelled' });
        }
        return execution;
      });
    },
  };
};
