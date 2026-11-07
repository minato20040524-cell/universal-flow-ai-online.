import type { DataPort, NodeDefinition, NodeKind, Position3D, WorkflowEdge, WorkflowGraph, WorkflowNode } from '../types.js';

/**
 * Graph editing for Spatial Studio. Every function is pure and returns a new
 * graph, so the editor gets undo/redo by keeping old values.
 */

/** Must equal the engine's FLOW_OUTPUT_PORTS; the tests compare them. */
export const FLOW_OUTPUT_PORTS = {
  trigger: ['out'],
  action: ['out', 'error'],
  condition: ['true', 'false'],
  loop: ['out', 'error'],
  delay: ['out'],
  approval: ['approved', 'rejected'],
  transform: ['out', 'error'],
} as const satisfies Record<NodeKind, readonly string[]>;

export const DEFAULT_PORT = 'out';
export const NODE_ID_PATTERN = /^[A-Za-z][\w-]{0,63}$/;

/** Loop node ids from the workflow down to the body being edited; empty for the workflow itself. */
export type GraphPath = readonly string[];

export const emptyGraph = (): WorkflowGraph => ({ nodes: [], edges: [] });

export const flowOutputsOf = (node: WorkflowNode): readonly string[] => FLOW_OUTPUT_PORTS[node.kind];
export const flowInputsOf = (node: WorkflowNode): readonly string[] => (node.kind === 'trigger' ? [] : ['in']);

export const graphAt = (root: WorkflowGraph, path: GraphPath): WorkflowGraph | undefined => {
  let graph: WorkflowGraph | undefined = root;
  for (const loopId of path) {
    const loop: WorkflowNode | undefined = graph?.nodes.find((node) => node.id === loopId);
    graph = loop?.kind === 'loop' ? loop.body : undefined;
  }
  return graph;
};

/** Applies `update` to the graph at `path` and rebuilds the loops above it. */
export const updateGraphAt = (root: WorkflowGraph, path: GraphPath, update: (graph: WorkflowGraph) => WorkflowGraph): WorkflowGraph => {
  const [loopId, ...rest] = path;
  if (loopId === undefined) return update(root);
  return {
    ...root,
    nodes: root.nodes.map((node) => (node.id === loopId && node.kind === 'loop' ? { ...node, body: updateGraphAt(node.body, rest, update) } : node)),
  };
};

/** Ids in the whole workflow, loop bodies included: a body can read outer steps, so ids must not repeat anywhere. */
export const allNodeIds = (graph: WorkflowGraph): string[] =>
  graph.nodes.flatMap((node) => (node.kind === 'loop' ? [node.id, ...allNodeIds(node.body)] : [node.id]));

export const findNode = (graph: WorkflowGraph, id: string): WorkflowNode | undefined => graph.nodes.find((node) => node.id === id);

