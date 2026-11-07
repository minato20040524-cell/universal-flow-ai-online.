import type { Execution, StepRecord } from './types.js';

/** Persistence for executions and their step history (PostgreSQL in production). */
export type ExecutionStore = {
  save: (execution: Execution) => Promise<void>;
  get: (id: string) => Promise<Execution | undefined>;
  listByWorkflow: (workflowId: string) => Promise<Execution[]>;
  listWaiting: () => Promise<Execution[]>;
  appendStep: (step: StepRecord) => Promise<void>;
  steps: (executionId: string) => Promise<StepRecord[]>;
};

export const createInMemoryExecutionStore = (): ExecutionStore => {
  const executions = new Map<string, Execution>();
  const stepLog = new Map<string, StepRecord[]>();
  const copy = <T>(value: T): T => structuredClone(value);

  return {
    save: async (execution) => {
      executions.set(execution.id, copy(execution));
    },
    get: async (id) => {
      const execution = executions.get(id);
      return execution ? copy(execution) : undefined;
    },
    listByWorkflow: async (workflowId) =>
      [...executions.values()].filter((execution) => execution.workflowId === workflowId).map(copy),
    listWaiting: async () => [...executions.values()].filter((execution) => execution.status === 'waiting').map(copy),
    appendStep: async (step) => {
      const steps = stepLog.get(step.executionId) ?? [];
      steps.push(copy(step));
      stepLog.set(step.executionId, steps);
    },
    steps: async (executionId) => (stepLog.get(executionId) ?? []).map(copy),
  };
};
