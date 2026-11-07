import type { WorkflowGraph, WorkflowSettings } from '../types.js';

/**
 * Unsaved work is kept in this browser until it is saved as a version, so a
 * reload or a trip to connect an account loses nothing. Drafts hold the graph
 * only; accounts are referenced by id and secrets never reach the browser.
 */

export type Draft = { baseVersion: number; name: string; graph: WorkflowGraph; settings: WorkflowSettings; savedAt: number };

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

const keyFor = (workspaceId: string, workflowId: string) => `uf.draft.${workspaceId}.${workflowId}`;

const isDraft = (value: unknown): value is Draft =>
  typeof value === 'object' &&
  value !== null &&
  'baseVersion' in value &&
  typeof value.baseVersion === 'number' &&
  'name' in value &&
  typeof value.name === 'string' &&
  'graph' in value &&
  typeof value.graph === 'object' &&
  value.graph !== null &&
  'nodes' in value.graph &&
  Array.isArray(value.graph.nodes) &&
  'edges' in value.graph &&
  Array.isArray(value.graph.edges) &&
  'savedAt' in value &&
  typeof value.savedAt === 'number';

const browserStorage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

export const createDraftStore = (storage: Storage | undefined = browserStorage()) => ({
  load: (workspaceId: string, workflowId: string): Draft | undefined => {
    try {
      const text = storage?.getItem(keyFor(workspaceId, workflowId));
      const value: unknown = text ? JSON.parse(text) : undefined;
      return isDraft(value) ? value : undefined;
    } catch {
      return undefined;
    }
  },
  save: (workspaceId: string, workflowId: string, draft: Draft): void => {
    try {
      storage?.setItem(keyFor(workspaceId, workflowId), JSON.stringify(draft));
    } catch {
      // Storage full or blocked: the editor keeps working, only the safety copy is lost.
    }
  },
  clear: (workspaceId: string, workflowId: string): void => {
    try {
      storage?.removeItem(keyFor(workspaceId, workflowId));
    } catch {
      // Nothing to clean up.
    }
  },
});

export type DraftStore = ReturnType<typeof createDraftStore>;