const slug = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** A readable, unique id such as `claude` or `claude-2`; ids appear in data references, so they stay short. */
export const suggestNodeId = (label: string, taken: ReadonlySet<string>): string => {
  const cleaned = slug(label);
  const base = /^[a-z]/.test(cleaned) ? cleaned : `step-${cleaned}`.replace(/-+$/, '');
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/* ---------- Definitions: which palette module draws a node ---------- */

export const pluginRefOf = (node: WorkflowNode): string | undefined => (node.kind === 'action' ? node.plugin : node.kind === 'trigger' ? node.plugin : undefined);

export const parsePluginRef = (ref: string): { pluginId: string; version: string } | undefined => {
  const at = ref.lastIndexOf('@');
  if (at <= 0 || at === ref.length - 1) return undefined;
  return { pluginId: ref.slice(0, at), version: ref.slice(at + 1) };
};

/** The palette type a node was made from, e.g. `io.universalflow.claude@1.0.0:chat` or `builtin:delay`. */
export const definitionTypeOf = (node: WorkflowNode): string => {
  if (node.kind === 'action') return `${node.plugin}:${node.action}`;
  if (node.kind === 'trigger' && node.trigger === 'plugin') return `${node.plugin ?? ''}:${node.key ?? ''}`;
  return `builtin:${node.kind}`;
};

export type ResolvedDefinition =
  | { status: 'ok'; definition: NodeDefinition }
  /** The workflow pins a version other than the installed one; the installed module is drawn. */
  | { status: 'other-version'; definition: NodeDefinition; pinned: string; installed: string }
  /** The module is not installed (or disabled) in this workspace. */
  | { status: 'missing'; definition: NodeDefinition; pluginId: string };

const placeholderDefinition = (node: WorkflowNode, pluginId: string): NodeDefinition => {
  const inputs = node.kind === 'action' ? Object.keys(node.input) : [];
  const key = node.kind === 'action' ? node.action : node.kind === 'trigger' ? (node.key ?? '') : '';
  return {
    type: definitionTypeOf(node),
    source: { kind: 'plugin', pluginId, version: parsePluginRef(pluginRefOf(node) ?? '')?.version ?? '', key, role: node.kind === 'trigger' ? 'trigger' : 'action' },
    title: pluginId,
    subtitle: key,
    description: undefined,
    icon: 'plug',
    color: '#8A939D',
    category: 'custom-api',
    dataInputs: inputs.map((input) => ({ key: input, label: input, type: 'any', required: false, description: undefined })),
    dataOutputs: [],
    flowInputs: [...flowInputsOf(node)],
    flowOutputs: [...flowOutputsOf(node)],
    configFields: inputs.map((input) => ({ key: input, label: input, widget: 'text', required: false, options: undefined, defaultValue: undefined, description: undefined })),
    auth: { type: 'none', required: false },
    limitations: [],
    geometry: { width: 2.4, height: 1.4, depth: 0.4, dataInputs: [], dataOutputs: [], flowInputs: [], flowOutputs: [] },
  };
};

export const resolveDefinition = (node: WorkflowNode, palette: readonly NodeDefinition[]): ResolvedDefinition => {
  const type = definitionTypeOf(node);
  const exact = palette.find((definition) => definition.type === type);
  if (exact) return { status: 'ok', definition: exact };
  const ref = parsePluginRef(pluginRefOf(node) ?? '');
  const builtin = palette.find((definition) => definition.type === `builtin:${node.kind}`);
  if (!ref) return { status: 'ok', definition: builtin ?? placeholderDefinition(node, node.kind) };
  const key = node.kind === 'action' ? node.action : node.kind === 'trigger' ? node.key : undefined;
  const sibling = palette.find((definition) => definition.source.kind === 'plugin' && definition.source.pluginId === ref.pluginId && definition.source.key === key);
  if (sibling?.source.kind === 'plugin') return { status: 'other-version', definition: sibling, pinned: ref.version, installed: sibling.source.version };
  return { status: 'missing', definition: placeholderDefinition(node, ref.pluginId), pluginId: ref.pluginId };
};

/** Moves a node to the installed version of its module; inputs are kept. */
export const repinNode = (node: WorkflowNode, definition: NodeDefinition): WorkflowNode => {
  if (definition.source.kind !== 'plugin') return node;
  const ref = `${definition.source.pluginId}@${definition.source.version}`;
  if (node.kind === 'action') return { ...node, plugin: ref };
  if (node.kind === 'trigger') return { ...node, plugin: ref };
  return node;
};

/* ---------- Ports as Studio draws them ---------- */

export type NodePorts = { flowIn: readonly string[]; flowOut: readonly string[]; dataIn: readonly DataPort[]; dataOut: readonly DataPort[] };

/** Jacks for one node: the module's ports, plus the fields a transform defines. */
export const portsOf = (node: WorkflowNode, definition: NodeDefinition): NodePorts => {
  const dataOut: DataPort[] =
    node.kind === 'transform'
      ? Object.keys(node.output).map((key) => ({ key, label: key, type: 'any', required: false, description: undefined }))
      : definition.dataOutputs;
  const known = new Set(definition.dataInputs.map((port) => port.key));
  const extraInputs: DataPort[] =
    node.kind === 'action' ? Object.keys(node.input).filter((key) => !known.has(key)).map((key) => ({ key, label: key, type: 'any', required: false, description: undefined })) : [];
  return {
    flowIn: flowInputsOf(node),
    flowOut: flowOutputsOf(node),
    dataIn: node.kind === 'action' ? [...definition.dataInputs, ...extraInputs] : [],
    dataOut,
  };
};

/* ---------- Creating nodes ---------- */

const defaultsFrom = (definition: NodeDefinition): Record<string, unknown> =>
  Object.fromEntries(definition.configFields.flatMap((field) => (field.defaultValue === undefined ? [] : [[field.key, field.defaultValue]])));

/** A new workflow node for a palette module, with the engine's defaults. */
export const createNode = (definition: NodeDefinition, id: string, position: Position3D): WorkflowNode => {
  const base = { id, position };
  const { source } = definition;
  if (source.kind === 'plugin') {
    const plugin = `${source.pluginId}@${source.version}`;
    return source.role === 'trigger'
      ? { ...base, kind: 'trigger', trigger: 'plugin', plugin, key: source.key }
      : { ...base, kind: 'action', plugin, action: source.key, input: defaultsFrom(definition) };
  }
  switch (source.nodeKind) {
    case 'trigger':
      return { ...base, kind: 'trigger', trigger: 'manual' };
    case 'condition':
      return { ...base, kind: 'condition', when: { op: 'exists', left: '' } };
    case 'loop':
      return { ...base, kind: 'loop', items: '', body: emptyGraph() };
    case 'delay':
      return { ...base, kind: 'delay', ms: 60_000 };
    case 'approval':
      return { ...base, kind: 'approval', message: 'Check this before it continues.' };
    case 'transform':
      return { ...base, kind: 'transform', output: {} };
    case 'action':
      return { ...base, kind: 'action', plugin: '', action: '', input: {} };
  }
};

export const addNode = (graph: WorkflowGraph, node: WorkflowNode): WorkflowGraph => ({ ...graph, nodes: [...graph.nodes, node] });

export const replaceNode = (graph: WorkflowGraph, node: WorkflowNode): WorkflowGraph => ({
  ...graph,
  nodes: graph.nodes.map((existing) => (existing.id === node.id ? node : existing)),
});

export const moveNodes = (graph: WorkflowGraph, positions: ReadonlyMap<string, Position3D>): WorkflowGraph => ({
  ...graph,
  nodes: graph.nodes.map((node) => {
    const position = positions.get(node.id);
    return position ? { ...node, position } : node;
  }),
});

export const removeNodes = (graph: WorkflowGraph, ids: ReadonlySet<string>): WorkflowGraph => ({
  nodes: graph.nodes.filter((node) => !ids.has(node.id)),
  edges: graph.edges.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to)),
});

