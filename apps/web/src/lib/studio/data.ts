import type { DataPort, JsonType, WorkflowGraph, WorkflowNode } from '../types.js';
import { findNode, graphAt, upstreamOf, type GraphPath, type NodePorts } from './graph.js';

/**
 * Data between steps travels as template references, `{{nodes.claude.output.text}}`.
 * Studio draws a data cable for every reference in an action's inputs and offers
 * the outputs of earlier steps when an input is edited.
 */

const REFERENCE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const FULL_REFERENCE = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const NODE_REFERENCE = /^nodes\.([A-Za-z][\w-]*)\.output(?:\.([A-Za-z_$][\w$-]*))?/;
const TRIGGER_REFERENCE = /^trigger(?:\.([A-Za-z_$][\w$-]*))?/;

export const tokenFor = (reference: string): string => `{{${reference}}}`;

/** Every path a template value refers to, like the engine's listReferences. */
export const referencesIn = (value: unknown): string[] => {
  if (typeof value === 'string') return [...value.matchAll(REFERENCE)].flatMap((match) => (match[1] ? [match[1].trim()] : []));
  if (Array.isArray(value)) return value.flatMap(referencesIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(referencesIn);
  return [];
};

/** The reference when a value is exactly one placeholder (it then keeps the source's type). */
export const soleReference = (value: unknown): string | undefined => (typeof value === 'string' ? FULL_REFERENCE.exec(value)?.[1]?.trim() : undefined);

export type ReferenceTarget =
  | { kind: 'node'; nodeId: string; port: string | undefined }
  | { kind: 'trigger'; port: string | undefined }
  | { kind: 'item' }
  | { kind: 'index' }
  | { kind: 'unknown' };

export const parseReference = (reference: string): ReferenceTarget => {
  const node = NODE_REFERENCE.exec(reference);
  if (node?.[1]) return { kind: 'node', nodeId: node[1], port: node[2] };
  const trigger = TRIGGER_REFERENCE.exec(reference);
  if (trigger) return { kind: 'trigger', port: trigger[1] };
  if (/^item\b/.test(reference)) return { kind: 'item' };
  if (/^index$/.test(reference)) return { kind: 'index' };
  return { kind: 'unknown' };
};

/**
 * The path that reads one output jack. A trigger's output is its payload, so
 * builtin triggers are read through `trigger` (whichever trigger started the run).
 */
export const referenceFor = (node: WorkflowNode, portKey: string): string => {
  if (node.kind === 'trigger') return node.trigger === 'plugin' ? `trigger.${portKey}` : 'trigger';
  return `nodes.${node.id}.output.${portKey}`;
};

export type DataLink = { id: string; fromNodeId: string; fromPort: string | undefined; toNodeId: string; toPort: string; reference: string };

/** Data cables for one graph: action inputs that read another step's output. */
export const dataLinksOf = (graph: WorkflowGraph, portsByNode: ReadonlyMap<string, NodePorts>): DataLink[] => {
  const triggers = graph.nodes.filter((node) => node.kind === 'trigger');
  const outputKey = (nodeId: string, port: string | undefined): string | undefined => {
    const outputs = portsByNode.get(nodeId)?.dataOut ?? [];
    if (port && outputs.some((output) => output.key === port)) return port;
    return outputs[0]?.key;
  };
  return graph.nodes.flatMap((node) => {
    if (node.kind !== 'action') return [];
    return Object.entries(node.input).flatMap(([inputKey, value]) =>
      referencesIn(value).flatMap((reference): DataLink[] => {
        const target = parseReference(reference);
        if (target.kind === 'node' && findNode(graph, target.nodeId)) {
          return [{ id: `${target.nodeId}>${node.id}.${inputKey}:${reference}`, fromNodeId: target.nodeId, fromPort: outputKey(target.nodeId, target.port), toNodeId: node.id, toPort: inputKey, reference }];
        }
        if (target.kind === 'trigger') {
          return triggers.map((trigger) => ({
            id: `${trigger.id}>${node.id}.${inputKey}:${reference}`,
            fromNodeId: trigger.id,
            fromPort: trigger.kind === 'trigger' && trigger.trigger === 'plugin' ? outputKey(trigger.id, target.port) : 'payload',
            toNodeId: node.id,
            toPort: inputKey,
            reference,
          }));
        }
        return [];
      }),
    );
  });
};

export type DataChoice = { label: string; reference: string; type: JsonType | 'any'; description: string | undefined };
export type DataSource = { id: string; title: string; choices: DataChoice[]; /** Free path under this source, e.g. `body.text`. */ pathPrefix: string | undefined };

type PortsLookup = (node: WorkflowNode) => NodePorts;
type TitleLookup = (node: WorkflowNode) => string;

const choicesOf = (node: WorkflowNode, outputs: readonly DataPort[]): DataChoice[] =>
  outputs.map((port) => ({ label: port.label, reference: referenceFor(node, port.key), type: port.type, description: port.description }));

const sourceFor = (node: WorkflowNode, ports: PortsLookup, title: TitleLookup): DataSource => {
  const choices = choicesOf(node, ports(node).dataOut);
  if (node.kind === 'trigger') return { id: node.id, title: title(node), choices, pathPrefix: 'trigger' };
  return { id: node.id, title: title(node), choices, pathPrefix: `nodes.${node.id}.output` };
};

/**
 * What a step can read: everything that has finished before it. Inside a loop
 * body that adds the current item and index, then the steps before the loop.
 */
export const dataSourcesFor = (root: WorkflowGraph, path: GraphPath, nodeId: string, ports: PortsLookup, title: TitleLookup): DataSource[] => {
  const sources: DataSource[] = [];
  const seen = new Set<string>();
  const addUpstream = (graph: WorkflowGraph, id: string) => {
    for (const node of upstreamOf(graph, id)) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      sources.push(sourceFor(node, ports, title));
    }
  };
  const graph = graphAt(root, path);
  if (graph) addUpstream(graph, nodeId);
  if (path.length > 0) {
    sources.push({
      id: '$item',
      title: 'Current item',
      pathPrefix: 'item',
      choices: [
        { label: 'Item', reference: 'item', type: 'any', description: 'The element of the list this iteration works on' },
        { label: 'Position', reference: 'index', type: 'integer', description: 'Counts from 0' },
      ],
    });
    for (let depth = path.length - 1; depth >= 0; depth -= 1) {
      const outer = graphAt(root, path.slice(0, depth));
      const loopId = path[depth];
      if (outer && loopId) addUpstream(outer, loopId);
    }
  }
  return sources;
};

