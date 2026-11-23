import { Handle, Position, type NodeProps } from 'reactflow';
import { useApp } from '../../store';
import { BUILDERS, BUILDER_COLOR as COLOR, LANE_COLOR } from '../../types';
import { Icon } from '../Icon';
import { ArtifactView } from '../files/ArtifactView';

const ICON: Record<string, string> = {
  'builder-doc': 'document', 'builder-image': 'image', 'builder-video': 'video',
  'builder-3d': 'model3d', 'builder-code': 'code', 'builder-audio': 'audio',
};

export function BuilderNode({ data, id }: NodeProps<{ id: string }>) {
  const { s, setExpanded, act } = useApp();
  const def = BUILDERS.find((b) => b.id === data.id);
  if (!s || !def) return null;
  const files = s.artifacts.filter((a) => (def.kinds as readonly string[]).includes(a.kind) && (!s.run || a.runId === s.run.id));
  const receiving = s.transfers.some((t) => t.status === 'moving' && t.to === def.id);
  const last = files[files.length - 1];
  const color = COLOR[def.id]!;
  const status = receiving ? 'Menerima…' : files.length ? 'Selesai' : 'Kosong';
  const lane = last ? LANE_COLOR[last.lane] : color;

  return (
    <div className="w-[270px] rounded-2xl bg-panel p-2.5" style={{ border: `1.5px solid ${receiving ? lane : color + '88'}`, boxShadow: receiving ? `0 0 22px ${lane}66` : `0 0 10px ${color}1f` }}>
      <div className="mb-1.5 flex items-center gap-2">
        <span style={{ color }}><Icon name={ICON[def.id]!} size={16} /></span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">{def.name}</span>
        <button className="nodrag rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white" title="Buka workspace" onClick={() => setExpanded(def.id)}><Icon name="expand" size={14} /></button>
        <button className="nodrag rounded p-1 text-slate-500 hover:bg-red-500/20 hover:text-red-300" title="Hapus node (kabel ikut terputus)"
          onClick={() => act(async () => { await deleteNode(s.project.id, s.project.graph, id); })}><Icon name="close" size={14} /></button>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-[54px] w-[88px] shrink-0 overflow-hidden rounded-lg border border-line bg-[#0a1020] p-1">
          {last ? <ArtifactView artifact={last} compact /> : <div className="grid h-full place-items-center text-[9px] text-slate-600">KOSONG</div>}
        </div>
        <div className="min-w-0 flex-1 text-xs">
          <div className={`inline-block rounded-md border px-2 py-0.5 font-semibold ${receiving ? 'border-fin/60 text-fin' : files.length ? 'border-c3/60 text-c3' : 'border-line text-slate-500'}`}>{status}</div>
          <div className="mt-1 text-[10px] text-slate-400">{files.length} berkas</div>
        </div>
      </div>
      <Handle type="target" position={Position.Left} id="in" style={{ background: color }} />
      <Handle type="source" position={Position.Right} id="out" style={{ background: '#0B1120', borderColor: color }} />
    </div>
  );
}

import { api } from '../../api';
import type { Graph } from '../../types';

async function deleteNode(projectId: string, graph: Graph, nodeId: string): Promise<void> {
  const positions = { ...graph.positions };
  delete positions[nodeId];
  const edges = graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
  await api.put(`/api/projects/${projectId}/graph`, { positions, edges });
}
