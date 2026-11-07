import { ValidationError, type Issue } from '../errors.js';
import { parsePluginRef } from '../registry/plugin-registry.js';
import { groupBy } from '../util.js';
import { isCondition } from './condition.js';
import { isValidTimeZone, parseCron } from './cron.js';
import { DEFAULT_PORT, outputPortsOf } from './ports.js';
import type { Workflow, WorkflowGraph, WorkflowNode } from './types.js';

const NODE_ID_PATTERN = /^[A-Za-z][\w-]{0,63}$/;
const MAX_NODES = 2_000;

const validateNode = (node: WorkflowNode, path: string, isBody: boolean, issues: Issue[]): void => {
  switch (node.kind) {
    case 'trigger':
      if (isBody) issues.push({ path, message: 'triggers are not allowed inside a loop body' });
      if (node.trigger === 'plugin' && (!node.plugin || !parsePluginRef(node.plugin) || !node.key)) {
        issues.push({ path, message: 'plugin triggers need plugin (id@version) and key' });
      }
      if (node.trigger === 'schedule') {
        if (!node.schedule) issues.push({ path, message: 'schedule triggers need a cron expression' });
        else {
          try {
            parseCron(node.schedule);
          } catch (error) {
            issues.push({ path: `${path}.schedule`, message: error instanceof Error ? error.message : 'is not a valid cron expression' });
          }
        }
      }
      if (node.timezone !== undefined && !isValidTimeZone(node.timezone)) {
        issues.push({ path: `${path}.timezone`, message: `"${node.timezone}" is not an IANA time zone` });
      }
      return;
    case 'action':
      if (!parsePluginRef(node.plugin)) issues.push({ path: `${path}.plugin`, message: 'must look like pluginId@1.0.0' });
      if (!node.action) issues.push({ path: `${path}.action`, message: 'is required' });
      if (node.retry) {
        const { maxAttempts, backoffMs } = node.retry;
        if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
          issues.push({ path: `${path}.retry.maxAttempts`, message: 'must be an integer from 1 to 10' });
        }
        if (backoffMs < 0) issues.push({ path: `${path}.retry.backoffMs`, message: 'must not be negative' });
      }
      return;
    case 'condition':
      if (!isCondition(node.when)) issues.push({ path: `${path}.when`, message: 'is not a valid condition' });
      return;
    case 'loop':
      if (!node.items.includes('{{')) issues.push({ path: `${path}.items`, message: 'must be an expression like {{nodes.x.output.items}}' });
      if (node.concurrency !== undefined && (node.concurrency < 1 || node.concurrency > 20)) {
        issues.push({ path: `${path}.concurrency`, message: 'must be from 1 to 20' });
      }
      issues.push(...validateGraph(node.body, { isBody: true }, `${path}.body`));
      return;
    case 'delay':
      if (!Number.isInteger(node.ms) || node.ms < 0) issues.push({ path: `${path}.ms`, message: 'must be a non-negative integer' });
      return;
    case 'approval':
      if (isBody) issues.push({ path, message: 'approvals are not allowed inside a loop body' });
      return;
    case 'transform':
      return;
  }
};

const findCycle = (graph: WorkflowGraph): boolean => {
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  const outgoing = groupBy(graph.edges, (edge) => edge.from);
  const queue = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    visited += 1;
    for (const edge of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, remaining);
      if (remaining === 0) queue.push(edge.to);
    }
  }
  return visited !== graph.nodes.length;
};

export const validateGraph = (graph: WorkflowGraph, { isBody }: { isBody: boolean }, path = '$.graph'): Issue[] => {
  const issues: Issue[] = [];
  if (graph.nodes.length === 0) issues.push({ path: `${path}.nodes`, message: 'must contain at least one node' });
  if (graph.nodes.length > MAX_NODES) issues.push({ path: `${path}.nodes`, message: `must contain at most ${MAX_NODES} nodes` });

  const nodes = new Map<string, WorkflowNode>();
  graph.nodes.forEach((node, index) => {
    const nodePath = `${path}.nodes[${index}]`;
    if (!NODE_ID_PATTERN.test(node.id)) issues.push({ path: `${nodePath}.id`, message: 'must start with a letter and use letters, digits, _ or -' });
    if (nodes.has(node.id)) issues.push({ path: `${nodePath}.id`, message: `duplicate node id "${node.id}"` });
    nodes.set(node.id, node);
    validateNode(node, nodePath, isBody, issues);
  });

  const edgeIds = new Set<string>();
  const connections = new Set<string>();
  graph.edges.forEach((edge, index) => {
    const edgePath = `${path}.edges[${index}]`;
    if (edgeIds.has(edge.id)) issues.push({ path: `${edgePath}.id`, message: `duplicate edge id "${edge.id}"` });
    edgeIds.add(edge.id);
    const from = nodes.get(edge.from);
    if (!from) issues.push({ path: `${edgePath}.from`, message: `unknown node "${edge.from}"` });
    if (!nodes.has(edge.to)) issues.push({ path: `${edgePath}.to`, message: `unknown node "${edge.to}"` });
    if (edge.from === edge.to) issues.push({ path: edgePath, message: 'a node cannot connect to itself' });
    const port = edge.port ?? DEFAULT_PORT;
    if (from && !outputPortsOf(from.kind).includes(port)) {
      issues.push({ path: `${edgePath}.port`, message: `${from.kind} nodes have no "${port}" port (${outputPortsOf(from.kind).join(', ')})` });
    }
    const connection = `${edge.from}:${port}->${edge.to}`;
    if (connections.has(connection)) issues.push({ path: edgePath, message: 'duplicate connection' });
    connections.add(connection);
  });

  const hasIncoming = new Set(graph.edges.map((edge) => edge.to));
  for (const node of graph.nodes) {
    if (node.kind === 'trigger' && hasIncoming.has(node.id)) issues.push({ path, message: `trigger "${node.id}" cannot have incoming connections` });
    if (!isBody && node.kind !== 'trigger' && !hasIncoming.has(node.id)) {
      issues.push({ path, message: `node "${node.id}" is not connected to any trigger` });
    }
  }
  if (!isBody && !graph.nodes.some((node) => node.kind === 'trigger')) issues.push({ path, message: 'a workflow needs at least one trigger' });
  if (issues.length === 0 && findCycle(graph)) {
    issues.push({ path, message: 'the graph contains a cycle; use a loop node to repeat work' });
  }
  return issues;
};

export const validateWorkflow = (workflow: Workflow): Issue[] => validateGraph(workflow.graph, { isBody: false });

export const assertValidWorkflow = (workflow: Workflow): void => {
  const issues = validateWorkflow(workflow);
  if (issues.length > 0) throw new ValidationError(`Workflow "${workflow.name}" is invalid`, issues);
};
