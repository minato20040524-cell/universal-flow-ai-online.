import { bytes, clock, hhmmss, useNow } from '../../lib/hooks';
import { useApp } from '../../store';
import { AGENT_COLOR, LANE_COLOR, NODE_LABEL } from '../../types';
import { Icon } from '../Icon';

const DOT: Record<string, string> = { info: '#2196F3', ok: '#10B981', warn: '#F59E0B', error: '#f87171' };

export function ActivityLog({ limit = 6 }: { limit?: number }) {
  const { s, connected } = useApp();
  if (!s) return null;
  return (
    <section className="panel flex min-h-0 flex-col p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white">
        <span className="text-c3"><Icon name="check" size={16} /></span> Activity Log
        <span className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] ${connected ? 'border-c3/50 text-c3' : 'border-warn/50 text-warn'}`}>{connected ? '● Live' : 'Offline'}</span>
      </div>
      <div className="scroll-thin max-h-[170px] space-y-1.5 overflow-y-auto pr-1 text-xs">
        {s.activity.length === 0 && <div className="py-4 text-center text-slate-500">Belum ada aktivitas.</div>}
        {s.activity.slice(0, limit * 6).map((e) => (
          <div key={e.id} className="flex items-start gap-2">
            <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: DOT[e.status] }} />
            <span className="w-[58px] shrink-0 font-mono text-slate-500">{hhmmss(e.ts)}</span>
            <span className="min-w-0 flex-1 text-slate-300">
              <b style={{ color: AGENT_COLOR[e.agent] ?? '#94a3b8' }}>{NODE_LABEL[e.agent] ?? e.agent}</b>: {e.activity}{e.file ? ` · ${e.file}` : ''}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function TransferMonitor() {
  const { s } = useApp();
  const moving = s?.transfers.some((t) => t.status === 'moving') ?? false;
  const now = useNow(moving, 120);
  if (!s) return null;
  const list = s.transfers.slice(0, 4);
  const t = list.find((x) => x.status === 'moving') ?? list[0];
  const pct = !t ? 0 : t.status === 'done' ? 100 : t.status === 'failed' ? 0 : Math.min(99, Math.round(((now - t.startedAt) / Math.max(1, t.durationMs)) * 100));
  return (
    <section className="panel flex min-h-0 flex-col p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white"><span className="text-c1"><Icon name="export" size={16} /></span> Transfer Monitor</div>
      {!t ? (
        <div className="grid flex-1 place-items-center py-6 text-xs text-slate-500">Belum ada transfer file.</div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border" style={{ borderColor: LANE_COLOR[t.lane], color: LANE_COLOR[t.lane] }}><Icon name={t.kind} size={20} /></span>
            <div className="min-w-0 flex-1 text-xs">
              <div className="truncate font-semibold text-white">{t.artifactName} <span className="font-normal text-slate-400">({bytes(t.size)})</span></div>
              <div className="text-slate-400">{NODE_LABEL[t.from] ?? t.from} → {NODE_LABEL[t.to] ?? t.to}</div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-800">
                <div className="h-full rounded-full transition-[width] duration-150" style={{ width: `${pct}%`, background: t.status === 'failed' ? '#f87171' : LANE_COLOR[t.lane] }} />
              </div>
            </div>
            <div className="text-center text-xs">
              <div className="font-semibold text-white">{pct}%</div>
              <div className={t.status === 'done' ? 'text-c3' : t.status === 'failed' ? 'text-red-300' : 'text-fin'}>{t.status === 'done' ? '✓ Success' : t.status === 'failed' ? 'Gagal' : 'Moving'}</div>
            </div>
          </div>
          <div className="space-y-1 border-t border-line pt-2 text-[11px] text-slate-400">
            {list.slice(0, 3).map((x) => (
              <div key={x.id} className="flex gap-2"><span className={x.status === 'done' ? 'text-c3' : x.status === 'failed' ? 'text-red-300' : 'text-fin'}>●</span><span className="min-w-0 flex-1 truncate">{x.artifactName}</span><span>{NODE_LABEL[x.to] ?? x.to}</span></div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function ProjectStats() {
  const { s } = useApp();
  const running = !!s?.busy;
  const now = useNow(running);
  if (!s) return null;
  const { stats, run } = s;
  const duration = run ? (running ? now - run.startedAt : stats.durationMs) : 0;
  const pct = stats.tasksTotal ? Math.round((stats.tasksDone / stats.tasksTotal) * 100) : 0;
  const R = 44, C = 2 * Math.PI * R;
  const rows: [string, string, string][] = [
    ['agents', `${stats.activeAgents} Agents Active`, '#2196F3'],
    ['files', `${stats.files} Files Created`, '#F59E0B'],
    ['dataset', `${bytes(stats.totalBytes)} Total Size`, '#A855F7'],
    ['analytics', `${clock(duration)} Elapsed`, '#10B981'],
  ];
  return (
    <section className="panel flex min-h-0 flex-col p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white"><span className="text-warn"><Icon name="analytics" size={16} /></span> Project Stats</div>
      <div className="flex items-center gap-3">
        <div className="flex-1 space-y-2 text-xs text-slate-200">
          {rows.map(([icon, text, color]) => (
            <div key={text} className="flex items-center gap-2"><span style={{ color }}><Icon name={icon} size={15} /></span>{text}</div>
          ))}
        </div>
        <div className="relative h-[108px] w-[108px] shrink-0">
          <svg viewBox="0 0 108 108" className="h-full w-full -rotate-90">
            <circle cx="54" cy="54" r={R} fill="none" stroke="#1e293b" strokeWidth="9" />
            <circle cx="54" cy="54" r={R} fill="none" stroke="#10B981" strokeWidth="9" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} style={{ transition: 'stroke-dashoffset .4s' }} />
          </svg>
          <div className="absolute inset-0 grid place-items-center text-center leading-tight">
            <div><div className="text-lg font-bold text-white">{pct}%</div><div className="text-[10px] text-c3">{run?.status === 'completed' ? 'Project Complete' : run ? 'Progress' : 'Belum dimulai'}</div></div>
          </div>
        </div>
      </div>
    </section>
  );
}
