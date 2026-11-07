import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import {
  DEFAULT_CAMERA,
  PERSPECTIVE_PX,
  PERSPECTIVE_VIEW,
  cameraTransform,
  clampCamera,
  fitCamera,
  orbit,
  panTo,
  project,
  unproject,
  zoomAt,
  type Camera,
  type Point2,
  type Viewport,
} from '../../lib/studio/camera';
import type { DataLink } from '../../lib/studio/data';
import type { NodeRunView } from '../../lib/studio/execution';
import { DEFAULT_PORT, type NodePorts } from '../../lib/studio/graph';
import {
  BOARD_LIFT_PX,
  BOARD_THICKNESS_PX,
  UNIT_PX,
  boardCorner,
  boundsOf,
  positionOf,
  snapPosition,
  type BoardLayout,
  type JackKind,
  type JackLayout,
} from '../../lib/studio/layout';
import type { EdgeState, Position3D, WorkflowEdge, WorkflowNode } from '../../lib/types';
import { Board, type BoardIssue } from './board';
import { CableLayer, type Cable, type DraftCable } from './cables';
import { Icon } from './icons';
import type { PendingConnection, Selection } from './use-editor';

export type BoardModel = {
  node: WorkflowNode;
  layout: BoardLayout;
  ports: NodePorts;
  title: string;
  summary: string;
  appTitle: string;
  icon: string;
  color: string;
  missing: boolean;
  bodySteps: number | undefined;
};

export type StageProps = {
  pathKey: string;
  boards: readonly BoardModel[];
  edges: readonly WorkflowEdge[];
  dataLinks: readonly DataLink[];
  runViews: ReadonlyMap<string, NodeRunView>;
  edgeStates: Readonly<Record<string, EdgeState>>;
  issues: ReadonlyMap<string, BoardIssue>;
  selection: Selection;
  pending: PendingConnection | undefined;
  readOnly: boolean;
  fitRequest: number;
  overlay: ReactNode;
  emptyHint: ReactNode;
  onSelect: (selection: Selection) => void;
  onMove: (positions: ReadonlyMap<string, Position3D>, group: string) => void;
  onMoveEnd: () => void;
  onConnect: (from: string, port: string, to: string) => void;
  onLinkData: (fromNodeId: string, fromPort: string, toNodeId: string, toPort: string) => void;
  onAddAt: (definitionType: string, position: Position3D) => void;
  onDelete: () => void;
  onPending: (pending: PendingConnection | undefined) => void;
  onOpenLoop: (nodeId: string) => void;
  onReview: (nodeId: string) => void;
  onNotice: (message: string) => void;
};

export const NODE_DRAG_TYPE = 'application/x-universal-flow-node';

/** Cables lie on a plane just above the boards' faces. */
const CABLE_Z = BOARD_LIFT_PX + BOARD_THICKNESS_PX + 1;
const DRAG_LIFT_PX = 26;
const FLOOR_SIZE = 9000;
const CLICK_SLOP_PX = 4;
const NUDGE_UNITS = 0.2;
const READABLE_ZOOM = 0.72;
/** Below this zoom the fine grid would shimmer, so only the metre lines stay. */
const FAR_ZOOM = 0.45;

type Gesture =
  | { kind: 'pan'; pointerId: number; grabbed: Point2; start: Point2; moved: boolean }
  | { kind: 'orbit'; pointerId: number; start: Point2; camera: Camera }
  | { kind: 'move'; pointerId: number; ids: ReadonlySet<string>; floor: Point2; start: Point2; moved: boolean }
  | { kind: 'cable'; pointerId: number; from: PendingConnection; start: Point2; moved: boolean }
  | { kind: 'pinch'; camera: Camera; distance: number; middle: Point2 };

const closestData = (target: EventTarget | null, attribute: string): HTMLElement | undefined => {
  if (!(target instanceof Element)) return undefined;
  const found = target.closest(`[${attribute}]`);
  return found instanceof HTMLElement ? found : undefined;
};

const isTextField = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;

const jackKind = (value: string | undefined): JackKind | undefined => (value === 'flow' || value === 'data' ? value : undefined);

const sameIds = (selection: Selection, ids: readonly string[]) => selection.kind === 'nodes' && selection.ids.length === ids.length && ids.every((id) => selection.ids.includes(id));

