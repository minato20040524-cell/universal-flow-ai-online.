import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { dataLinksOf, dataSourcesFor, linkInput, unlinkInput } from '../../lib/studio/data';
import { nodeSummary, nodeTitle } from '../../lib/studio/describe';
import { createDraftStore, type Draft } from '../../lib/studio/draft';
import { edgeStatesFor, executionLamp, isExecution, runViewsFor, stepsOf } from '../../lib/studio/execution';
import {
  addNode,
  allNodeIds,
  connect,
  createNode,
  findNode,
  moveNodes,
  portsOf,
  primaryPortOf,
  removeEdge,
  removeNodes,
  replaceNode,
  repinNode,
  resolveDefinition,
  suggestNodeId,
  type GraphPath,
} from '../../lib/studio/graph';
import { checkWorkflow, hasErrors, issuesForNode, issuesFromServer, locate, type StudioIssue } from '../../lib/studio/issues';
import { GEOMETRY, UNIT_PX, autoLayout, freeSpot, layoutBoard, positionOf } from '../../lib/studio/layout';
import { samplePayload } from '../../lib/studio/templates';
import type { Activation, Category, Credential, Execution, LiveTriggers, NodeDefinition, Position3D, WorkflowGraph, WorkflowNode, WorkflowRecord, WorkflowVersion } from '../../lib/types';
import { Button, Dialog, ErrorNotice, Lamp, Loading } from '../../components/ui';
import { canEdit, canManage, messageOf, useResource, useSignedIn } from '../../state/app-state';
import { Link } from '../../state/navigation';
import type { BoardIssue } from './board';
import { Icon } from './icons';
import { DataLinkInspector, EdgeInspector, NodeInspector, type RunContext } from './inspector';
import { Palette } from './palette';
import { RunsPanel, SelectionPanel, WorkflowPanel } from './side-panels';
import { Stage, type BoardModel } from './stage';
import { useEditor, type Doc } from './use-editor';
import { useExecution } from './use-execution';

const drafts = createDraftStore();

type Loaded = {
  workflow: WorkflowRecord;
  version: WorkflowVersion;
  palette: NodeDefinition[];
  credentials: Credential[];
  categories: Category[];
};

export const StudioPage = ({ workflowId }: { workflowId: string }) => {
  const { api } = useSignedIn();
  const [reloadKey, setReloadKey] = useState(0);
  const resource = useResource(async (): Promise<Loaded> => {
    const [{ workflow, version }, palette, credentials, categories] = await Promise.all([api.workflow(workflowId), api.nodes(), api.credentials(), api.categories()]);
    return { workflow, version, palette, credentials, categories };
  }, [workflowId, reloadKey]);

  useEffect(() => {
    if (resource.data) document.title = `${resource.data.workflow.name} | Spatial Studio`;
  }, [resource.data]);

  if (resource.error) {
    return (
      <div className="studio-message">
        <Link to="/workflows" className="back">
          Workflows
        </Link>
        <ErrorNotice error={resource.error} onRetry={resource.reload} />
      </div>
    );
  }
  if (!resource.data) return <Loading label="Opening Spatial Studio" />;
  return <StudioEditor key={`${workflowId}:${resource.data.version.version}:${reloadKey}`} loaded={resource.data} onReload={() => setReloadKey((key) => key + 1)} />;
};

const docOf = (workflow: WorkflowRecord, version: WorkflowVersion): Doc => ({ name: workflow.name, graph: version.graph, settings: version.settings });

/** Graphs saved without positions (imported, or made by the API) get a layout once. */
const withPositions = (graph: WorkflowGraph, palette: readonly NodeDefinition[]): WorkflowGraph => {
  const heightOf = (node: WorkflowNode) => layoutBoard(portsOf(node, resolveDefinition(node, palette).definition)).height / UNIT_PX;
  const laidOut = graph.nodes.some((node) => !node.position) ? autoLayout(graph, heightOf) : graph;
  return { ...laidOut, nodes: laidOut.nodes.map((node) => (node.kind === 'loop' ? { ...node, body: withPositions(node.body, palette) } : node)) };
};

type DraftOffer = { kind: 'restored'; draft: Draft } | { kind: 'stale'; draft: Draft };

