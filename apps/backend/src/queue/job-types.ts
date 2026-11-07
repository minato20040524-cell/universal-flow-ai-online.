import { ValidationError, isRecord } from '@universal-flow/core-engine';

export const JOB_TYPES = {
  runWorkflow: 'workflow.run',
  resumeDelay: 'workflow.resume-delay',
  resolveApproval: 'workflow.resolve-approval',
} as const;

export type RunWorkflowPayload = {
  workspaceId: string;
  workflowId: string;
  version: number;
  triggerNodeId: string | undefined;
  payload: unknown;
  /** Chosen when the job is enqueued, so a retried job continues the same execution instead of starting a new one. */
  executionId: string;
};

export type ResumeDelayPayload = { executionId: string; workflowId: string; version: number; nodeId: string };

export type ResolveApprovalPayload = {
  executionId: string;
  workflowId: string;
  version: number;
  nodeId: string;
  approved: boolean;
  by: string;
  comment: string | undefined;
};

const invalid = (type: string) => new ValidationError(`Invalid ${type} job payload`, [{ path: 'payload', message: 'has the wrong shape' }]);

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export const parseRunWorkflow = (payload: unknown): RunWorkflowPayload => {
  if (
    !isRecord(payload) ||
    typeof payload.workspaceId !== 'string' ||
    typeof payload.workflowId !== 'string' ||
    typeof payload.version !== 'number' ||
    typeof payload.executionId !== 'string'
  ) {
    throw invalid(JOB_TYPES.runWorkflow);
  }
  return {
    workspaceId: payload.workspaceId,
    workflowId: payload.workflowId,
    version: payload.version,
    triggerNodeId: optionalString(payload.triggerNodeId),
    payload: payload.payload,
    executionId: payload.executionId,
  };
};

export const parseResumeDelay = (payload: unknown): ResumeDelayPayload => {
  if (
    !isRecord(payload) ||
    typeof payload.executionId !== 'string' ||
    typeof payload.workflowId !== 'string' ||
    typeof payload.version !== 'number' ||
    typeof payload.nodeId !== 'string'
  ) {
    throw invalid(JOB_TYPES.resumeDelay);
  }
  return { executionId: payload.executionId, workflowId: payload.workflowId, version: payload.version, nodeId: payload.nodeId };
};

export const parseResolveApproval = (payload: unknown): ResolveApprovalPayload => {
  if (
    !isRecord(payload) ||
    typeof payload.executionId !== 'string' ||
    typeof payload.workflowId !== 'string' ||
    typeof payload.version !== 'number' ||
    typeof payload.nodeId !== 'string' ||
    typeof payload.approved !== 'boolean' ||
    typeof payload.by !== 'string'
  ) {
    throw invalid(JOB_TYPES.resolveApproval);
  }
  return {
    executionId: payload.executionId,
    workflowId: payload.workflowId,
    version: payload.version,
    nodeId: payload.nodeId,
    approved: payload.approved,
    by: payload.by,
    comment: optionalString(payload.comment),
  };
};