export const Stage = (props: StageProps) => {
  const { boards, edges, dataLinks, selection, pending, readOnly } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 });
  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA);
  const [animate, setAnimate] = useState(false);
  const [drag, setDrag] = useState<{ ids: ReadonlySet<string>; dx: number; dy: number } | undefined>(undefined);
  const [draft, setDraft] = useState<{ from: PendingConnection; to: Point2 } | undefined>(undefined);
  const [hovered, setHovered] = useState<{ nodeId: string; jack: string } | undefined>(undefined);
  const gesture = useRef<Gesture | undefined>(undefined);
  const pointers = useRef(new Map<number, Point2>());
  /** Clicks right after a drag are the end of that drag, not a new action. */
  const suppressClicksUntil = useRef(0);
  const fittedFor = useRef<string | undefined>(undefined);

  // The latest values for event handlers that outlive a render.
  const live = useRef({ camera, viewport, props });
  live.current = { camera, viewport, props };

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewport({ width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const byId = useMemo(() => new Map(boards.map((board) => [board.node.id, board])), [boards]);

  const offsetOf = useCallback((nodeId: string) => (drag?.ids.has(nodeId) ? { dx: drag.dx, dy: drag.dy, lift: DRAG_LIFT_PX } : { dx: 0, dy: 0, lift: 0 }), [drag]);

  const box = useMemo(() => {
    const bounds = boundsOf(boards.map((board) => ({ position: positionOf(board.node), layout: board.layout })));
    return bounds ? { ...bounds, height: CABLE_Z } : undefined;
  }, [boards]);

  /**
   * Frames every step. When that would make text too small to read, the
   * opening view keeps a readable zoom and starts at the left, where the
   * trigger is; "Show all steps" always frames everything.
   */
  const fit = useCallback(
    (smooth: boolean, readable = false) => {
      const size = live.current.viewport;
      if (size.width === 0) return;
      setAnimate(smooth);
      setCamera((current) => {
        if (!box) return { ...current, target: { x: 0, y: 0 } };
        const all = fitCamera(current, size, box);
        if (!readable || all.zoom >= READABLE_ZOOM) return all;
        const first = [...live.current.props.boards].sort((a, b) => positionOf(a.node).x - positionOf(b.node).x)[0];
        if (!first) return all;
        const zoomed = { ...all, zoom: READABLE_ZOOM };
        const centre = { x: positionOf(first.node).x * UNIT_PX, y: positionOf(first.node).z * UNIT_PX };
        return panTo(zoomed, size, centre, { x: Math.min(size.width / 2, 48 + (first.layout.width / 2) * READABLE_ZOOM), y: size.height / 2 });
      });
    },
    [box],
  );

  // Frame the steps when a workflow or loop body opens, and when asked to.
  useEffect(() => {
    if (viewport.width === 0) return;
    if (fittedFor.current === props.pathKey && boards.length > 0) return;
    fittedFor.current = boards.length > 0 ? props.pathKey : undefined;
    fit(false, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pathKey, viewport.width > 0, boards.length > 0]);

  useEffect(() => {
    if (props.fitRequest > 0) fit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitRequest]);

  /** Where a jack is on the cable plane; a lifted board's jack is moved so it still lines up on screen. */
  const jackOnCablePlane = useCallback(
    (board: BoardModel, jack: JackLayout): Point2 => {
      const { dx, dy, lift } = offsetOf(board.node.id);
      const corner = boardCorner(positionOf(board.node), board.layout);
      const point = { x: corner.x + dx + jack.x, y: corner.y + dy + jack.y };
      if (lift === 0 && positionOf(board.node).y === 0) return point;
      const height = CABLE_Z + lift + positionOf(board.node).y * UNIT_PX;
      return unproject(camera, viewport, project(camera, viewport, { ...point, z: height }), CABLE_Z);
    },
    [offsetOf, camera, viewport],
  );

  const findJack = (board: BoardModel | undefined, side: 'in' | 'out', key: string) => board?.layout.jacks.find((jack) => jack.side === side && jack.key === key);

  const cables = useMemo((): Cable[] => {
    const result: Cable[] = [];
    for (const edge of edges) {
      const fromBoard = byId.get(edge.from);
      const toBoard = byId.get(edge.to);
      const port = edge.port ?? DEFAULT_PORT;
      const fromJack = findJack(fromBoard, 'out', port);
      const toJack = findJack(toBoard, 'in', 'in');
      if (!fromBoard || !toBoard || !fromJack || !toJack) continue;
      result.push({
        id: `edge:${edge.id}`,
        kind: 'flow',
        from: jackOnCablePlane(fromBoard, fromJack),
        to: jackOnCablePlane(toBoard, toJack),
        port,
        state: props.edgeStates[edge.id],
        color: undefined,
        selected: selection.kind === 'edge' && selection.id === edge.id,
        emphasis: true,
        target: { type: 'edge', id: edge.id },
      });
    }
    for (const link of dataLinks) {
      const fromBoard = byId.get(link.fromNodeId);
      const toBoard = byId.get(link.toNodeId);
      const fromJack = link.fromPort ? findJack(fromBoard, 'out', link.fromPort) : undefined;
      const toJack = findJack(toBoard, 'in', link.toPort);
      if (!fromBoard || !toBoard || !fromJack || !toJack) continue;
      result.push({
        id: `data:${link.id}`,
        kind: 'data',
        from: jackOnCablePlane(fromBoard, fromJack),
        to: jackOnCablePlane(toBoard, toJack),
        port: undefined,
        state: undefined,
        color: fromBoard.color,
        selected: selection.kind === 'data' && selection.link.id === link.id,
        emphasis: selection.kind === 'nodes' && (selection.ids.includes(link.fromNodeId) || selection.ids.includes(link.toNodeId)),
        target: { type: 'data', link },
      });
    }
    return result;
  }, [edges, dataLinks, byId, jackOnCablePlane, props.edgeStates, selection]);

  const draftCable = useMemo((): DraftCable | undefined => {
    if (!draft) return undefined;
    const board = byId.get(draft.from.nodeId);
    const jack = findJack(board, 'out', draft.from.port);
    if (!board || !jack) return undefined;
    return { kind: draft.from.kind, from: jackOnCablePlane(board, jack), to: draft.to };
  }, [draft, byId, jackOnCablePlane]);

  const connectedByNode = useMemo(() => {
    const map = new Map<string, string[]>();
    const add = (nodeId: string, key: string) => map.set(nodeId, [...(map.get(nodeId) ?? []), key]);
    for (const edge of edges) {
      add(edge.from, `out:${edge.port ?? DEFAULT_PORT}`);
      add(edge.to, 'in:in');
    }
    for (const link of dataLinks) {
      if (link.fromPort) add(link.fromNodeId, `out:${link.fromPort}`);
      add(link.toNodeId, `in:${link.toPort}`);
    }
    return new Map([...map].map(([nodeId, keys]) => [nodeId, [...new Set(keys)].sort().join(' ')]));
  }, [edges, dataLinks]);

  /* ---------- Connecting ---------- */

  const complete = useCallback((from: PendingConnection, toNodeId: string, toPort: string) => {
    const { props: current } = live.current;
    if (from.kind === 'flow') current.onConnect(from.nodeId, from.port, toNodeId);
    else current.onLinkData(from.nodeId, from.port, toNodeId, toPort);
  }, []);

  const handleJack = useCallback(
    (nodeId: string, jack: JackLayout, byKeyboard: boolean) => {
      if (!byKeyboard && performance.now() < suppressClicksUntil.current) return;
      const { props: current } = live.current;
      if (current.readOnly) return;
      if (jack.side === 'out') {
        const same = current.pending?.nodeId === nodeId && current.pending.port === jack.key;
        current.onPending(same ? undefined : { nodeId, port: jack.key, kind: jack.kind });
        return;
      }
      const waiting = current.pending;
      if (waiting) {
        if (waiting.nodeId === nodeId) return current.onNotice('Choose an input on another step.');
        if (waiting.kind !== jack.kind) {
          return current.onNotice(waiting.kind === 'flow' ? 'This cable starts the next step, so plug it into an In jack.' : 'This cable carries data, so plug it into one of the inputs below In.');
        }
        complete(waiting, nodeId, jack.key);
        current.onPending(undefined);
        return;
      }
      const incoming =
        jack.kind === 'flow'
          ? current.edges.filter((edge) => edge.to === nodeId).map((edge): Selection => ({ kind: 'edge', id: edge.id }))
          : current.dataLinks.filter((link) => link.toNodeId === nodeId && link.toPort === jack.key).map((link): Selection => ({ kind: 'data', link }));
      const [only] = incoming;
      if (incoming.length === 1 && only) current.onSelect(only);
      else current.onNotice('Start from an output jack on the right of a step, then choose this input.');
    },
    [complete],
  );

  const dropCable = (from: PendingConnection, clientX: number, clientY: number) => {
    const element = document.elementFromPoint(clientX, clientY);
    const jack = closestData(element, 'data-jack');
    const { props: current } = live.current;
    if (jack?.dataset.side === 'in' && jack.dataset.node && jack.dataset.port) {
      if (jack.dataset.node === from.nodeId) return current.onNotice('A step cannot feed itself.');
      if (jackKind(jack.dataset.kind) !== from.kind) {
        return current.onNotice(from.kind === 'flow' ? 'Plug this cable into an In jack.' : 'Plug data into one of the inputs below In.');
      }
      return complete(from, jack.dataset.node, jack.dataset.port);
    }
    const board = closestData(element, 'data-node-id');
    if (board?.dataset.nodeId && board.dataset.nodeId !== from.nodeId) {
      if (from.kind === 'flow') return complete(from, board.dataset.nodeId, 'in');
      return current.onNotice('Drop data on the input it should fill.');
    }
  };

  /* ---------- Pointer gestures ---------- */

  const screenOf = (event: { clientX: number; clientY: number }): Point2 => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const capture = (event: PointerEvent<HTMLDivElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The pointer may already be gone (a very short tap).
    }
  };

  /** Drags on boards and jacks capture the pointer only once they move, so a plain click still reaches the button. */
  const startMoving = (event: PointerEvent<HTMLDivElement>, current: { moved: boolean }, distance: number): boolean => {
    if (current.moved) return true;
    if (distance <= CLICK_SLOP_PX) return false;
    current.moved = true;
    capture(event);
    return true;
  };

  const startPinch = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return;
    gesture.current = { kind: 'pinch', camera: live.current.camera, distance: Math.hypot(a.x - b.x, a.y - b.y), middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    setDrag(undefined);
    setDraft(undefined);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button > 2 || closestData(event.target, 'data-stage-overlay') || closestData(event.target, 'data-board-action')) return;
    const screen = screenOf(event);
    pointers.current.set(event.pointerId, screen);
    setAnimate(false);
    if (pointers.current.size === 2) return startPinch();
    if (pointers.current.size > 2) return;

    const jack = closestData(event.target, 'data-jack');
    if (jack) {
      const kind = jackKind(jack.dataset.kind);
      if (!readOnly && jack.dataset.side === 'out' && jack.dataset.node && jack.dataset.port && kind && event.button === 0) {
        gesture.current = { kind: 'cable', pointerId: event.pointerId, from: { nodeId: jack.dataset.node, port: jack.dataset.port, kind }, start: screen, moved: false };
      }
      return;
    }

    const board = closestData(event.target, 'data-node-id');
    const nodeId = board?.dataset.nodeId;
    if (nodeId) {
      if (event.button !== 0) return;
      const current = selection.kind === 'nodes' ? selection.ids : [];
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        const ids = current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId];
        props.onSelect(ids.length > 0 ? { kind: 'nodes', ids } : { kind: 'none' });
        return;
      }
      const ids = current.includes(nodeId) ? current : [nodeId];
      if (!sameIds(selection, ids)) props.onSelect({ kind: 'nodes', ids });
      if (!readOnly) {
        gesture.current = { kind: 'move', pointerId: event.pointerId, ids: new Set(ids), floor: unproject(camera, viewport, screen), start: screen, moved: false };
      }
      return;
    }

    const cable = closestData(event.target, 'data-cable');
    if (cable?.dataset.cable) {
      const found = cables.find((candidate) => candidate.id === cable.dataset.cable);
      if (found) props.onSelect(found.target.type === 'edge' ? { kind: 'edge', id: found.target.id } : { kind: 'data', link: found.target.link });
      return;
    }

    if (event.button === 2 || event.altKey || (event.button === 0 && event.shiftKey)) {
      gesture.current = { kind: 'orbit', pointerId: event.pointerId, start: screen, camera };
    } else {
      gesture.current = { kind: 'pan', pointerId: event.pointerId, grabbed: unproject(camera, viewport, screen), start: screen, moved: false };
    }
    capture(event);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const screen = screenOf(event);
    pointers.current.set(event.pointerId, screen);
    const current = gesture.current;
    if (!current) return;
    if (current.kind === 'pinch') {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const factor = Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, current.distance);
      setCamera(zoomAt(current.camera, viewport, current.middle, factor));
      return;
    }
    if (current.pointerId !== event.pointerId) return;
    const distance = Math.hypot(screen.x - current.start.x, screen.y - current.start.y);
    switch (current.kind) {
      case 'pan':
        if (distance > CLICK_SLOP_PX) current.moved = true;
        setCamera((now) => panTo(now, viewport, current.grabbed, screen));
        return;
      case 'orbit':
        setCamera(orbit(current.camera, -(screen.x - current.start.x) * 0.25, (screen.y - current.start.y) * 0.2));
        return;
      case 'move': {
        if (!startMoving(event, current, distance)) return;
        const floor = unproject(camera, viewport, screen);
        setDrag({ ids: current.ids, dx: floor.x - current.floor.x, dy: floor.y - current.floor.y });
        return;
      }
      case 'cable': {
        if (!startMoving(event, current, distance)) return;
        setDraft({ from: current.from, to: unproject(camera, viewport, screen, CABLE_Z) });
        const jack = closestData(document.elementFromPoint(event.clientX, event.clientY), 'data-jack');
        const next = jack?.dataset.side === 'in' && jack.dataset.node && jack.dataset.jack ? { nodeId: jack.dataset.node, jack: jack.dataset.jack } : undefined;
        setHovered((previous) => (previous?.nodeId === next?.nodeId && previous?.jack === next?.jack ? previous : next));
      }
    }
  };

  const finishGesture = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    pointers.current.delete(event.pointerId);
    const current = gesture.current;
    if (!current) return;
    if (current.kind === 'pinch') {
      if (pointers.current.size < 2) gesture.current = undefined;
      return;
    }
    if (current.pointerId !== event.pointerId) return;
    gesture.current = undefined;
    switch (current.kind) {
      case 'pan':
        if (!current.moved && !cancelled) {
          props.onSelect({ kind: 'none' });
          props.onPending(undefined);
        }
        return;
      case 'orbit':
        return;
      case 'move': {
        const moved = drag;
        setDrag(undefined);
        if (!current.moved || !moved || cancelled) return;
        suppressClicksUntil.current = performance.now() + 250;
        const positions = new Map<string, Position3D>();
        for (const id of current.ids) {
          const board = byId.get(id);
          if (!board) continue;
          const position = positionOf(board.node);
          positions.set(id, snapPosition({ x: position.x + moved.dx / UNIT_PX, y: position.y, z: position.z + moved.dy / UNIT_PX }));
        }
        props.onMove(positions, `drag-${Date.now()}`);
        props.onMoveEnd();
        return;
      }
      case 'cable':
        setDraft(undefined);
        setHovered(undefined);
        if (!current.moved || cancelled) return;
        suppressClicksUntil.current = performance.now() + 250;
        dropCable(current.from, event.clientX, event.clientY);
    }
  };

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (closestData(event.target, 'data-stage-overlay')) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      setAnimate(false);
      setCamera((now) => zoomAt(now, live.current.viewport, point, Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015))));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  /* ---------- Keyboard ---------- */

  const step = (change: (camera: Camera) => Camera) => {
    setAnimate(true);
    setCamera((now) => clampCamera(change(now)));
  };
  const zoomBy = (factor: number) => {
    setAnimate(true);
    setCamera((now) => zoomAt(now, viewport, { x: viewport.width / 2, y: viewport.height / 2 }, factor));
  };
  const isTop = camera.tilt < 1 && Math.abs(camera.yaw) < 1;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTextField(event.target) || event.altKey || event.metaKey || event.ctrlKey) return;
    if (closestData(event.target, 'data-stage-overlay')) return;
    const ids = selection.kind === 'nodes' ? selection.ids : [];
    switch (event.key) {
      case 'Escape':
        if (pending) props.onPending(undefined);
        else props.onSelect({ kind: 'none' });
        return;
      case 'Delete':
      case 'Backspace':
        if (readOnly || selection.kind === 'none') return;
        event.preventDefault();
        props.onDelete();
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        if (readOnly || ids.length === 0) return;
        event.preventDefault();
        const amount = event.shiftKey ? 1 : NUDGE_UNITS;
        const dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0;
        const dz = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0;
        const positions = new Map<string, Position3D>();
        for (const id of ids) {
          const board = byId.get(id);
          if (board) {
            const position = positionOf(board.node);
            positions.set(id, snapPosition({ x: position.x + dx, y: position.y, z: position.z + dz }));
          }
        }
        props.onMove(positions, `nudge-${ids.join(',')}`);
        return;
      }
      case '+':
      case '=':
        return zoomBy(1.2);
      case '-':
        return zoomBy(1 / 1.2);
      case 'f':
      case 'F':
        return fit(true);
    }
  };

  const onFocusBoard = useCallback((nodeId: string) => {
    const { props: current, camera: view, viewport: size } = live.current;
    if (current.selection.kind !== 'nodes' || !current.selection.ids.includes(nodeId)) current.onSelect({ kind: 'nodes', ids: [nodeId] });
    const board = current.boards.find((candidate) => candidate.node.id === nodeId);
    if (!board || size.width === 0) return;
    const position = positionOf(board.node);
    const centre = project(view, size, { x: position.x * UNIT_PX, y: position.z * UNIT_PX, z: CABLE_Z });
    const margin = 80;
    if (centre.x < margin || centre.y < margin || centre.x > size.width - margin || centre.y > size.height - margin) {
      setAnimate(true);
      setCamera((now) => ({ ...now, target: { x: position.x * UNIT_PX, y: position.z * UNIT_PX } }));
    }
  }, []);

  const onSelectByKey = useCallback((nodeId: string) => live.current.props.onSelect({ kind: 'nodes', ids: [nodeId] }), []);
  const onOpenLoop = useCallback((nodeId: string) => live.current.props.onOpenLoop(nodeId), []);
  const onReview = useCallback((nodeId: string) => live.current.props.onReview(nodeId), []);

  /* ---------- Dropping modules from the palette ---------- */

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (readOnly || !event.dataTransfer.types.includes(NODE_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const type = event.dataTransfer.getData(NODE_DRAG_TYPE);
    if (readOnly || !type) return;
    event.preventDefault();
    const floor = unproject(camera, viewport, screenOf(event));
    props.onAddAt(type, { x: floor.x / UNIT_PX, y: 0, z: floor.y / UNIT_PX });
  };

  const pendingBoard = pending ? byId.get(pending.nodeId) : undefined;
  const pendingJack = pending ? findJack(pendingBoard, 'out', pending.port) : undefined;
  const ordered = useMemo(() => [...boards].sort((a, b) => positionOf(a.node).x - positionOf(b.node).x || positionOf(a.node).z - positionOf(b.node).z), [boards]);

  return (
    <div
      ref={viewportRef}
      className="stage"
      data-gesture={drag ? 'moving' : draft ? 'cabling' : undefined}
      data-seeking={pending?.kind}
      style={{ perspective: `${PERSPECTIVE_PX}px` }}
      role="application"
      aria-roledescription="3D workflow stage"
      aria-label="Workflow stage. Tab moves between steps, arrow keys move the selected step, Delete removes it."
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finishGesture(event, false)}
      onPointerCancel={(event) => finishGesture(event, true)}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="stage-world" data-animate={animate || undefined} style={{ transform: viewport.width > 0 ? cameraTransform(camera, viewport) : undefined }}>
        <div className="stage-floor" data-far={camera.zoom < FAR_ZOOM || undefined} style={{ width: FLOOR_SIZE, height: FLOOR_SIZE, transform: `translate3d(${-FLOOR_SIZE / 2}px, ${-FLOOR_SIZE / 2}px, 0)` }} />
        {ordered.map((board) => {
          const corner = boardCorner(positionOf(board.node), board.layout);
          const { dx, dy, lift } = offsetOf(board.node.id);
          return (
            <div
              key={`shadow-${board.node.id}`}
              className="board-shadow"
              data-lifted={lift > 0 || undefined}
              style={{ width: board.layout.width, height: board.layout.height, transform: `translate3d(${corner.x + dx + lift * 0.35}px, ${corner.y + dy + lift * 0.5}px, 1px)` }}
            />
          );
        })}
        {ordered.map((board) => {
          const corner = boardCorner(positionOf(board.node), board.layout);
          const { dx, dy, lift } = offsetOf(board.node.id);
          const id = board.node.id;
          return (
            <Board
              key={id}
              node={board.node}
              layout={board.layout}
              x={corner.x + dx}
              y={corner.y + dy}
              lift={lift + positionOf(board.node).y * UNIT_PX}
              title={board.title}
              summary={board.summary}
              appTitle={board.appTitle}
              icon={board.icon}
              color={board.color}
              missing={board.missing}
              selected={selection.kind === 'nodes' && selection.ids.includes(id)}
              run={props.runViews.get(id)}
              issue={props.issues.get(id)}
              connected={connectedByNode.get(id) ?? ''}
              seeking={draft?.from.kind ?? pending?.kind}
              seekingFrom={draft?.from.nodeId ?? pending?.nodeId}
              hoveredJack={hovered?.nodeId === id ? hovered.jack : undefined}
              bodySteps={board.bodySteps}
              readOnly={readOnly}
              onJack={handleJack}
              onSelectByKey={onSelectByKey}
              onFocusBoard={onFocusBoard}
              onOpenLoop={onOpenLoop}
              onReview={onReview}
            />
          );
        })}
        <CableLayer cables={cables} draft={draftCable} z={CABLE_Z} />
      </div>

      <div className="stage-vignette" aria-hidden="true" />
      <div className="stage-overlay stage-overlay-top" data-stage-overlay>
        {props.overlay}
      </div>
      {pending && pendingBoard ? (
        <div className="stage-banner" data-stage-overlay role="status">
          <span>
            Choose where <strong>{pendingBoard.title}</strong> {pendingJack?.label ?? pending.port} goes: {pending.kind === 'flow' ? 'an In jack' : 'an input'} on another step.
          </span>
          <button type="button" className="btn btn-small" onClick={() => props.onPending(undefined)}>
            Cancel
          </button>
        </div>
      ) : null}
      {boards.length === 0 ? <div className="stage-empty">{props.emptyHint}</div> : null}

      <div className="stage-controls" data-stage-overlay role="toolbar" aria-label="Camera">
        <div className="segmented" role="group" aria-label="View">
          <button type="button" aria-pressed={!isTop} onClick={() => step((now) => ({ ...now, ...PERSPECTIVE_VIEW }))}>
            <Icon name="cube" size={16} />
            3D
          </button>
          <button type="button" aria-pressed={isTop} onClick={() => step((now) => ({ ...now, yaw: 0, tilt: 0 }))}>
            <Icon name="square" size={16} />
            Top
          </button>
        </div>
        <button type="button" className="icon-button" title="Turn left" aria-label="Turn left" onClick={() => step((now) => ({ ...now, yaw: now.yaw - 15 }))}>
          <Icon name="rotate-left" />
        </button>
        <button type="button" className="icon-button" title="Turn right" aria-label="Turn right" onClick={() => step((now) => ({ ...now, yaw: now.yaw + 15 }))}>
          <Icon name="rotate-right" />
        </button>
        <button type="button" className="icon-button" title="Tilt towards you" aria-label="Tilt towards you" onClick={() => step((now) => ({ ...now, tilt: now.tilt + 10 }))}>
          <Icon name="tilt-down" />
        </button>
        <button type="button" className="icon-button" title="Tilt away" aria-label="Tilt away" onClick={() => step((now) => ({ ...now, tilt: now.tilt - 10 }))}>
          <Icon name="tilt-up" />
        </button>
        <button type="button" className="icon-button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
          <Icon name="minus" />
        </button>
        <span className="zoom-readout" aria-live="polite">
          {Math.round(camera.zoom * 100)}%
        </span>
        <button type="button" className="icon-button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
          <Icon name="plus" />
        </button>
        <button type="button" className="icon-button" title="Show all steps (F)" aria-label="Show all steps" onClick={() => fit(true)}>
          <Icon name="fit" />
        </button>
      </div>

      <details className="stage-help" data-stage-overlay>
        <summary>Controls</summary>
        <dl>
          <dt>Drag the floor</dt>
          <dd>Move around</dd>
          <dt>Right-drag, or Alt and drag</dt>
          <dd>Turn and tilt</dd>
          <dt>Scroll or pinch</dt>
          <dd>Zoom</dd>
          <dt>Drag from an output jack</dt>
          <dd>Patch a cable</dd>
          <dt>Tab, arrow keys, Delete</dt>
          <dd>Choose, move or remove a step</dd>
          <dt>Enter on a jack</dt>
          <dd>Patch with the keyboard</dd>
        </dl>
      </details>
    </div>
  );
};
