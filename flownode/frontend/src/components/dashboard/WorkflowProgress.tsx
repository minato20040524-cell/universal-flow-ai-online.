import { useApp } from '../../store';
import { STAGES, type Stage } from '../../types';
import { Icon } from '../Icon';

/** Status tahap diturunkan dari langkah workflow yang benar-benar berjalan. */
export function WorkflowProgress() {
  const { s } = useApp();
  if (!s) return null;
  const run = s.run;
  const state = (stage: Stage): 'done' | 'active' | 'failed' | 'pending' => {
    if (!run) return 'pending';
    const steps = run.steps.filter((x) => x.stage === stage);
    if (run.status === 'completed') return 'done';
    if (steps.some((x) => x.status === 'failed')) return 'failed';
    if (steps.length && steps.every((x) => x.status === 'done')) return 'done';
    if (run.stage === stage && (run.status === 'running' || run.status === 'paused' || run.status === 'waiting_approval')) return 'active';
    return 'pending';
  };
  return (
    <div className="flex items-start gap-1 overflow-x-auto px-3 py-3 sm:px-5">
      {STAGES.map((st, i) => {
        const v = state(st.id);
        const color = v === 'done' ? '#10B981' : v === 'active' ? '#22D3EE' : v === 'failed' ? '#f87171' : '#475569';
        return (
          <div key={st.id} className="flex min-w-[120px] flex-1 items-center gap-2">
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold ${v === 'active' ? 'pulse-ring' : ''}`}
              style={{ borderColor: color, color, background: `${color}14`, ['--glow' as string]: `${color}77` }}>
              {v === 'done' ? <Icon name="check" size={16} /> : i + 1}
            </span>
            <div className="leading-tight">
              <div className="text-sm font-semibold" style={{ color: v === 'pending' ? '#94a3b8' : '#fff' }}>{st.title}</div>
              <div className="text-[11px] text-slate-500">{st.sub}</div>
            </div>
            {i < STAGES.length - 1 && <div className="mx-1 hidden h-px min-w-[16px] flex-1 sm:block" style={{ background: v === 'done' ? '#10B98188' : '#263449' }} />}
          </div>
        );
      })}
    </div>
  );
}
