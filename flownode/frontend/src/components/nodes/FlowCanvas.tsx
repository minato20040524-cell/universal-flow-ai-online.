import { useCallback, useEffect, useMemo } from 'react';
import ReactFlow, {
  Background, BackgroundVariant, Controls, MiniMap, addEdge, useEdgesState, useNodesState,
  type Connection, type Edge, type Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { api } from '../../api';
import { useApp } from '../../store';
import { NODE_LABEL, type Graph } from '../../types';
import { Icon } from '../Icon';
import { AgentNode } from './AgentNode';
import { BuilderNode } from './BuilderNode';
import { CableEdge } from './CableEdge';
import { HubNode } from './HubNode';
import { OutputNode } from './OutputNode';

const nodeTypes = { agent: AgentNode, hub: HubNode, builder: BuilderNode, finalout: OutputNode };
const edgeTypes = { cable: CableEdge };

const DEFAULTS: Record<string, { x: number; y: number }> = {
  'claude-01': { x: 0, y: 0 }, 'claude-02': { x: 0, y: 290 }, 'claude-03': { x: 0, y: 580 }, hub: { x: 560, y: 230 },
  'builder-doc': { x: 1060, y: 0 }, 'builder-image': { x: 1060, y: 130 }, 'builder-video': { x: 1060, y: 260 },
  'builder-3d': { x: 1060, y: 390 }, 'builder-code': { x: 1060, y: 520 }, 'builder-audio': { x: 1060, y: 650 },
  output: { x: 1060, y: 780 },
};
const typeOf = (id: string): string =>
  id.startsWith('claude') ? 'agent' : id === 'hub' ? 'hub' : id === 'output' ? 'finalout' : 'builder';

const toNodes = (g: Graph): Node[] =>
  Object.entries(g.positions).map(([id, position]) => ({ id, type: typeOf(id), position, data: { id } }));
const toEdges = (g: Graph): Edge[] =>
  g.edges.map((e) => ({ ...e, type: 'cable', selectable: true, deletable: true }));

export function FlowCanvas({ full = false }: { full?: boolean }) {
  const { s, act } = useApp();
  const graph = s?.project.graph;
  const projectId = s?.project.id;
  const sig = useMemo(() => JSON.stringify(graph), [graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<{ id: string }>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  useEffect(() => {
    if (!graph) return;
    setNodes(toNodes(graph));
    setEdges(toEdges(graph));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, projectId]);

  const persist = useCallback(
    (ns: Node[], es: Edge[]) => {
      if (!projectId) return;
      const positions = Object.fromEntries(ns.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]));
      const edgesOut = es.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? 'out', target: e.target, targetHandle: e.targetHandle ?? 'in' }));
      void act(() => api.put(`/api/projects/${projectId}/graph`, { positions, edges: edgesOut }));
    },
    [projectId, act],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const id = `e-${c.source}-${c.sourceHandle}-${c.target}-${c.targetHandle}`;
      if (edges.some((e) => e.id === id)) return;
      const next = addEdge({ ...c, id, type: 'cable' }, edges);
      setEdges(next);
      persist(nodes, next);
    },
    [edges, nodes, persist, setEdges],
  );

  const missing = Object.keys(DEFAULTS).filter((id) => !nodes.some((n) => n.id === id));
  const addNode = (id: string) => {
    const ns = [...nodes, { id, type: typeOf(id), position: DEFAULTS[id]!, data: { id } } as Node];
    setNodes(ns);
    persist(ns, edges);
  };

  if (!graph) return null;
  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={(_e, _n, ns) => persist(ns.length ? (nodes.map((n) => ns.find((x) => x.id === n.id) ?? n)) : nodes, edges)}
        onEdgesDelete={(del) => persist(nodes, edges.filter((e) => !del.some((d) => d.id === e.id)))}
        onNodesDelete={(del) =>
          persist(nodes.filter((n) => !del.some((d) => d.id === n.id)), edges.filter((e) => !del.some((d) => d.id === e.source || d.id === e.target)))
        }
        fitView
        fitViewOptions={{ padding: 0.08 }}
        minZoom={0.15}
        maxZoom={1.6}
        deleteKeyCode={['Backspace', 'Delete']}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1.2} color="#1f2c44" />
        <Controls showInteractive={false} />
        {full && <MiniMap position="bottom-left" style={{ marginLeft: 56 }} pannable zoomable nodeColor={() => '#22D3EE'} maskColor="rgba(11,17,32,.7)" className="!hidden sm:!block" />}
      </ReactFlow>

      {missing.length > 0 && (
        <div className="absolute left-2 top-2 z-10 flex max-w-[70%] flex-wrap items-center gap-1 rounded-xl border border-line bg-panel/90 p-1.5 text-[11px]">
          <span className="px-1 text-slate-400">Node dihapus:</span>
          {missing.map((id) => (
            <button key={id} onClick={() => addNode(id)} className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-slate-200 hover:border-fin/60">
              <Icon name="plus" size={11} /> {NODE_LABEL[id] ?? id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
