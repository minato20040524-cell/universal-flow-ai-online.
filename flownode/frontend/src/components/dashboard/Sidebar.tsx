import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useApp, type View } from '../../store';
import { Icon } from '../Icon';
import { Logo } from './Header';

const NAV: { id: View; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'nodes', label: 'Node Editor', icon: 'nodes' },
  { id: 'collab', label: 'Collaboration', icon: 'collab' },
  { id: 'agents', label: 'Agent Manager', icon: 'agents' },
  { id: 'skills', label: 'Skill Manager', icon: 'skills' },
  { id: 'builders', label: 'Builders', icon: 'builders' },
  { id: 'files', label: 'Project Files', icon: 'files' },
  { id: 'approvals', label: 'Approval Center', icon: 'approvals' },
  { id: 'analytics', label: 'Analytics', icon: 'analytics' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export function Sidebar() {
  const { s, view, setView, setStartOpen, act } = useApp();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = () => setOpen((o) => !o);
    document.addEventListener('flownode:menu', h);
    return () => document.removeEventListener('flownode:menu', h);
  }, []);
  if (!s) return null;
  const status = s.run?.status ?? 'idle';
  const pending = s.approvals.filter((a) => a.status === 'pending').length;

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[220px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-line bg-panel2 p-3 transition-transform lg:static lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center justify-between lg:hidden">
          <Logo />
          <button onClick={() => setOpen(false)} className="p-1 text-slate-400" aria-label="Tutup"><Icon name="close" /></button>
        </div>
        <nav className="space-y-0.5">
          {NAV.map((n) => (
            <button key={n.id} onClick={() => { setView(n.id); setOpen(false); }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm ${view === n.id ? 'bg-c1/25 text-white' : 'text-slate-300 hover:bg-white/5'}`}>
              <Icon name={n.icon} size={17} />
              <span className="flex-1">{n.label}</span>
              {n.id === 'approvals' && pending > 0 && <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-bold">{pending}</span>}
            </button>
          ))}
        </nav>

        <div>
          <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Agents Status</div>
          <div className="space-y-1">
            {s.agents.map((a) => (
              <div key={a.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: a.color, opacity: a.status === 'idle' ? 0.4 : 1 }} />
                <div className="flex-1 leading-tight">
                  <div className="text-slate-200">{a.name[0] + a.name.slice(1).toLowerCase()}</div>
                  <div className="text-[10px] text-slate-500">{a.role[0] + a.role.slice(1).toLowerCase()}</div>
                </div>
                <span className={`text-[10px] ${a.status === 'idle' ? 'text-slate-500' : a.status === 'error' ? 'text-red-300' : 'text-c3'}`}>{a.status === 'idle' ? 'Idle' : a.status === 'working' ? 'Working' : a.status === 'waiting' ? 'Waiting' : 'Error'}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-auto space-y-2">
          <div className="px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Quick Actions</div>
          <button disabled={s.busy} onClick={() => { setStartOpen(true); setOpen(false); }}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-c1 py-2 text-sm font-semibold text-white hover:brightness-110">
            <Icon name="play" size={14} /> Start Project
          </button>
          {status === 'paused' ? (
            <button className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-panel py-2 text-sm hover:border-c3/60" onClick={() => act(() => api.post('/api/run/resume'))}>
              <Icon name="play" size={14} /> Resume
            </button>
          ) : (
            <button disabled={status !== 'running'} className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-panel py-2 text-sm hover:border-warn/60" onClick={() => act(() => api.post('/api/run/pause'))}>
              <Icon name="pause" size={14} /> Pause All
            </button>
          )}
          <button disabled={!s.busy && status !== 'failed'} className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-400/40 bg-panel py-2 text-sm text-red-300 hover:bg-red-500/10" onClick={() => act(() => api.post('/api/run/stop'))}>
            <Icon name="stop" size={14} /> Stop All
          </button>
          {status === 'failed' && (
            <button className="flex w-full items-center justify-center gap-2 rounded-lg border border-warn/60 bg-warn/10 py-2 text-sm text-warn" onClick={() => act(() => api.post('/api/run/retry'), 'Mengulang langkah gagal')}>
              <Icon name="retry" size={14} /> Retry Failed
            </button>
          )}
        </div>
        <div className="text-[10px] text-slate-600">FLOWNODE v1.0.0</div>
      </aside>
    </>
  );
}
