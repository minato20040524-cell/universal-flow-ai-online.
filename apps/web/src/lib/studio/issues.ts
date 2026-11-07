import type { Credential, Issue, NodeDefinition, WorkflowGraph, WorkflowNode } from '../types.js';
import { parseReference, referencesIn } from './data.js';
import { DEFAULT_PORT, NODE_ID_PATTERN, findNode, flowOutputsOf, graphAt, parsePluginRef, resolveDefinition, topologicalOrder, upstreamOf, type GraphPath } from './graph.js';

/**
 * Problems shown on the stage and in the inspector. Errors repeat the engine's
 * save-time rules, so the person sees them before saving; warnings are things
 * that would only fail when the workflow runs.
 */

export type StudioIssue = {
  severity: 'error' | 'warning';
  message: string;
  /** The graph the problem is in (loop ids from the workflow down). */
  path: GraphPath;
  nodeId: string | undefined;
  /** An input or setting key, so the inspector can mark the field. */
  field?: string;
};

type CheckContext = { palette: readonly NodeDefinition[]; credentials: readonly Credential[] };

const CRON_FIELDS = 5;

const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);

const nodeIssues = (node: WorkflowNode, path: GraphPath, context: CheckContext): StudioIssue[] => {
  const issues: StudioIssue[] = [];
  const error = (message: string, field?: string) => issues.push({ severity: 'error', message, path, nodeId: node.id, ...(field ? { field } : {}) });
  const warn = (message: string, field?: string) => issues.push({ severity: 'warning', message, path, nodeId: node.id, ...(field ? { field } : {}) });
  const isBody = path.length > 0;

  if (!NODE_ID_PATTERN.test(node.id)) error('Its id must start with a letter and use only letters, digits, _ or -.');

  switch (node.kind) {
    case 'trigger':
      if (isBody) error('Triggers cannot be inside a loop.');
      if (node.trigger === 'schedule') {
        if (!node.schedule?.trim()) error('Add a schedule, for example 0 9 * * 1-5 for 09:00 on weekdays.', 'schedule');
        else if (node.schedule.trim().split(/\s+/).length !== CRON_FIELDS) error('A schedule has five parts: minute, hour, day, month and weekday.', 'schedule');
      }
      break;
    case 'action': {
      const resolved = resolveDefinition(node, context.palette);
      if (resolved.status === 'missing') warn(`${resolved.pluginId} is not installed in this workspace, so this step cannot run.`);
      if (resolved.status === 'other-version') warn(`Pinned to version ${resolved.pinned}; this workspace has ${resolved.installed}.`);
      if (resolved.status !== 'missing') {
        for (const field of resolved.definition.configFields) {
          if (field.required && isBlank(node.input[field.key])) warn(`${field.label} is required.`, field.key);
        }
        if (resolved.definition.auth.required && !node.credentialId) warn('Choose the account this step uses.', 'credentialId');
      }
      if (node.credentialId) {
        const credential = context.credentials.find((candidate) => candidate.id === node.credentialId);
        const pluginId = parsePluginRef(node.plugin)?.pluginId;
        if (!credential) warn('The chosen account was disconnected.', 'credentialId');
        else if (credential.pluginId !== pluginId) error(`The chosen account belongs to ${credential.pluginId}.`, 'credentialId');
        else if (credential.status !== 'connected') warn(credential.status === 'expired' ? 'The chosen account has expired; reconnect it.' : 'The chosen account failed its last check.', 'credentialId');
      }
      if (node.retry && (!Number.isInteger(node.retry.maxAttempts) || node.retry.maxAttempts < 1 || node.retry.maxAttempts > 10)) {
        error('Attempts must be a whole number from 1 to 10.', 'retry');
      }
      break;
    }
    case 'condition':
      break;
    case 'loop':
      if (!node.items.includes('{{')) error('Choose the list to go through, for example rows from an earlier step.', 'items');
      if (node.body.nodes.length === 0) error('Open the loop and add at least one step inside it.');
      if (node.concurrency !== undefined && (node.concurrency < 1 || node.concurrency > 20)) error('Items at once must be from 1 to 20.', 'concurrency');
      break;
    case 'delay':
      if (!Number.isInteger(node.ms) || node.ms < 0) error('The wait must be zero or more.', 'ms');
      break;
    case 'approval':
      if (isBody) error('Approvals cannot be inside a loop; put the loop after the approval.');
      break;
    case 'transform':
      break;
  }
  return issues;
};

/** References to steps that are gone, or that do not finish before this one. */
const referenceIssues = (node: WorkflowNode, graph: WorkflowGraph, path: GraphPath): StudioIssue[] => {
  const values = node.kind === 'action' ? node.input : node.kind === 'transform' ? node.output : node.kind === 'approval' ? { message: node.message } : node.kind === 'condition' ? { when: node.when } : node.kind === 'loop' ? { items: node.items } : {};
  const upstream = new Set(upstreamOf(graph, node.id).map((candidate) => candidate.id));
  const issues: StudioIssue[] = [];
  for (const [field, value] of Object.entries(values)) {
    for (const reference of referencesIn(value)) {
      const target = parseReference(reference);
      if (target.kind === 'node') {
        if (!findNode(graph, target.nodeId)) {
          // Inside a loop body, outer steps are readable too.
          if (path.length === 0) issues.push({ severity: 'warning', message: `Reads {{${reference}}}, but there is no step "${target.nodeId}".`, path, nodeId: node.id, field });
        } else if (!upstream.has(target.nodeId)) {
          issues.push({ severity: 'warning', message: `Reads data from "${target.nodeId}", which does not run before this step. Connect them first.`, path, nodeId: node.id, field });
        }
      }
      if ((target.kind === 'item' || target.kind === 'index') && path.length === 0) {
        issues.push({ severity: 'warning', message: `{{${reference}}} only exists inside a loop.`, path, nodeId: node.id, field });
      }
    }
  }
  return issues;
};

