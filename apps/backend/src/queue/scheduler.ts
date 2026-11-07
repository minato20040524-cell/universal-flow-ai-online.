import { createId, nextCronRun, systemClock, type Clock } from '@universal-flow/core-engine';
import type { TriggerRepository } from '../repositories/trigger-repository.js';
import type { JobQueue } from './job-queue.js';
import { JOB_TYPES, type RunWorkflowPayload } from './job-types.js';

export type SchedulerOptions = {
  triggers: TriggerRepository;
  queue: JobQueue;
  clock?: Clock;
  leaseMs?: number;
  batchSize?: number;
  pollIntervalMs?: number;
};

export type Scheduler = {
  tick: () => Promise<number>;
  start: () => void;
  stop: () => Promise<void>;
};

/**
 * Turns due cron schedules into workflow.run jobs. Each occurrence gets a
 * dedupe key, so even two schedulers racing after a lease expiry enqueue it once.
 * Occurrences missed while the scheduler was down are not replayed one by one:
 * the next run is computed from now.
 */
export const createScheduler = (options: SchedulerOptions): Scheduler => {
  const clock = options.clock ?? systemClock;
  const leaseMs = options.leaseMs ?? 30_000;
  const batchSize = options.batchSize ?? 50;
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;
  const state: { running: boolean; loop: Promise<void> | undefined } = { running: false, loop: undefined };

  const tick = async (): Promise<number> => {
    const now = clock.now();
    const due = await options.triggers.claimDueSchedules(now, leaseMs, batchSize);
    for (const schedule of due) {
      const payload: RunWorkflowPayload = {
        workspaceId: schedule.workspaceId,
        workflowId: schedule.workflowId,
        version: schedule.workflowVersion,
        triggerNodeId: schedule.triggerNodeId,
        payload: { scheduledFor: new Date(schedule.nextRunAt).toISOString(), cron: schedule.cron, timezone: schedule.timezone },
        executionId: createId('exec'),
      };
      await options.queue.enqueue({
        type: JOB_TYPES.runWorkflow,
        payload,
        concurrencyKey: payload.executionId,
        dedupeKey: `schedule:${schedule.workflowId}:${schedule.triggerNodeId}:${schedule.nextRunAt}`,
      });
      await options.triggers.advanceSchedule(schedule, nextCronRun(schedule.cron, Math.max(now, schedule.nextRunAt), schedule.timezone));
    }
    return due.length;
  };

  return {
    tick,
    start: () => {
      if (state.running) return;
      state.running = true;
      state.loop = (async () => {
        while (state.running) {
          await tick().catch((error: unknown) => console.error('[scheduler] tick failed', error));
          if (state.running) await clock.sleep(pollIntervalMs);
        }
      })();
    },
    stop: async () => {
      state.running = false;
      await state.loop;
    },
  };
};
