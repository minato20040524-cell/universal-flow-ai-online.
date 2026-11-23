import { BUILDERS, type Graph, type GraphEdge } from '../types.js';

export const AGENT_NODE_IDS = ['claude-01', 'claude-02', 'claude-03'];

export function defaultGraph(): Graph {
  const positions: Graph['positions'] = {
    'claude-01': { x: 0, y: 0 },
    'claude-02': { x: 0, y: 290 },
    'claude-03': { x: 0, y: 580 },
    hub: { x: 560, y: 230 },
    output: { x: 1060, y: BUILDERS.length * 130 },
  };
  BUILDERS.forEach((b, i) => {
    positions[b.id] = { x: 1060, y: i * 130 };
  });
  const edges: GraphEdge[] = [];
  AGENT_NODE_IDS.forEach((a, i) => {
    const n = i + 1;
    edges.push({ id: `e-c${n}-hub`, source: a, sourceHandle: 'out', target: 'hub', targetHandle: `in-c${n}` });
    edges.push({ id: `e-hub-c${n}`, source: 'hub', sourceHandle: `out-c${n}`, target: a, targetHandle: 'in' });
  });
  for (const b of BUILDERS) {
    edges.push({ id: `e-hub-${b.id}`, source: 'hub', sourceHandle: 'out', target: b.id, targetHandle: 'in' });
    edges.push({ id: `e-${b.id}-output`, source: b.id, sourceHandle: 'out', target: 'output', targetHandle: 'in-r' });
  }
  return { positions, edges };
}

/** Jalur terpendek (BFS) mengikuti arah kabel. null bila kabel terputus. */
export function findRoute(graph: Graph, from: string, to: string): GraphEdge[] | null {
  if (from === to) return [];
  const queue: { node: string; path: GraphEdge[] }[] = [{ node: from, path: [] }];
  const seen = new Set([from]);
  while (queue.length) {
    const { node, path } = queue.shift()!;
    for (const e of graph.edges) {
      if (e.source !== node || seen.has(e.target)) continue;
      const next = [...path, e];
      if (e.target === to) return next;
      seen.add(e.target);
      queue.push({ node: e.target, path: next });
    }
  }
  return null;
}
