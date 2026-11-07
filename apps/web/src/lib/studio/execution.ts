import type { Lamp } from '../presentation.js';
import type { EdgeState, Execution, ExecutionDetail, NodeRun, QueuedExecution, StepRecord } from '../types.js';
import type { GraphPath } from './graph.js';

/** How a run looks on the stage: lamps on boards, lit or dead cables. */

export const isExecution = (value: Execution | QueuedExecution): value is Execution => 'nodes' in value;

export const isFinished = (status: string): boolean => status === 'succeeded' || status === 'failed' || status === 'cancelled';

export const executionLamp = (execution: Execution | QueuedExecution): Lamp => {
  switch (execution.status) {
    case 'queued':
      return { tone: 'attention', label: 'Queued' };
    case 'running':
      return { tone: 'attention', label: 'Running' };
    case 'waiting':
      return { tone: 'attention', label: isExecution(execution) && Object.values(execution.nodes).some((run) => run.waitingFor === 'approval') ? 'Waiting for approval' : 'Waiting' };
    case 'succeeded':
      return { tone: 'ready', label: 'Succeeded' };
    case 'failed':
      return { tone: 'fault', label: 'Failed' };
    case 'cancelled':
      return { tone: 'off', label: 'Cancelled' };
  }
};

export type RunTone = 'running' | 'ready' | 'fault' | 'waiting' | 'off';
export type NodeRunView = { tone: RunTone; label: string; run: NodeRun | undefined };

export const nodeRunView = (run: NodeRun | undefined): NodeRunView | undefined => {
  if (!run) return undefined;
  switch (run.status) {
    case 'pending':
      return undefined;
    case 'running':
      return { tone: 'running', label: run.attempts > 1 ? `Running, attempt ${run.attempts}` : 'Running', run };
    case 'succeeded':
      return { tone: 'ready', label: run.output && typeof run.output === 'object' && 'error' in run.output ? 'Failed, continued' : 'Done', run };
    case 'failed':
      return { tone: 'fault', label: run.port === 'error' ? 'Failed, sent to Error' : 'Failed', run };
    case 'skipped':
      return { tone: 'off', label: 'Skipped', run };
    case 'waiting':
      return { tone: 'waiting', label: run.waitingFor === 'approval' ? 'Waiting for approval' : 'Waiting', run };
  }
};

/**
 * Board states for the graph being shown. The engine keeps the state of the
 * workflow's own steps; inside a loop only step records exist, so the latest
 * record per body step is used (`loop[2].child`).
 */
export const runViewsFor = (detail: ExecutionDetail | undefined, path: GraphPath): Map<string, NodeRunView> => {
  const views = new Map<string, NodeRunView>();
  if (!detail || !isExecution(detail.execution)) return views;
  if (path.length === 0) {
    for (const [nodeId, run] of Object.entries(detail.execution.nodes)) {
      const view = nodeRunView(run);
      if (view) views.set(nodeId, view);
    }
    return views;
  }
  const prefix = path.map((loopId) => `${loopId}\\[\\d+\\]\\.`).join('');
  const pattern = new RegExp(`^${prefix}([A-Za-z][\\w-]*)$`);
  const counts = new Map<string, { done: number; failed: number }>();
  for (const step of detail.steps) {
    const nodeId = pattern.exec(step.nodeId)?.[1];
    if (!nodeId) continue;
    const count = counts.get(nodeId) ?? { done: 0, failed: 0 };
    if (step.status === 'failed') count.failed += 1;
    else if (step.status === 'succeeded') count.done += 1;
    counts.set(nodeId, count);
  }
  for (const [nodeId, count] of counts) {
    const label = count.failed > 0 ? `${count.failed} failed, ${count.done} done` : `Done ${count.done} ${count.done === 1 ? 'time' : 'times'}`;
    views.set(nodeId, { tone: count.failed > 0 ? 'fault' : 'ready', label, run: undefined });
  }
  return views;
};

export const edgeStatesFor = (detail: ExecutionDetail | undefined, path: GraphPath): Record<string, EdgeState> =>
  detail && isExecution(detail.execution) && path.length === 0 ? detail.execution.edges : {};

/** Step records of one board, oldest first. Inside a loop there is one per iteration. */
export const stepsOf = (steps: readonly StepRecord[], path: GraphPath, nodeId: string): StepRecord[] => {
  if (path.length === 0) return steps.filter((step) => step.nodeId === nodeId);
  const prefix = path.map((loopId) => `${loopId}\\[\\d+\\]\\.`).join('');
  const pattern = new RegExp(`^${prefix}${nodeId.replace(/[-]/g, '\\-')}$`);
  return steps.filter((step) => pattern.test(step.nodeId));
};

export const pendingApprovals = (execution: Execution | QueuedExecution | undefined): string[] =>
  execution && isExecution(execution) && execution.status === 'waiting'
    ? Object.entries(execution.nodes).flatMap(([nodeId, run]) => (run.status === 'waiting' && run.waitingFor === 'approval' ? [nodeId] : []))
    : [];

/** The message the approver reads; the engine renders it when the step starts waiting. */
export const approvalMessage = (run: NodeRun | undefined): string | undefined => {
  const output = run?.output;
  return output && typeof output === 'object' && 'message' in output && typeof output.message === 'string' ? output.message : undefined;
};

export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
};

/** How often to ask the server again: fast while steps move, slow while someone has to decide. */
export const pollDelayFor = (status: string): number | undefined => {
  if (status === 'queued' || status === 'running') return 700;
  if (status === 'waiting') return 2500;
  return undefined;
};
