import { Handle, Position } from 'reactflow';
import { useApp } from '../../store';
import { Icon } from '../Icon';
import { ArtifactView } from '../files/ArtifactView';

export function OutputNode() {
  const { s, setView } = useApp();
  if (!s) return null;
  const run = s.run;
  const delivered = new Set(s.transfers.filter((t) => t.to === 'output' && t.status === 'done').map((t) => t.artifactId));
  const received = s.artifacts.filter((a) => delivered.has(a.id) && (!run || a.runId === run.id));
  const receiving = s.transfers.some((t) => t.status === 'moving' && t.to === 'output');
  const waiting = s.approvals.some((a) => a.status === 'pending' && a.kind === 'final_review');
  const cover = received.find((a) => a.kind === 'image');
  const done = run?.status === 'completed';
  const label = done ? 'Selesai' : receiving ? 'Menerima…' : waiting ? 'Siap review' : received.length ? 'Terkumpul' : 'Kosong';

  return (
    <div className="w-[270px] rounded-2xl bg-panel p-2.5" style={{ border: '1.5px solid #22D3EE', boxShadow: done || receiving ? '0 0 26px #22D3EE66' : '0 0 12px #22D3EE22' }}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-fin"><Icon name="zap" size={16} /></span>
        <span className="flex-1 text-sm font-semibold text-white">Final Output</span>
        <button className="nodrag rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white" onClick={() => setView('files')} title="Buka Project Files"><Icon name="expand" size={14} /></button>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-[54px] w-[88px] shrink-0 overflow-hidden rounded-lg border border-line bg-[#0a1020] p-1">
          {cover ? <ArtifactView artifact={cover} compact /> : <div className="grid h-full place-items-center text-[9px] text-slate-600">KOSONG</div>}
        </div>
        <div className="text-xs">
          <div className={`inline-block rounded-md border px-2 py-0.5 font-semibold ${done ? 'border-fin/70 text-fin' : 'border-line text-slate-400'}`}>{label}</div>
          <div className="mt-1 text-[10px] text-slate-400">{received.length} berkas</div>
        </div>
      </div>
      <Handle type="target" position={Position.Right} id="in-r" style={{ background: '#22D3EE' }} />
    </div>
  );
}
