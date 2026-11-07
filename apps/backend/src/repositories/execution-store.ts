import {
  EngineError,
  isRecord,
  type EdgeState,
  type Execution,
  type ExecutionStatus,
  type ExecutionStore,
  type Failure,
  type NodeRun,
  type StepRecord,
} from '@universal-flow/core-engine';
import { ConcurrentModificationError, col, jsonParam, optionalTs, ts, type SqlClient, type SqlRow } from '../db/sql.js';

const EXECUTION_STATUSES: readonly ExecutionStatus[] = ['running', 'waiting', 'succeeded', 'failed', 'cancelled'];
const STEP_STATUSES: readonly StepRecord['status'][] = ['succeeded', 'failed', 'skipped', 'waiting'];

const asFailure = (value: unknown): Failure | undefined =>
  isRecord(value) && typeof value.message === 'string' && typeof value.code === 'string' ? { message: value.message, code: value.code } : undefined;

/**
 * Node and edge state is written by the engine only, as JSON; it is read back
 * as plain data and checked at the boundary that matters (status values).
 */
const asNodes = (value: unknown): Record<string, NodeRun> => {
  if (!isRecord(value)) throw new EngineError('WORKFLOW', 'Execution nodes are corrupted');
  const nodes: Record<string, NodeRun> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.status !== 'string' || typeof raw.attempts !== 'number') throw new EngineError('WORKFLOW', `Node state ${id} is corrupted`);
    const status = (['pending', 'running', 'succeeded', 'failed', 'skipped', 'waiting'] as const).find((candidate) => candidate === raw.status);
    if (!status) throw new EngineError('WORKFLOW', `Node state ${id} has status ${raw.status}`);
    const error = asFailure(raw.error);
    nodes[id] = {
      status,
      attempts: raw.attempts,
      ...('output' in raw ? { output: raw.output } : {}),
      ...(typeof raw.port === 'string' ? { port: raw.port } : {}),
      ...(error ? { error } : {}),
      ...(typeof raw.startedAt === 'number' ? { startedAt: raw.startedAt } : {}),
      ...(typeof raw.finishedAt === 'number' ? { finishedAt: raw.finishedAt } : {}),
      ...(raw.waitingFor === 'approval' || raw.waitingFor === 'delay' ? { waitingFor: raw.waitingFor } : {}),
      ...(typeof raw.resumeAt === 'number' ? { resumeAt: raw.resumeAt } : {}),
    };
  }
  return nodes;
};

const asEdges = (value: unknown): Record<string, EdgeState> => {
  if (!isRecord(value)) throw new EngineError('WORKFLOW', 'Execution edges are corrupted');
  const edges: Record<string, EdgeState> = {};
  for (const [id, state] of Object.entries(value)) {
    edges[id] = state === 'fired' || state === 'dead' ? state : 'pending';
  }
  return edges;
};

const toExecution = (row: SqlRow): Execution => {
  const status = EXECUTION_STATUSES.find((candidate) => candidate === col.string(row, 'status'));
  if (!status) throw new EngineError('WORKFLOW', `Unexpected execution status ${col.string(row, 'status')}`);
  const trigger = col.json(row, 'trigger');
  const rawError = col.json(row, 'error');
  const failure = asFailure(rawError);
  const finishedAt = col.optionalEpoch(row, 'finished_at');
  return {
    id: col.string(row, 'id'),
    workflowId: col.string(row, 'workflow_id'),
    workflowVersion: col.number(row, 'workflow_version'),
    workspaceId: col.string(row, 'workspace_id'),
    status,
    trigger: {
      nodeId: isRecord(trigger) && typeof trigger.nodeId === 'string' ? trigger.nodeId : '',
      payload: isRecord(trigger) ? trigger.payload : undefined,
    },
    nodes: asNodes(col.json(row, 'nodes')),
    edges: asEdges(col.json(row, 'edges')),
    startedAt: col.epoch(row, 'started_at'),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(failure && isRecord(rawError) && typeof rawError.nodeId === 'string' ? { error: { ...failure, nodeId: rawError.nodeId } } : {}),
  };
};

const toStep = (row: SqlRow): StepRecord => {
  const status = STEP_STATUSES.find((candidate) => candidate === col.string(row, 'status')) ?? 'failed';
  const port = col.optionalString(row, 'port');
  const error = asFailure(col.json(row, 'error'));
  return {
    executionId: col.string(row, 'execution_id'),
    nodeId: col.string(row, 'node_id'),
    attempt: col.number(row, 'attempt'),
    status,
    ...(port ? { port } : {}),
    input: col.json(row, 'input') ?? undefined,
    output: col.json(row, 'output') ?? undefined,
    ...(error ? { error } : {}),
    startedAt: col.epoch(row, 'started_at'),
    durationMs: col.number(row, 'duration_ms'),
  };
};