/** Sets an action input to read one output; an earlier value is replaced (undo brings it back). */
export const linkInput = (graph: WorkflowGraph, nodeId: string, inputKey: string, reference: string): WorkflowGraph => ({
  ...graph,
  nodes: graph.nodes.map((node) => (node.id === nodeId && node.kind === 'action' ? { ...node, input: { ...node.input, [inputKey]: tokenFor(reference) } } : node)),
});

/** Removes one reference from an input, keeping any text around it. */
export const unlinkInput = (graph: WorkflowGraph, nodeId: string, inputKey: string, reference: string): WorkflowGraph => ({
  ...graph,
  nodes: graph.nodes.map((node) => {
    if (node.id !== nodeId || node.kind !== 'action') return node;
    const value = node.input[inputKey];
    if (typeof value !== 'string') return node;
    const remaining = value.replace(REFERENCE, (match, inner: string) => (inner.trim() === reference ? '' : match)).trim();
    const input = { ...node.input };
    if (remaining === '') delete input[inputKey];
    else input[inputKey] = remaining;
    return { ...node, input };
  }),
});

/** Inserts a placeholder at the caret, the way the data picker does. */
export const insertToken = (text: string, reference: string, selectionStart = text.length, selectionEnd = selectionStart): string =>
  `${text.slice(0, selectionStart)}${tokenFor(reference)}${text.slice(selectionEnd)}`;
