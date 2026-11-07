import type { Position3D, WorkflowGraph, WorkflowNode } from '../types.js';
import { topologicalOrder, type NodePorts } from './graph.js';

/**
 * Board sizes and jack positions. The constants are the node generator's
 * (scene units); Studio recomputes rows because a transform's outputs and a
 * trigger's payload jack are known only per node. The tests check that the
 * result matches the generator's geometry for every palette module.
 */

export const GEOMETRY = { width: 2.4, header: 0.7, portSpacing: 0.36, padding: 0.3, depth: 0.4 } as const;

/** Pixels per scene unit on the stage. */
export const UNIT_PX = 100;
/** How far boards float above the floor, and how thick they are, in pixels. */
export const BOARD_LIFT_PX = 2;
export const BOARD_THICKNESS_PX = 18;
export const JACK_INSET_PX = 16;
export const GRID_UNITS = 0.2;

export type JackKind = 'flow' | 'data';
export type JackSide = 'in' | 'out';
export type JackLayout = { key: string; kind: JackKind; side: JackSide; label: string; /** Centre, relative to the board's top-left corner, in pixels. */ x: number; y: number };
export type BoardLayout = { width: number; height: number; jacks: JackLayout[] };

const FLOW_LABELS: Record<string, string> = { in: 'In', out: 'Out', error: 'Error', true: 'True', false: 'False', approved: 'Approved', rejected: 'Rejected' };
export const flowLabel = (port: string): string => FLOW_LABELS[port] ?? port;

/** Board height in scene units, exactly as the generator computes it. */
export const boardHeightUnits = (leftRows: number, rightRows: number): number => GEOMETRY.header + Math.max(leftRows, rightRows, 1) * GEOMETRY.portSpacing + GEOMETRY.padding;

export const layoutBoard = (ports: NodePorts): BoardLayout => {
  const width = GEOMETRY.width * UNIT_PX;
  const left = [...ports.flowIn.map((key) => ({ key, kind: 'flow' as const, label: flowLabel(key) })), ...ports.dataIn.map((port) => ({ key: port.key, kind: 'data' as const, label: port.label }))];
  const right = [...ports.flowOut.map((key) => ({ key, kind: 'flow' as const, label: flowLabel(key) })), ...ports.dataOut.map((port) => ({ key: port.key, kind: 'data' as const, label: port.label }))];
  const rowY = (index: number) => (GEOMETRY.header + index * GEOMETRY.portSpacing + GEOMETRY.portSpacing / 2) * UNIT_PX;
  return {
    width,
    height: boardHeightUnits(left.length, right.length) * UNIT_PX,
    jacks: [
      ...left.map((jack, index): JackLayout => ({ ...jack, side: 'in', x: JACK_INSET_PX, y: rowY(index) })),
      ...right.map((jack, index): JackLayout => ({ ...jack, side: 'out', x: width - JACK_INSET_PX, y: rowY(index) })),
    ],
  };
};

export const ORIGIN: Position3D = { x: 0, y: 0, z: 0 };
export const positionOf = (node: WorkflowNode): Position3D => node.position ?? ORIGIN;

/** Stage pixels of a board's top-left corner; positions are board centres in scene units. */
export const boardCorner = (position: Position3D, layout: BoardLayout): { x: number; y: number } => ({
  x: position.x * UNIT_PX - layout.width / 2,
  y: position.z * UNIT_PX - layout.height / 2,
});

/** A jack's centre on the stage, at the height of the board's top face. */
export const jackPoint = (position: Position3D, layout: BoardLayout, jack: JackLayout): { x: number; y: number; z: number } => {
  const corner = boardCorner(position, layout);
  return { x: corner.x + jack.x, y: corner.y + jack.y, z: position.y * UNIT_PX + BOARD_LIFT_PX + BOARD_THICKNESS_PX };
};

export const snap = (value: number): number => Math.round(value / GRID_UNITS) * GRID_UNITS;
export const snapPosition = (position: Position3D): Position3D => ({ x: snap(position.x), y: position.y, z: snap(position.z) });

const COLUMN_GAP = 1.1;
const ROW_GAP = 0.5;

/**
 * Left-to-right layered layout: each step goes one column after its latest
 * predecessor; rows are ordered by their predecessors so cables cross less.
 */
export const autoLayout = (graph: WorkflowGraph, heightOf: (node: WorkflowNode) => number): WorkflowGraph => {
  const order = topologicalOrder(graph) ?? graph.nodes.map((node) => node.id);
  const column = new Map<string, number>();
  const predecessors = new Map<string, string[]>();
  for (const edge of graph.edges) predecessors.set(edge.to, [...(predecessors.get(edge.to) ?? []), edge.from]);
  for (const id of order) column.set(id, Math.max(-1, ...(predecessors.get(id) ?? []).map((from) => column.get(from) ?? -1)) + 1);

  const columns: string[][] = [];
  for (const id of order) {
    const index = column.get(id) ?? 0;
    (columns[index] ??= []).push(id);
  }
  const rank = new Map<string, number>();
  const positions = new Map<string, Position3D>();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  columns.forEach((ids, columnIndex) => {
    const average = (id: string) => {
      const ranks = (predecessors.get(id) ?? []).map((from) => rank.get(from) ?? 0);
      return ranks.length === 0 ? 0 : ranks.reduce((sum, value) => sum + value, 0) / ranks.length;
    };
    const sorted = [...ids].sort((a, b) => average(a) - average(b));
    sorted.forEach((id, index) => rank.set(id, index));
    const heights = sorted.map((id) => {
      const node = byId.get(id);
      return node ? heightOf(node) : 1;
    });
    const total = heights.reduce((sum, height) => sum + height, 0) + ROW_GAP * Math.max(0, heights.length - 1);
    let cursor = -total / 2;
    sorted.forEach((id, index) => {
      const height = heights[index] ?? 1;
      positions.set(id, { x: columnIndex * (GEOMETRY.width + COLUMN_GAP), y: 0, z: snap(cursor + height / 2) });
      cursor += height + ROW_GAP;
    });
  });
  return { ...graph, nodes: graph.nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? positionOf(node) })) };
};

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** Stage-pixel bounds of all boards. */
export const boundsOf = (boards: readonly { position: Position3D; layout: BoardLayout }[]): Bounds | undefined => {
  if (boards.length === 0) return undefined;
  const corners = boards.map(({ position, layout }) => ({ ...boardCorner(position, layout), width: layout.width, height: layout.height }));
  return {
    minX: Math.min(...corners.map((corner) => corner.x)),
    minY: Math.min(...corners.map((corner) => corner.y)),
    maxX: Math.max(...corners.map((corner) => corner.x + corner.width)),
    maxY: Math.max(...corners.map((corner) => corner.y + corner.height)),
  };
};

/** A free spot for a new step: right of `after` when given, moved down until it overlaps nothing. */
export const freeSpot = (graph: WorkflowGraph, heightOf: (node: WorkflowNode) => number, preferred: Position3D, newHeight: number): Position3D => {
  const overlaps = (candidate: Position3D) =>
    graph.nodes.some((node) => {
      const position = positionOf(node);
      return Math.abs(position.x - candidate.x) < GEOMETRY.width + 0.2 && Math.abs(position.z - candidate.z) < (heightOf(node) + newHeight) / 2 + 0.2;
    });
  let candidate = snapPosition(preferred);
  for (let attempt = 0; attempt < 40 && overlaps(candidate); attempt += 1) candidate = { ...candidate, z: snap(candidate.z + 0.6) };
  return candidate;
};