const StudioEditor = ({ loaded, onReload }: { loaded: Loaded; onReload: () => void }) => {
  const session = useSignedIn();
  const { api, notify } = session;
  const readOnly = !canEdit(session.role);
  const { palette, credentials } = loaded;
  const [workflow, setWorkflow] = useState(loaded.workflow);

  const initial = useMemo(() => {
    const server = docOf(loaded.workflow, loaded.version);
    const draft = readOnly ? undefined : drafts.load(session.workspace.id, loaded.workflow.id);
    // A layout added for a graph saved without positions is not an unsaved change.
    const saved = { ...server, graph: withPositions(server.graph, palette) };
    if (draft && draft.baseVersion === loaded.version.version) {
      return { doc: { name: draft.name, graph: draft.graph, settings: draft.settings }, saved, offer: { kind: 'restored', draft } satisfies DraftOffer };
    }
    return { doc: saved, saved, offer: draft ? ({ kind: 'stale', draft } satisfies DraftOffer) : undefined };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editor = useEditor({ doc: initial.doc, baseVersion: loaded.version.version, saved: initial.saved });
  const { doc, graph, path, selection, pending, actions } = editor;
  const [offer, setOffer] = useState<DraftOffer | undefined>(initial.offer);
  const [serverIssues, setServerIssues] = useState<StudioIssue[]>([]);
  const [tab, setTab] = useState<'inspect' | 'runs'>('inspect');
  const [fitRequest, setFitRequest] = useState(0);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [activation, setActivation] = useState<Activation | undefined>(undefined);
  const [live, setLive] = useState<LiveTriggers | undefined>(undefined);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [shownId, setShownId] = useState<string | undefined>(undefined);
  const [panelOpen, setPanelOpen] = useState<'palette' | 'side' | undefined>(undefined);

  /* ---------- Loading what is live and what ran ---------- */

  const refreshRuns = useCallback(() => {
    api.executions({ workflowId: loaded.workflow.id, limit: 25 }).then(setExecutions, () => undefined);
  }, [api, loaded.workflow.id]);
  const refreshLive = useCallback(() => {
    api.liveTriggers(loaded.workflow.id).then(setLive, () => undefined);
  }, [api, loaded.workflow.id]);
  useEffect(() => {
    refreshRuns();
    refreshLive();
  }, [refreshRuns, refreshLive]);

  const execution = useExecution(api, shownId, refreshRuns);
  // The history lists a run as soon as a worker starts it, and again whenever its state changes.
  const shownStatus = execution.detail?.execution.status;
  useEffect(() => {
    if (shownStatus && shownStatus !== 'queued') refreshRuns();
  }, [shownStatus, refreshRuns]);

  /* ---------- Drafts: unsaved work survives a reload ---------- */

  useEffect(() => {
    if (readOnly) return;
    const timer = window.setTimeout(() => {
      if (editor.dirty) drafts.save(session.workspace.id, workflow.id, { baseVersion: editor.baseVersion, ...doc, savedAt: Date.now() });
      else if (!offer) drafts.clear(session.workspace.id, workflow.id);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [doc, editor.dirty, editor.baseVersion, readOnly, session.workspace.id, workflow.id, offer]);

  /* ---------- What the boards show ---------- */

  const categoryNames = useMemo(() => new Map(loaded.categories.map((category) => [category.slug, category.name])), [loaded.categories]);
  const definitionOf = useCallback((node: WorkflowNode) => resolveDefinition(node, palette).definition, [palette]);
  const portsLookup = useCallback((node: WorkflowNode) => portsOf(node, definitionOf(node)), [definitionOf]);
  const titleLookup = useCallback((node: WorkflowNode) => nodeTitle(node, definitionOf(node)), [definitionOf]);

  const localIssues = useMemo(() => checkWorkflow(doc.graph, { palette, credentials }), [doc.graph, palette, credentials]);
  const issues = useMemo(() => [...serverIssues, ...localIssues], [serverIssues, localIssues]);
  useEffect(() => setServerIssues([]), [doc.graph]);

  const boards = useMemo(
    (): BoardModel[] =>
      graph.nodes.map((node) => {
        const resolved = resolveDefinition(node, palette);
        const ports = portsOf(node, resolved.definition);
        return {
          node,
          ports,
          layout: layoutBoard(ports),
          title: nodeTitle(node, resolved.definition),
          summary: nodeSummary(node, resolved.definition),
          appTitle: resolved.definition.title,
          icon: resolved.definition.icon,
          color: resolved.definition.color,
          missing: resolved.status === 'missing',
          bodySteps: node.kind === 'loop' ? node.body.nodes.length : undefined,
        };
      }),
    [graph.nodes, palette],
  );

  const titles = useMemo(() => new Map(boards.map((board) => [board.node.id, board.title])), [boards]);
  const allTitles = useMemo(() => {
    const map = new Map<string, string>();
    const walk = (current: WorkflowGraph) => {
      for (const node of current.nodes) {
        map.set(node.id, titleLookup(node));
        if (node.kind === 'loop') walk(node.body);
      }
    };
    walk(doc.graph);
    return map;
  }, [doc.graph, titleLookup]);

  const dataLinks = useMemo(() => dataLinksOf(graph, new Map(boards.map((board) => [board.node.id, board.ports]))), [graph, boards]);

  const boardIssues = useMemo(() => {
    const map = new Map<string, BoardIssue>();
    for (const board of boards) {
      const own = issuesForNode(issues, path, board.node.id);
      const [first] = own;
      if (first) map.set(board.node.id, { severity: first.severity, message: first.message, count: own.length });
    }
    return map;
  }, [boards, issues, path]);

  const runViews = useMemo(() => runViewsFor(execution.detail, path), [execution.detail, path]);
  const edgeStates = useMemo(() => edgeStatesFor(execution.detail, path), [execution.detail, path]);

  /* ---------- Editing ---------- */

  const takenIds = useCallback(() => new Set(allNodeIds(doc.graph)), [doc.graph]);
  const heightOf = useCallback((node: WorkflowNode) => layoutBoard(portsLookup(node)).height / UNIT_PX, [portsLookup]);

  const focusBoard = (nodeId: string) => window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-board-handle="${CSS.escape(nodeId)}"]`)?.focus({ preventScroll: true }));

  const addDefinition = (definition: NodeDefinition, at?: Position3D) => {
    if (readOnly) return;
    // Ids read like the app (`claude`, `telegram-2`), so references stay readable: {{nodes.claude.output.text}}.
    const id = suggestNodeId(definition.title, takenIds());
    const selectedId = selection.kind === 'nodes' && selection.ids.length === 1 ? selection.ids[0] : undefined;
    const anchor = selectedId ? findNode(graph, selectedId) : undefined;
    const draftNode = createNode(definition, id, { x: 0, y: 0, z: 0 });
    const newHeight = heightOf(draftNode);
    const rightmost = graph.nodes.reduce<WorkflowNode | undefined>((best, node) => (!best || positionOf(node).x > positionOf(best).x ? node : best), undefined);
    const preferred = at ?? (anchor ? { x: positionOf(anchor).x + GEOMETRY.width + 1.2, y: 0, z: positionOf(anchor).z } : rightmost ? { x: positionOf(rightmost).x + GEOMETRY.width + 1.2, y: 0, z: positionOf(rightmost).z } : { x: 0, y: 0, z: 0 });
    // Dropped or clicked, a new board never lands on top of another one.
    const node = { ...draftNode, position: freeSpot(graph, heightOf, preferred, newHeight) };
    actions.change(
      (current) => {
        const added = addNode(current, node);
        if (!at && anchor && node.kind !== 'trigger') {
          const connected = connect(added, anchor.id, primaryPortOf(anchor), node.id);
          return connected.ok ? connected.graph : added;
        }
        return added;
      },
      { select: { kind: 'nodes', ids: [node.id] } },
    );
    if (!at) focusBoard(node.id);
  };

  const onAddAt = (type: string, position: Position3D) => {
    const definition = palette.find((candidate) => candidate.type === type);
    if (definition) addDefinition(definition, position);
  };

  const deleteSelection = () => {
    if (readOnly) return;
    if (selection.kind === 'nodes') {
      const ids = new Set(selection.ids);
      actions.change((current) => removeNodes(current, ids), { select: { kind: 'none' } });
      notify(ids.size === 1 ? 'Step removed. Undo with Ctrl+Z.' : `${ids.size} steps removed. Undo with Ctrl+Z.`);
    } else if (selection.kind === 'edge') {
      actions.change((current) => removeEdge(current, selection.id), { select: { kind: 'none' } });
    } else if (selection.kind === 'data') {
      const { link } = selection;
      actions.change((current) => unlinkInput(current, link.toNodeId, link.toPort, link.reference), { select: { kind: 'none' } });
    }
  };

  const onConnect = (from: string, port: string, to: string) => {
    const result = connect(graph, from, port, to);
    if (!result.ok) return notify(result.reason, 'error');
    actions.change(() => result.graph, { select: { kind: 'edge', id: result.edge.id } });
  };

  const onLinkData = (fromNodeId: string, fromPort: string, toNodeId: string, toPort: string) => {
    const source = findNode(graph, fromNodeId);
    if (!source) return;
    const port = portsLookup(source).dataOut.find((candidate) => candidate.key === fromPort);
    const reference = source.kind === 'trigger' ? (source.trigger === 'plugin' ? `trigger.${fromPort}` : 'trigger') : `nodes.${fromNodeId}.output.${fromPort}`;
    actions.change((current) => linkInput(current, toNodeId, toPort, reference), { select: { kind: 'nodes', ids: [toNodeId] } });
    notify(`${titles.get(toNodeId) ?? toNodeId} now reads ${port?.label ?? fromPort} from ${titles.get(fromNodeId) ?? fromNodeId}.`);
  };

  const openPath = (next: GraphPath) => {
    actions.openPath(next);
    setFitRequest((value) => value + 1);
  };

  const showIssue = (issue: StudioIssue) => {
    if (!issue.nodeId) return;
    const where = locate(doc.graph, issue.nodeId) ?? issue.path;
    if (where.join('/') !== path.join('/')) actions.openPath(where);
    actions.select({ kind: 'nodes', ids: [issue.nodeId] });
    setTab('inspect');
    focusBoard(issue.nodeId);
  };

  const tidy = () => {
    actions.change((current) => autoLayout(current, heightOf));
    setFitRequest((value) => value + 1);
  };

  /* ---------- Saving, running, going live ---------- */

  const save = async (options: { force?: boolean } = {}): Promise<number | undefined> => {
    if (readOnly) return undefined;
    if (!editor.dirty && !options.force) return editor.baseVersion;
    if (hasErrors(localIssues)) {
      notify('Fix the problems marked in red before saving.', 'error');
      actions.select({ kind: 'none' });
      setTab('inspect');
      return undefined;
    }
    setSaving(true);
    try {
      let expectedVersion = editor.baseVersion;
      if (options.force) expectedVersion = (await api.workflow(workflow.id)).workflow.currentVersion;
      const record = await api.saveWorkflow(workflow.id, { name: doc.name.trim() || 'Untitled workflow', graph: doc.graph, settings: doc.settings, expectedVersion });
      actions.markSaved(doc, record.currentVersion);
      setWorkflow(record);
      setOffer(undefined);
      drafts.clear(session.workspace.id, workflow.id);
      notify(`Saved as version ${record.currentVersion}.`);
      return record.currentVersion;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      else {
        if (error instanceof ApiError && error.issues.length > 0) setServerIssues(issuesFromServer(doc.graph, error.issues));
        notify(messageOf(error), 'error');
      }
      return undefined;
    } finally {
      setSaving(false);
    }
  };

  const run = async (payload: unknown, triggerNodeId: string | undefined) => {
    const version = await save();
    if (version === undefined) return false;
    try {
      const started = await api.run(workflow.id, { version, payload, ...(triggerNodeId ? { triggerNodeId } : {}) });
      setShownId(started.executionId);
      setTab('runs');
      setPanelOpen('side');
      refreshRuns();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.issues.length > 0) setServerIssues(issuesFromServer(doc.graph, error.issues));
      notify(messageOf(error), 'error');
      return false;
    }
  };

  const goLive = async () => {
    const version = await save();
    if (version === undefined) return;
    try {
      const result = await api.activate(workflow.id, version);
      setWorkflow(result.workflow);
      setActivation(result);
      setLive({ active: true, version, webhooks: result.webhooks, schedules: result.schedules });
    } catch (error) {
      if (error instanceof ApiError && error.issues.length > 0) setServerIssues(issuesFromServer(doc.graph, error.issues));
      notify(messageOf(error), 'error');
    }
  };

  const stopLive = async () => {
    try {
      setWorkflow(await api.deactivate(workflow.id));
      setLive({ active: false, version: undefined, webhooks: [], schedules: [] });
      notify('The workflow is no longer live. Webhooks and schedules are closed.');
    } catch (error) {
      notify(messageOf(error), 'error');
    }
  };

  const decide = async (nodeId: string, approved: boolean, comment: string) => {
    if (!shownId) return;
    try {
      await api.decide(shownId, nodeId, { approved, ...(comment.trim() ? { comment: comment.trim() } : {}) });
      notify(approved ? 'Approved. The workflow carries on.' : 'Rejected. The Rejected jack fires.');
      window.setTimeout(execution.refresh, 400);
    } catch (error) {
      notify(messageOf(error), 'error');
    }
  };

  const cancelRun = async (executionId: string) => {
    try {
      await api.cancelExecution(executionId);
      execution.refresh();
      refreshRuns();
    } catch (error) {
      notify(messageOf(error), 'error');
    }
  };

  const review = (nodeId: string) => {
    const where = locate(doc.graph, nodeId) ?? [];
    if (where.length > 0 || path.length > 0) actions.openPath(where);
    actions.select({ kind: 'nodes', ids: [nodeId] });
    setTab('inspect');
    setPanelOpen('side');
  };

  // Undo, redo and save from the keyboard. Text fields keep their own undo.
  const shortcuts = useRef({ undo: actions.undo, redo: actions.redo, save });
  shortcuts.current = { undo: actions.undo, redo: actions.redo, save };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        void shortcuts.current.save();
        return;
      }
      const inText = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (inText) return;
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        shortcuts.current.undo();
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        shortcuts.current.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---------- The right-hand column ---------- */

  const selectedNode = selection.kind === 'nodes' && selection.ids.length === 1 && selection.ids[0] ? findNode(graph, selection.ids[0]) : undefined;
  const detail = execution.detail;
  const runContext = (node: WorkflowNode): RunContext | undefined => {
    if (!detail || !shownId) return undefined;
    const run = path.length === 0 && isExecution(detail.execution) ? detail.execution.nodes[node.id] : undefined;
    return { executionId: shownId, run, steps: stepsOf(detail.steps, path, node.id), canDecide: !readOnly, onDecide: (approved, comment) => decide(node.id, approved, comment) };
  };

  const inspector = (() => {
    if (selectedNode) {
      const resolved = resolveDefinition(selectedNode, palette);
      return (
        <NodeInspector
          node={selectedNode}
          resolved={resolved}
          title={nodeTitle(selectedNode, resolved.definition)}
          icon={resolved.definition.icon}
          color={resolved.definition.color}
          issues={issuesForNode(issues, path, selectedNode.id)}
          credentials={credentials}
          sources={dataSourcesFor(doc.graph, path, selectedNode.id, portsLookup, titleLookup)}
          graph={graph}
          titles={titles}
          readOnly={readOnly}
          webhook={live?.webhooks.find((hook) => hook.triggerNodeId === selectedNode.id)}
          schedule={live?.schedules.find((entry) => entry.triggerNodeId === selectedNode.id)}
          canSeeSecrets={canManage(session.role)}
          run={runContext(selectedNode)}
          onRevealSecret={async () => {
            try {
              return (await api.webhookSecrets(workflow.id)).find((hook) => hook.triggerNodeId === selectedNode.id)?.secret;
            } catch (error) {
              notify(messageOf(error), 'error');
              return undefined;
            }
          }}
          onChange={(node, group) => actions.change((current) => replaceNode(current, node), { group })}
          onConnect={(port, to) => onConnect(selectedNode.id, port, to)}
          onRemoveEdge={(edgeId) => actions.change((current) => removeEdge(current, edgeId))}
          onDelete={deleteSelection}
          onOpenLoop={() => openPath([...path, selectedNode.id])}
          onRepin={() => actions.change((current) => replaceNode(current, repinNode(selectedNode, resolved.definition)))}
        />
      );
    }
    if (selection.kind === 'nodes' && selection.ids.length > 1) return <SelectionPanel count={selection.ids.length} readOnly={readOnly} onDelete={deleteSelection} />;
    if (selection.kind === 'edge') {
      const edge = graph.edges.find((candidate) => candidate.id === selection.id);
      if (edge) {
        return (
          <EdgeInspector
            from={titles.get(edge.from) ?? edge.from}
            to={titles.get(edge.to) ?? edge.to}
            port={edge.port ?? 'out'}
            readOnly={readOnly}
            onRemove={deleteSelection}
          />
        );
      }
    }
    if (selection.kind === 'data') {
      const { link } = selection;
      return <DataLinkInspector link={link} from={titles.get(link.fromNodeId) ?? link.fromNodeId} to={titles.get(link.toNodeId) ?? link.toNodeId} readOnly={readOnly} onRemove={deleteSelection} />;
    }
    return (
      <WorkflowPanel
        workflow={workflow}
        graph={doc.graph}
        settings={doc.settings}
        issues={issues}
        titles={allTitles}
        live={live}
        readOnly={readOnly}
        onShowIssue={showIssue}
        onSettings={(settings) => actions.updateDoc((current) => ({ ...current, settings }), 'settings')}
      />
    );
  })();

  /* ---------- Breadcrumb for loop bodies ---------- */

  const breadcrumb = (
    <nav className="stage-crumbs" aria-label="Where you are">
      <button type="button" onClick={() => openPath([])} aria-current={path.length === 0 ? 'location' : undefined}>
        Workflow
      </button>
      {path.map((loopId, index) => (
        <span key={loopId}>
          <span aria-hidden="true">/</span>
          <button type="button" onClick={() => openPath(path.slice(0, index + 1))} aria-current={index === path.length - 1 ? 'location' : undefined}>
            {allTitles.get(loopId) ?? loopId}
          </button>
        </span>
      ))}
      {path.length > 0 ? <span className="hint">Steps here run once per item.</span> : null}
    </nav>
  );

  const shownExecution = detail?.execution;
  const liveVersion = workflow.active ? workflow.activeVersion : undefined;
  const saveLabel = saving ? 'Saving…' : editor.dirty ? 'Save version' : `Saved, version ${editor.baseVersion}`;
  const triggers = doc.graph.nodes.filter((node) => node.kind === 'trigger');

  return (
    <div className="studio" data-panel={panelOpen}>
      <header className="studio-bar">
        <Link to="/workflows" className="studio-back" aria-label="All workflows">
          <Icon name="back" />
        </Link>
        <label className="studio-name">
          <span className="visually-hidden">Workflow name</span>
          <input type="text" value={doc.name} readOnly={readOnly} onChange={(event) => actions.updateDoc((current) => ({ ...current, name: event.target.value }), 'name')} />
        </label>
        <span className="studio-state" role="status">
          {editor.dirty ? <Lamp lamp={{ tone: 'attention', label: 'Unsaved changes' }} /> : null}
          {liveVersion !== undefined ? <Lamp lamp={{ tone: 'ready', label: `Live, version ${liveVersion}` }} /> : <Lamp lamp={{ tone: 'off', label: 'Not live' }} />}
        </span>
        <div className="studio-tools" role="toolbar" aria-label="Workflow">
          <button type="button" className="icon-button" onClick={actions.undo} disabled={!editor.canUndo || readOnly} title="Undo (Ctrl+Z)" aria-label="Undo">
            <Icon name="undo" />
          </button>
          <button type="button" className="icon-button" onClick={actions.redo} disabled={!editor.canRedo || readOnly} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
            <Icon name="redo" />
          </button>
          <button type="button" className="icon-button" onClick={tidy} disabled={readOnly || graph.nodes.length < 2} title="Tidy up the layout" aria-label="Tidy up the layout">
            <Icon name="tidy" />
          </button>
          {readOnly ? null : (
            <>
              <Button variant={editor.dirty ? 'primary' : 'secondary'} onClick={() => void save()} disabled={saving || !editor.dirty}>
                {saveLabel}
              </Button>
              <Button onClick={() => setRunOpen(true)} disabled={saving || triggers.length === 0}>
                <Icon name="play" size={14} />
                Run
              </Button>
              {liveVersion === undefined || liveVersion !== editor.baseVersion || editor.dirty ? (
                <Button onClick={() => void goLive()} disabled={saving}>
                  {liveVersion === undefined ? 'Go live' : 'Go live with this version'}
                </Button>
              ) : null}
              {liveVersion !== undefined ? (
                <Button variant="quiet" onClick={() => void stopLive()}>
                  Stop
                </Button>
              ) : null}
            </>
          )}
        </div>
      </header>

      {offer ? (
        <div className="notice studio-notice" role="status">
          {offer.kind === 'restored' ? (
            <p>Your unsaved changes from {new Date(offer.draft.savedAt).toLocaleString()} are back.</p>
          ) : (
            <p>
              You have unsaved changes made on version {offer.draft.baseVersion}, but version {loaded.version.version} was saved since.
            </p>
          )}
          <div className="actions">
            {offer.kind === 'stale' ? (
              <Button
                size="small"
                onClick={() => {
                  actions.load({ name: offer.draft.name, graph: offer.draft.graph, settings: offer.draft.settings }, offer.draft.baseVersion, initial.saved);
                  setOffer(undefined);
                  setFitRequest((value) => value + 1);
                }}
              >
                Open my changes
              </Button>
            ) : null}
            <Button
              size="small"
              variant="quiet"
              onClick={() => {
                drafts.clear(session.workspace.id, workflow.id);
                if (offer.kind === 'restored') actions.load(initial.saved, loaded.version.version, initial.saved);
                setOffer(undefined);
              }}
            >
              Discard them
            </Button>
            {offer.kind === 'restored' ? (
              <Button size="small" variant="quiet" onClick={() => setOffer(undefined)}>
                Keep editing
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="studio-body">
        <div className="studio-palette">
          <Palette
            definitions={palette}
            categoryNames={categoryNames}
            inLoop={path.length > 0}
            attachTo={selectedNode ? titles.get(selectedNode.id) : undefined}
            readOnly={readOnly}
            onAdd={(definition) => {
              addDefinition(definition);
              setPanelOpen(undefined);
            }}
          />
        </div>
        <div className="studio-stage">
          <Stage
            pathKey={path.join('/')}
            boards={boards}
            edges={graph.edges}
            dataLinks={dataLinks}
            runViews={runViews}
            edgeStates={edgeStates}
            issues={boardIssues}
            selection={selection}
            pending={pending}
            readOnly={readOnly}
            fitRequest={fitRequest}
            overlay={
              <>
                {breadcrumb}
                {shownExecution && shownId ? (
                  <div className="stage-run-tag">
                    <Lamp lamp={executionLamp(shownExecution)} />
                    <span>{isExecution(shownExecution) && shownExecution.workflowVersion !== editor.baseVersion ? `Run of version ${shownExecution.workflowVersion}` : 'Run shown on the boards'}</span>
                    <button type="button" className="btn btn-small btn-quiet" onClick={() => setShownId(undefined)}>
                      Hide
                    </button>
                  </div>
                ) : null}
              </>
            }
            emptyHint={
              path.length > 0 ? (
                <>
                  <h2>The loop is empty</h2>
                  <p>Add the steps that should run for each item. They can read it as {'{{item}}'}.</p>
                </>
              ) : (
                <>
                  <h2>Start with a trigger</h2>
                  <p>Pick Manual Trigger, a webhook or a schedule from Modules, then add the apps it should run.</p>
                </>
              )
            }
            onSelect={actions.select}
            onMove={(positions, group) => actions.change((current) => moveNodes(current, positions), { group })}
            onMoveEnd={actions.seal}
            onConnect={onConnect}
            onLinkData={onLinkData}
            onAddAt={onAddAt}
            onDelete={deleteSelection}
            onPending={actions.setPending}
            onOpenLoop={(nodeId) => openPath([...path, nodeId])}
            onReview={review}
            onNotice={(message) => notify(message, 'error')}
          />
          <div className="studio-mobile-tabs" role="group" aria-label="Panels">
            <Button size="small" onClick={() => setPanelOpen(panelOpen === 'palette' ? undefined : 'palette')} aria-pressed={panelOpen === 'palette'}>
              {panelOpen === 'palette' ? 'Close modules' : 'Modules'}
            </Button>
            <Button size="small" onClick={() => setPanelOpen(panelOpen === 'side' ? undefined : 'side')} aria-pressed={panelOpen === 'side'}>
              {panelOpen === 'side' ? 'Close details' : 'Details'}
            </Button>
          </div>
        </div>
        <aside className="studio-side" aria-label="Details">
          <div className="tabs" role="tablist" aria-label="Panel">
            <button type="button" role="tab" aria-selected={tab === 'inspect'} onClick={() => setTab('inspect')}>
              {selectedNode ? 'Step' : selection.kind === 'none' ? 'Workflow' : 'Selection'}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'runs'} onClick={() => setTab('runs')}>
              Runs{executions.length > 0 ? ` (${executions.length})` : ''}
            </button>
          </div>
          <div role="tabpanel" className="studio-side-scroll">
            {tab === 'inspect' ? (
              inspector
            ) : (
              <RunsPanel
                executions={executions}
                shown={detail}
                shownId={shownId}
                titles={allTitles}
                canRun={!readOnly && triggers.length > 0}
                onRun={() => setRunOpen(true)}
                onShow={setShownId}
                onCancel={(executionId) => void cancelRun(executionId)}
                onReview={review}
              />
            )}
          </div>
        </aside>
      </div>

      <RunDialog
        open={runOpen}
        graph={doc.graph}
        titles={allTitles}
        dirty={editor.dirty}
        onClose={() => setRunOpen(false)}
        onRun={async (payload, triggerNodeId) => {
          if (await run(payload, triggerNodeId)) setRunOpen(false);
        }}
      />

      <Dialog
        open={activation !== undefined}
        title={`Live on version ${activation?.workflow.activeVersion ?? ''}`}
        onClose={() => setActivation(undefined)}
        actions={
          <Button variant="primary" onClick={() => setActivation(undefined)}>
            Done
          </Button>
        }
      >
        <p>New requests and schedules now use this version. Runs already going keep the version they started with.</p>
        {activation?.webhooks.map((hook) => (
          <div key={hook.webhookId} className="live-trigger">
            <strong>{allTitles.get(hook.triggerNodeId) ?? hook.triggerNodeId}</strong>
            <code className="copyable">{hook.url}</code>
          </div>
        ))}
        {activation?.schedules.map((schedule) => (
          <div key={schedule.triggerNodeId} className="live-trigger">
            <strong>{allTitles.get(schedule.triggerNodeId) ?? schedule.triggerNodeId}</strong>
            <span>Next run {new Date(schedule.nextRunAt).toLocaleString()} ({schedule.timezone})</span>
          </div>
        ))}
        {activation && activation.webhooks.length > 0 ? <p className="hint">Admins find the signing secret on the webhook trigger.</p> : null}
      </Dialog>

      <Dialog
        open={conflict}
        title="Someone saved a newer version"
        onClose={() => setConflict(false)}
        actions={
          <>
            <Button
              variant="primary"
              onClick={() => {
                setConflict(false);
                void save({ force: true });
              }}
            >
              Save mine as the newest version
            </Button>
            <Button
              onClick={() => {
                setConflict(false);
                drafts.clear(session.workspace.id, workflow.id);
                onReload();
              }}
            >
              Open their version
            </Button>
          </>
        }
      >
        <p>While you were editing, another version of this workflow was saved. Nothing has been overwritten. Choose which one continues.</p>
      </Dialog>
    </div>
  );
};

type RunDialogProps = {
  open: boolean;
  graph: WorkflowGraph;
  titles: ReadonlyMap<string, string>;
  dirty: boolean;
  onClose: () => void;
  onRun: (payload: unknown, triggerNodeId: string | undefined) => Promise<void>;
};

/** Mounted only while open, so every opening starts from a fresh example payload. */
const RunDialog = (props: RunDialogProps) => (props.open ? <RunDialogBody {...props} /> : null);

const RunDialogBody = ({ graph, titles, dirty, onClose, onRun }: RunDialogProps) => {
  const triggers = graph.nodes.filter((node) => node.kind === 'trigger');
  const [triggerId, setTriggerId] = useState<string | undefined>(() => triggers[0]?.id);
  const [text, setText] = useState(() => JSON.stringify(samplePayload(graph), null, 2));
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    let payload: unknown;
    try {
      payload = text.trim() ? JSON.parse(text) : {};
    } catch {
      setError('The payload is not valid JSON.');
      return;
    }
    setBusy(true);
    try {
      await onRun(payload, triggerId);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="Run the workflow"
      onClose={onClose}
      actions={
        <>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {dirty ? 'Save and run' : 'Run'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <p>It runs on the server, one step after another, and the boards light up as steps finish.</p>
      {dirty ? <p className="hint">Your changes are saved as a new version first; runs always use a saved version.</p> : null}
      {triggers.length > 1 ? (
        <div className="field">
          <label>
            <span className="label">Start from</span>
            <select value={triggerId ?? ''} onChange={(event) => setTriggerId(event.target.value)}>
              {triggers.map((trigger) => (
                <option key={trigger.id} value={trigger.id}>
                  {titles.get(trigger.id) ?? trigger.id}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      <div className="field">
        <label>
          <span className="label">Payload</span>
          <textarea className="code" rows={7} value={text} onChange={(event) => setText(event.target.value)} aria-invalid={Boolean(error)} />
        </label>
        {error ? <small className="error">{error}</small> : <small>Steps read it as {'{{trigger…}}'}, just like a real webhook body.</small>}
      </div>
    </Dialog>
  );
};
