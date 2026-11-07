import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../lib/api';
import { pollDelayFor } from '../../lib/studio/execution';
import type { ExecutionDetail } from '../../lib/types';

/**
 * Follows one execution: polls quickly while steps move, slowly while it waits
 * for a person, and stops once it has finished.
 */
export const useExecution = (api: ApiClient, executionId: string | undefined, onFinished: () => void) => {
  const [detail, setDetail] = useState<ExecutionDetail | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setDetail(undefined);
    setError(undefined);
  }, [executionId]);

  useEffect(() => {
    if (!executionId) return;
    let active = true;
    const load = async () => {
      try {
        const next = await api.execution(executionId);
        if (!active) return;
        setDetail(next);
        setError(undefined);
        const delay = pollDelayFor(next.execution.status);
        if (delay === undefined) finished.current();
        else timer.current = window.setTimeout(() => void load(), delay);
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
        timer.current = window.setTimeout(() => void load(), 4000);
      }
    };
    void load();
    return () => {
      active = false;
      window.clearTimeout(timer.current);
    };
  }, [api, executionId, tick]);

  /** Asks again now, e.g. right after an approval was sent. */
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  return { detail, error, refresh };
};