export type PgExecutionStore = ExecutionStore & {
  listByWorkspace: (workspaceId: string, options: { workflowId?: string; status?: ExecutionStatus; limit: number }) => Promise<Execution[]>;
};

/**
 * Optimistic concurrency: the store remembers the revision it last read or
 * wrote for each execution and only writes if the row still has it. Two
 * workers touching one execution can therefore never silently overwrite
 * each other; the loser gets ConcurrentModificationError and its job retries.
 */
export const createPgExecutionStore = (sql: SqlClient): PgExecutionStore => {
  const revisions = new Map<string, number>();
  // Finished executions are never written again, so only live ones need tracking.
  const isLive = (status: ExecutionStatus) => status === 'running' || status === 'waiting';

  // Parallel branches of one run save the same execution at the same moment; writes are
  // chained per execution so this process never races itself on the revision check.
  const writeChains = new Map<string, Promise<void>>();
  const serialized = (id: string, write: () => Promise<void>): Promise<void> => {
    const previous = writeChains.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(write);
    writeChains.set(id, next);
    return next.finally(() => {
      if (writeChains.get(id) === next) writeChains.delete(id);
    });
  };

  const remember = (row: SqlRow): Execution => {
    const execution = toExecution(row);
    if (isLive(execution.status)) revisions.set(execution.id, col.number(row, 'revision'));
    else revisions.delete(execution.id);
    return execution;
  };

  const write = async (execution: Execution): Promise<void> => {
      const values = [
        execution.id,
        execution.status,
        jsonParam(execution.nodes),
        jsonParam(execution.edges),
        execution.error ? jsonParam(execution.error) : null,
        optionalTs(execution.finishedAt),
      ];
      const known = revisions.get(execution.id);
      if (known === undefined) {
        const rows = await sql.query(
          `INSERT INTO executions (id, status, nodes, edges, error, finished_at, workflow_id, workflow_version, workspace_id, trigger, started_at, revision)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::timestamptz, $7, $8::int, $9, $10::jsonb, $11::timestamptz, 1)
           ON CONFLICT (id) DO NOTHING RETURNING revision`,
          [...values, execution.workflowId, execution.workflowVersion, execution.workspaceId, jsonParam(execution.trigger), ts(execution.startedAt)],
        );
        if (rows.length === 0) throw new ConcurrentModificationError(`Execution ${execution.id} was created elsewhere`);
        if (isLive(execution.status)) revisions.set(execution.id, 1);
        return;
      }
      const rows = await sql.query(
        `UPDATE executions SET status = $2, nodes = $3::jsonb, edges = $4::jsonb, error = $5::jsonb, finished_at = $6::timestamptz,
           revision = revision + 1
         WHERE id = $1 AND revision = $7::int RETURNING revision`,
        [...values, known],
      );
      const [row] = rows;
      if (!row) {
        revisions.delete(execution.id);
        throw new ConcurrentModificationError(`Execution ${execution.id} changed since it was read`);
      }
      if (isLive(execution.status)) revisions.set(execution.id, col.number(row, 'revision'));
      else revisions.delete(execution.id);
  };

  return {
    // The engine mutates the execution in place, so a queued write always stores the newest state.
    save: (execution) => serialized(execution.id, () => write(execution)),

    get: async (id) => {
      const [row] = await sql.query('SELECT * FROM executions WHERE id = $1', [id]);
      return row ? remember(row) : undefined;
    },

    listByWorkflow: async (workflowId) =>
      (await sql.query('SELECT * FROM executions WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT 100', [workflowId])).map(remember),

    listWaiting: async () => (await sql.query("SELECT * FROM executions WHERE status = 'waiting' ORDER BY started_at LIMIT 500")).map(remember),

    listByWorkspace: async (workspaceId, { workflowId, status, limit }) =>
      (
        await sql.query(
          `SELECT * FROM executions WHERE workspace_id = $1 AND ($2::text IS NULL OR workflow_id = $2) AND ($3::text IS NULL OR status = $3)
           ORDER BY started_at DESC LIMIT $4::int`,
          [workspaceId, workflowId ?? null, status ?? null, limit],
        )
      ).map(remember),

    appendStep: async (step) => {
      await sql.query(
        `INSERT INTO execution_steps (execution_id, node_id, attempt, status, port, input, output, error, started_at, duration_ms)
         VALUES ($1, $2, $3::int, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::timestamptz, $10::int) RETURNING id`,
        [
          step.executionId,
          step.nodeId,
          step.attempt,
          step.status,
          step.port ?? null,
          step.input === undefined ? null : jsonParam(step.input),
          step.output === undefined ? null : jsonParam(step.output),
          step.error ? jsonParam(step.error) : null,
          ts(step.startedAt),
          Math.round(step.durationMs),
        ],
      );
    },

    steps: async (executionId) => (await sql.query('SELECT * FROM execution_steps WHERE execution_id = $1 ORDER BY id', [executionId])).map(toStep),
  };
};
