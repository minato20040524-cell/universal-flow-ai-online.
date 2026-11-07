/**
 * Undo and redo for the editor. Changes that belong together (a drag, typing
 * in one field) share a `group` and become one step.
 */

export type History<T> = { past: T[]; present: T; future: T[]; group: string | undefined };

const LIMIT = 100;

export const createHistory = <T>(present: T): History<T> => ({ past: [], present, future: [], group: undefined });

export const record = <T>(history: History<T>, next: T, group?: string): History<T> => {
  if (Object.is(next, history.present)) return history;
  if (group !== undefined && group === history.group) return { ...history, present: next, future: [] };
  return { past: [...history.past, history.present].slice(-LIMIT), present: next, future: [], group };
};

export const undo = <T>(history: History<T>): History<T> => {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future], group: undefined };
};

export const redo = <T>(history: History<T>): History<T> => {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: rest, group: undefined };
};

/** Ends the current group, so the next change is its own undo step. */
export const seal = <T>(history: History<T>): History<T> => (history.group === undefined ? history : { ...history, group: undefined });