/* ---------- Connections ---------- */

const outgoing = (graph: WorkflowGraph): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const edge of graph.edges) map.set(edge.from, [...(map.get(edge.from) ?? []), edge.to]);
  return map;
};

/** Whether `to` can reach `from`, so a new edge from → to would close a loop. */
export const wouldCreateCycle = (graph: WorkflowGraph, from: string, to: string): boolean => {
  if (from === to) return true;
  const next = outgoing(graph);
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    if (current === from) return true;
    seen.add(current);
    stack.push(...(next.get(current) ?? []));
  }
  return false;
};

export const edgeIdFor = (graph: WorkflowGraph, from: string, port: string, to: string): string => {
  const taken = new Set(graph.edges.map((edge) => edge.id));
  const base = `${from}-${port}-${to}`.slice(0, 120);
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) if (!taken.has(`${base}-${index}`)) return `${base}-${index}`;
};

export type ConnectResult = { ok: true; graph: WorkflowGraph; edge: WorkflowEdge } | { ok: false; reason: string };

/** Adds a control-flow cable, refusing anything the engine would reject. */
export const connect = (graph: WorkflowGraph, from: string, port: string, to: string): ConnectResult => {
  const source = findNode(graph, from);
  const target = findNode(graph, to);
  if (!source || !target) return { ok: false, reason: 'That step is no longer in this workflow.' };
  if (from === to) return { ok: false, reason: 'A step cannot connect to itself.' };
  if (!flowOutputsOf(source).includes(port)) return { ok: false, reason: `This step has no ${port} output.` };
  if (target.kind === 'trigger') return { ok: false, reason: 'Triggers start a workflow, so nothing can connect into them.' };
  if (graph.edges.some((edge) => edge.from === from && (edge.port ?? DEFAULT_PORT) === port && edge.to === to)) {
    return { ok: false, reason: 'These two jacks are already connected.' };
  }
  if (wouldCreateCycle(graph, from, to)) return { ok: false, reason: 'That would make the workflow go round in a circle. Use a Loop step to repeat work.' };
  const edge: WorkflowEdge = { id: edgeIdFor(graph, from, port, to), from, to, ...(port === DEFAULT_PORT ? {} : { port }) };
  return { ok: true, graph: { ...graph, edges: [...graph.edges, edge] }, edge };
};

export const removeEdge = (graph: WorkflowGraph, edgeId: string): WorkflowGraph => ({ ...graph, edges: graph.edges.filter((edge) => edge.id !== edgeId) });

/** First output that means "carry on", used when a new step is attached to the selected one. */
export const primaryPortOf = (node: WorkflowNode): string => flowOutputsOf(node)[0] ?? DEFAULT_PORT;

/** Steps that always finish before `nodeId` starts (its ancestors), nearest first. */
export const upstreamOf = (graph: WorkflowGraph, nodeId: string): WorkflowNode[] => {
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  const order: string[] = [];
  const seen = new Set<string>([nodeId]);
  const queue = [...(incoming.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    order.push(current);
    queue.push(...(incoming.get(current) ?? []));
  }
  return order.flatMap((id) => {
    const node = findNode(graph, id);
    return node ? [node] : [];
  });
};

/** Kahn's algorithm; `undefined` when the graph has a cycle. */
export const topologicalOrder = (graph: WorkflowGraph): string[] | undefined => {
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) if (indegree.has(edge.to)) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  const next = outgoing(graph);
  const queue = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    order.push(id);
    for (const target of next.get(id) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }
  return order.length === graph.nodes.length ? order : undefined;
};
