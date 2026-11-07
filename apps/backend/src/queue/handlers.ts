import { EngineError, pendingResumes, type Execution, type Workflow } from '@universal-flow/core-engine';
import type { AppContext } from '../context.js';
import { JOB_TYPES, parseResolveApproval, parseResumeDelay, parseRunWorkflow, type ResumeDelayPayload } from './job-types.js';
import type { JobHandler } from './worker.js';

/** Job handlers that advance executions. All jobs of one execution share a concurrency key. */
export const createJobHandlers = (ctx: AppContext): Record<string, JobHandler> => {
  const loadWorkflow = async (workflowId: string, version: number): Promise<Workflow> => {
    const workflow = await ctx.workflows.loadForExecution(workflowId, version);
    if (!workflow) throw new EngineError('NOT_FOUND', `Workflow ${workflowId} v${version} no longer exists`);
    return workflow;
  };

  /** A paused delay becomes a job due at its resume time. */
  const scheduleResumes = async (execution: Execution): Promise<void> => {
    for (const { nodeId, resumeAt } of pendingResumes(execution)) {
      const payload: ResumeDelayPayload = { executionId: execution.id, workflowId: execution.workflowId, version: execution.workflowVersion, nodeId };
      await ctx.queue.enqueue({
        type: JOB_TYPES.resumeDelay,
        payload,
        runAt: resumeAt,
        concurrencyKey: execution.id,
        dedupeKey: `resume:${execution.id}:${nodeId}:${resumeAt}`,
      });
    }
  };

  /**
   * With one job per execution at a time, an execution still marked running
   * when its job starts was left behind by a worker that died mid-run.
   */
  const continueIfInterrupted = async (workflow: Workflow, execution: Execution): Promise<Execution> =>
    execution.status === 'running' ? ctx.engine.recover(workflow, execution.id) : execution;

  return {
    [JOB_TYPES.runWorkflow]: async (job) => {
      const payload = parseRunWorkflow(job.payload);
      const workflow = await loadWorkflow(payload.workflowId, payload.version);
      // A retried job (worker crash) continues the execution it already started.
      const execution = (await ctx.executions.get(payload.executionId))
        ? await ctx.engine.recover(workflow, payload.executionId)
        : await ctx.engine.start(workflow, {
            executionId: payload.executionId,
            payload: payload.payload,
            ...(payload.triggerNodeId ? { triggerNodeId: payload.triggerNodeId } : {}),
          });
      await scheduleResumes(execution);
    },

    [JOB_TYPES.resumeDelay]: async (job) => {
      const payload = parseResumeDelay(job.payload);
      const workflow = await loadWorkflow(payload.workflowId, payload.version);
      const execution = await continueIfInterrupted(workflow, await ctx.engine.resumeDelay(workflow, payload.executionId, payload.nodeId));
      await scheduleResumes(execution);
    },

    [JOB_TYPES.resolveApproval]: async (job) => {
      const payload = parseResolveApproval(job.payload);
      const workflow = await loadWorkflow(payload.workflowId, payload.version);
      try {
        const execution = await ctx.engine.resolveApproval(workflow, payload.executionId, payload.nodeId, {
          approved: payload.approved,
          by: payload.by,
          ...(payload.comment ? { comment: payload.comment } : {}),
        });
        await scheduleResumes(execution);
      } catch (error) {
        // A retry after the first attempt got the decision through: finish that run if it was cut short.
        const current = await ctx.executions.get(payload.executionId);
        const stillWaiting = current?.status === 'waiting' && current.nodes[payload.nodeId]?.waitingFor === 'approval';
        if (!(error instanceof EngineError && error.code === 'CONFLICT') || stillWaiting || !current) throw error;
        await scheduleResumes(await continueIfInterrupted(workflow, current));
      }
    },
  };
};