const graphIssues = (graph: WorkflowGraph, path: GraphPath, context: CheckContext): StudioIssue[] => {
  const issues: StudioIssue[] = [];
  const isBody = path.length > 0;
  const loopId = path.at(-1);
  if (graph.nodes.length === 0 && !isBody) issues.push({ severity: 'error', message: 'Add a trigger to start the workflow.', path, nodeId: undefined });

  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) issues.push({ severity: 'error', message: `Two steps share the id "${node.id}".`, path, nodeId: node.id });
    ids.add(node.id);
  }
  for (const edge of graph.edges) {
    const from = findNode(graph, edge.from);
    if (!from || !findNode(graph, edge.to)) issues.push({ severity: 'error', message: 'A cable points to a step that no longer exists.', path, nodeId: from?.id });
    else if (!flowOutputsOf(from).includes(edge.port ?? DEFAULT_PORT)) issues.push({ severity: 'error', message: `It has no ${edge.port ?? DEFAULT_PORT} output.`, path, nodeId: from.id });
  }
  const hasIncoming = new Set(graph.edges.map((edge) => edge.to));
  for (const node of graph.nodes) {
    if (node.kind === 'trigger' && hasIncoming.has(node.id)) issues.push({ severity: 'error', message: 'A trigger cannot have cables coming in.', path, nodeId: node.id });
    if (!isBody && node.kind !== 'trigger' && !hasIncoming.has(node.id)) {
      issues.push({ severity: 'error', message: 'Not connected yet. Patch a cable into its In jack.', path, nodeId: node.id });
    }
    issues.push(...nodeIssues(node, path, context), ...referenceIssues(node, graph, path));
    if (node.kind === 'loop') issues.push(...graphIssues(node.body, [...path, node.id], context));
  }
  if (!isBody && graph.nodes.length > 0 && !graph.nodes.some((node) => node.kind === 'trigger')) {
    issues.push({ severity: 'error', message: 'A workflow needs a trigger. Add Manual Trigger, a webhook or a schedule.', path, nodeId: undefined });
  }
  if (graph.nodes.length > 0 && !topologicalOrder(graph)) {
    issues.push({ severity: 'error', message: 'The cables go round in a circle. Use a Loop step to repeat work.', path, nodeId: loopId });
  }
  return issues;
};

export const checkWorkflow = (root: WorkflowGraph, context: CheckContext): StudioIssue[] => graphIssues(root, [], context);

export const hasErrors = (issues: readonly StudioIssue[]): boolean => issues.some((issue) => issue.severity === 'error');

/** Issues for one node, most serious first. */
export const issuesForNode = (issues: readonly StudioIssue[], path: GraphPath, nodeId: string): StudioIssue[] =>
  issues
    .filter((issue) => issue.nodeId === nodeId && issue.path.join('/') === path.join('/'))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));

/* ---------- Issues from the server ---------- */

const INDEXED_SEGMENT = /\.(nodes|edges)\[(\d+)\]/g;
const QUOTED_NODE = /(?:node|trigger) "([^"]+)"/;
const RUNNABLE_PATH = /^nodes\.([A-Za-z][\w-]*)(?:\.(\w+))?/;

/**
 * The backend reports paths such as `$.graph.nodes[3].retry.maxAttempts` or
 * `nodes.claude.credentialId`. They are mapped back onto the graph that was sent.
 */
export const issuesFromServer = (root: WorkflowGraph, issues: readonly Issue[]): StudioIssue[] =>
  issues.map((issue): StudioIssue => {
    const runnable = RUNNABLE_PATH.exec(issue.path);
    if (runnable?.[1]) return { severity: 'error', message: issue.message, path: locate(root, runnable[1]) ?? [], nodeId: runnable[1], ...(runnable[2] ? { field: runnable[2] } : {}) };

    let graph: WorkflowGraph | undefined = root;
    const path: string[] = [];
    let nodeId: string | undefined;
    let field: string | undefined;
    for (const match of issue.path.matchAll(INDEXED_SEGMENT)) {
      if (!graph) break;
      const index = Number(match[2]);
      if (match[1] === 'edges') {
        nodeId = graph.edges.at(index)?.from;
        break;
      }
      const node: WorkflowNode | undefined = graph.nodes.at(index);
      if (!node) break;
      if (nodeId !== undefined) path.push(nodeId);
      nodeId = node.id;
      graph = node.kind === 'loop' ? node.body : undefined;
      const rest = issue.path.slice((match.index ?? 0) + match[0].length);
      field = /^\.(\w+)/.exec(rest)?.[1];
      if (field === 'body') field = undefined;
    }
    const quoted = QUOTED_NODE.exec(issue.message)?.[1];
    if (nodeId === undefined && quoted) return { severity: 'error', message: issue.message, path: locate(root, quoted) ?? [], nodeId: quoted };
    return { severity: 'error', message: issue.message, path, nodeId, ...(field ? { field } : {}) };
  });

/** Where a node id lives: the loop ids above it. */
export const locate = (root: WorkflowGraph, nodeId: string, path: GraphPath = []): GraphPath | undefined => {
  const graph = graphAt(root, path);
  if (!graph) return undefined;
  if (graph.nodes.some((node) => node.id === nodeId)) return path;
  for (const node of graph.nodes) {
    if (node.kind !== 'loop') continue;
    const found = locate(root, nodeId, [...path, node.id]);
    if (found) return found;
  }
  return undefined;
};
