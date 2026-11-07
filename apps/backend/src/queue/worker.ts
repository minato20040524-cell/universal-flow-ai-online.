import { isRetryable, systemClock, type Clock } from '@universal-flow/core-engine';
import type { Job, JobQueue } from './job-queue.js';

export type JobHandler = (job: Job) => Promise<void>;

export type WorkerOptions = {
  queue: JobQueue;
  handlers: Record<string, JobHandler>;
  workerId: string;
  clock?: Clock;
  batchSize?: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  onError?: (job: Job, error: unknown) => void;
};

export type Worker = {
  /** Claims and runs one batch; returns how many jobs it ran. */
  tick: () => Promise<number>;
  /** Runs ticks until stop() is called. */
  start: () => void;
  stop: () => Promise<void>;
};

export const retryDelay = (attempt: number, baseMs: number, maxMs: number): number => Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));

export const createWorker = (options: WorkerOptions): Worker => {
  const clock = options.clock ?? systemClock;
  const batchSize = options.batchSize ?? 5;
  const leaseMs = options.leaseMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const baseRetryDelayMs = options.baseRetryDelayMs ?? 5_000;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 15 * 60_000;
  const state: { running: boolean; loop: Promise<void> | undefined } = { running: false, loop: undefined };

  const runJob = async (job: Job): Promise<void> => {
    const handler = options.handlers[job.type];
    // Renew the lease while a long job runs, so no other worker takes it over.
    const renew = setInterval(() => {
      void options.queue.extendLease(job.id, options.workerId, leaseMs).catch(() => undefined);
    }, Math.max(1_000, leaseMs / 3));
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(job);
      await options.queue.complete(job.id, options.workerId);
    } catch (error) {
      options.onError?.(job, error);
      const message = error instanceof Error ? error.message : String(error);
      const canRetry = handler !== undefined && isRetryable(error) && job.attempts < job.maxAttempts;
      const retryAt = canRetry ? clock.now() + retryDelay(job.attempts, baseRetryDelayMs, maxRetryDelayMs) : undefined;
      await options.queue.fail(job.id, options.workerId, message, retryAt);
    } finally {
      clearInterval(renew);
    }
  };

  const tick = async (): Promise<number> => {
    const jobs = await options.queue.claim(options.workerId, { limit: batchSize, leaseMs });
    await Promise.all(jobs.map(runJob));
    return jobs.length;
  };

  return {
    tick,
    start: () => {
      if (state.running) return;
      state.running = true;
      state.loop = (async () => {
        while (state.running) {
          const ran = await tick().catch((error: unknown) => {
            console.error('[worker] tick failed', error);
            return 0;
          });
          if (ran === 0 && state.running) await clock.sleep(pollIntervalMs);
        }
      })();
    },
    stop: async () => {
      state.running = false;
      await state.loop;
    },
  };
};
