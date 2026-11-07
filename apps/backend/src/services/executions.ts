import { EngineError, isRecord, type ExecutionStatus } from '@universal-flow/core-engine';
import type { AppContext } from '../context.js';
import type { AuthContext } from '../http/types.js';
import { JOB_TYPES, type ResolveApprovalPayload } from '../queue/job-types.js';

export const createExecutionService = (ctx: AppContext) => {
  const ownedExecution = async (auth: AuthContext, id: string) => {
    const execution = await ctx.executions.get(id);
    if (!execution || execution.workspaceId !== auth.workspaceId) throw new EngineError('NOT_FOUND', `Execution ${id} does not exist`);
    return execution;
  };

  return {
    list: (auth: AuthContext, filter: { workflowId?: string; status?: ExecutionStatus; limit: number }) => ctx.executions.listByWorkspace(auth.workspaceId, filter),

    /** An execution that a worker has not picked up yet is reported as queued. */
    get: async (auth: AuthContext, id: string) => {
      const execution = await ctx.executions.get(id);
      if (execution && execution.workspaceId === auth.workspaceId) return { execution, steps: await ctx.executions.steps(id) };
      const job = await ctx.queue.findByExecutionId(id);
      if (job && isRecord(job.payload) && job.payload.workspaceId === auth.workspaceId) {
        return { execution: { id, status: job.status === 'dead' ? 'failed' : 'queued', error: job.lastError }, steps: [] };
      }
      throw new EngineError('NOT_FOUND', `Execution ${id} does not exist`);
    },

    /** User Approval: the decision is queued so the rest of the workflow runs on a worker, not in this request. */
    decide: async (auth: AuthContext, id: string, nodeId: string, decision: { approved: boolean; comment?: string }) => {
      const execution = await ownedExecution(auth, id);
      const node = execution.nodes[nodeId];
      if (execution.status !== 'waiting' || node?.status !== 'waiting' || node.waitingFor !== 'approval') {
        throw new EngineError('CONFLICT', `Node ${nodeId} is not waiting for approval`);
      }
      const payload: ResolveApprovalPayload = {
        executionId: id,
        workflowId: execution.workflowId,
        version: execution.workflowVersion,
        nodeId,
        approved: decision.approved,
        by: auth.actor,
        comment: decision.comment,
      };
      const { job, created } = await ctx.queue.enqueue({ type: JOB_TYPES.resolveApproval, payload, concurrencyKey: id, dedupeKey: `approval:${id}:${nodeId}` });
      if (!created) throw new EngineError('CONFLICT', `A decision for ${nodeId} was already submitted`);
      await ctx.workspaces.audit({ workspaceId: auth.workspaceId, actor: auth.actor, action: decision.approved ? 'execution.approve' : 'execution.reject', target: id, details: { nodeId } }, ctx.clock.now());
      return { executionId: id, jobId: job.id };
    },

    cancel: async (auth: AuthContext, id: string) => {
      await ownedExecution(auth, id);
      const execution = await ctx.engine.cancel(id);
      await ctx.workspaces.audit({ workspaceId: auth.workspaceId, actor: auth.actor, action: 'execution.cancel', target: id }, ctx.clock.now());
      return execution;
    },
  };
};

export type ExecutionService = ReturnType<typeof createExecutionService>;
