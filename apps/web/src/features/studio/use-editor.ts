import { useCallback, useMemo, useReducer } from 'react';
import type { DataLink } from '../../lib/studio/data';
import { graphAt, type GraphPath } from '../../lib/studio/graph';
import { createHistory, record, redo, seal, undo, type History } from '../../lib/studio/history';
import type { JackKind } from '../../lib/studio/layout';
import type { WorkflowGraph, WorkflowSettings } from '../../lib/types';

/** Everything that becomes a saved version. */
export type Doc = { name: string; graph: WorkflowGraph; settings: WorkflowSettings };

export type Selection = { kind: 'none' } | { kind: 'nodes'; ids: readonly string[] } | { kind: 'edge'; id: string } | { kind: 'data'; link: DataLink };

/** An output jack chosen by click or keyboard, waiting for its input. */
export type PendingConnection = { nodeId: string; port: string; kind: JackKind };

type State = {
  history: History<Doc>;
  path: GraphPath;
  selection: Selection;
  pending: PendingConnection | undefined;
  /** The version the editor started from; saving sends it as expectedVersion. */
  baseVersion: number;
  saved: Doc;
};

type Action =
  | { type: 'change'; update: (graph: WorkflowGraph) => WorkflowGraph; group: string | undefined; select: Selection | undefined }
  | { type: 'doc'; update: (doc: Doc) => Doc; group: string | undefined }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'seal' }
  | { type: 'select'; selection: Selection }
  | { type: 'path'; path: GraphPath }
  | { type: 'pending'; pending: PendingConnection | undefined }
  | { type: 'saved'; doc: Doc; version: number }
  | { type: 'load'; doc: Doc; baseVersion: number; saved: Doc };

const NONE: Selection = { kind: 'none' };

const withGraphAt = (root: WorkflowGraph, path: GraphPath, update: (graph: WorkflowGraph) => WorkflowGraph): WorkflowGraph => {
  const [loopId, ...rest] = path;
  if (loopId === undefined) return update(root);
  return { ...root, nodes: root.nodes.map((node) => (node.id === loopId && node.kind === 'loop' ? { ...node, body: withGraphAt(node.body, rest, update) } : node)) };
};

/** Drops selected ids that no longer exist (after undo, for instance). */
const validSelection = (selection: Selection, graph: WorkflowGraph | undefined): Selection => {
  if (!graph) return NONE;
  if (selection.kind === 'nodes') {
    const ids = selection.ids.filter((id) => graph.nodes.some((node) => node.id === id));
    return ids.length === 0 ? NONE : ids.length === selection.ids.length ? selection : { kind: 'nodes', ids };
  }
  if (selection.kind === 'edge') return graph.edges.some((edge) => edge.id === selection.id) ? selection : NONE;
  if (selection.kind === 'data') return graph.nodes.some((node) => node.id === selection.link.toNodeId) ? selection : NONE;
  return selection;
};

/** A loop that was removed (or undone) cannot stay open. */
const validPath = (path: GraphPath, root: WorkflowGraph): GraphPath => {
  for (let depth = path.length; depth > 0; depth -= 1) if (graphAt(root, path.slice(0, depth))) return path.slice(0, depth);
  return [];
};

const settle = (state: State, history: History<Doc>, selection: Selection = state.selection): State => {
  const path = validPath(state.path, history.present.graph);
  return { ...state, history, path, selection: validSelection(selection, graphAt(history.present.graph, path)) };
};

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'change': {
      const doc = state.history.present;
      const graph = withGraphAt(doc.graph, state.path, action.update);
      if (graph === doc.graph) return action.select ? { ...state, selection: action.select } : state;
      return settle(state, record(state.history, { ...doc, graph }, action.group), action.select);
    }
    case 'doc':
      return settle(state, record(state.history, action.update(state.history.present), action.group));
    case 'undo':
      return settle({ ...state, pending: undefined }, undo(state.history));
    case 'redo':
      return settle({ ...state, pending: undefined }, redo(state.history));
    case 'seal':
      return { ...state, history: seal(state.history) };
    case 'select':
      return { ...state, selection: action.selection };
    case 'path':
      return { ...state, path: action.path, selection: NONE, pending: undefined };
    case 'pending':
      return { ...state, pending: action.pending };
    case 'saved':
      return { ...state, baseVersion: action.version, saved: action.doc };
    case 'load':
      return { history: createHistory(action.doc), path: [], selection: NONE, pending: undefined, baseVersion: action.baseVersion, saved: action.saved };
  }
};

export const useEditor = (initial: { doc: Doc; baseVersion: number; saved: Doc }) => {
  const [state, dispatch] = useReducer(reducer, initial, (start): State => ({
    history: createHistory(start.doc),
    path: [],
    selection: NONE,
    pending: undefined,
    baseVersion: start.baseVersion,
    saved: start.saved,
  }));

  const actions = useMemo(
    () => ({
      /** Changes the graph being edited (the workflow, or the open loop body). */
      change: (update: (graph: WorkflowGraph) => WorkflowGraph, options: { group?: string; select?: Selection } = {}) =>
        dispatch({ type: 'change', update, group: options.group, select: options.select }),
      updateDoc: (update: (doc: Doc) => Doc, group?: string) => dispatch({ type: 'doc', update, group }),
      undo: () => dispatch({ type: 'undo' }),
      redo: () => dispatch({ type: 'redo' }),
      seal: () => dispatch({ type: 'seal' }),
      select: (selection: Selection) => dispatch({ type: 'select', selection }),
      openPath: (path: GraphPath) => dispatch({ type: 'path', path }),
      setPending: (pending: PendingConnection | undefined) => dispatch({ type: 'pending', pending }),
      markSaved: (doc: Doc, version: number) => dispatch({ type: 'saved', doc, version }),
      load: (doc: Doc, baseVersion: number, saved: Doc) => dispatch({ type: 'load', doc, baseVersion, saved }),
    }),
    [],
  );

  const doc = state.history.present;
  const graph = graphAt(doc.graph, state.path) ?? doc.graph;
  const dirty = useMemo(() => JSON.stringify(doc) !== JSON.stringify(state.saved), [doc, state.saved]);
  const canUndo = state.history.past.length > 0;
  const canRedo = state.history.future.length > 0;
  const selectedIds = useCallback((): readonly string[] => (state.selection.kind === 'nodes' ? state.selection.ids : []), [state.selection]);

  return { ...state, doc, graph, dirty, canUndo, canRedo, selectedIds, actions };
};

export type Editor = ReturnType<typeof useEditor>;
