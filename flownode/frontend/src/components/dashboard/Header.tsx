import { api } from '../../api';
import { useApp } from '../../store';
import { Icon } from '../Icon';

export const Logo = () => (
  <div className="flex items-center gap-2">
    <svg width="38" height="38" viewBox="0 0 64 64" aria-hidden>
      <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#22D3EE" /><stop offset="1" stopColor="#2196F3" /></linearGradient></defs>
      <path d="M32 3l25 14.5v29L32 61 7 46.5v-29z" fill="#0f1b33" stroke="url(#lg)" strokeWidth="3" />
      <path d="M17 42V22l10 12 8-12 12 20" fill="none" stroke="url(#lg)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    <div className="leading-tight">
      <div className="text-lg font-extrabold tracking-wide text-white">FLOWNODE</div>
      <div className="hidden text-[11px] text-slate-400 sm:block">AI Collaboration Studio</div>
    </div>
  </div>
);

const STATUS: Record<string, { text: string; sub: string; color: string }> = {
  idle: { text: 'Ready for Command', sub: 'Menunggu perintah Anda…', color: '#10B981' },
  running: { text: 'Working', sub: 'Workflow berjalan', color: '#2196F3' },
  paused: { text: 'Paused', sub: 'Dijeda oleh pengguna', color: '#F59E0B' },
  waiting_approval: { text: 'Waiting Approval', sub: 'Butuh keputusan Anda', color: '#22D3EE' },
  completed: { text: 'Ready for Command', sub: 'Workflow selesai — IDLE', color: '#10B981' },
  failed: { text: 'Failed', sub: 'Ada langkah yang gagal', color: '#f87171' },
  stopped: { text: 'Ready for Command', sub: 'Workflow dihentikan — IDLE', color: '#10B981' },
};

export function Header() {
  const { s, connected, setView, setLoadOpen, act, toast, setView: nav } = useApp();
  if (!s) return null;
  const st = STATUS[s.run?.status ?? 'idle']!;
  const pending = s.approvals.filter((a) => a.status === 'pending').length;

  const rename = () => {
    const name = window.prompt('Nama proyek:', s.project.name)?.trim();
    if (name) void act(() => api.patch(`/api/projects/${s.project.id}`, { name }), 'Nama proyek diganti');
  };
  const save = () => {
    const g = s.project.graph;
    void act(() => api.put(`/api/projects/${s.project.id}/graph`, g), 'Proyek disimpan');
  };

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-panel/80 px-3 py-2 sm:px-4">
      <button className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 lg:hidden" aria-label="Menu" onClick={() => document.dispatchEvent(new CustomEvent('flownode:menu'))}>
        <Icon name="menu" size={22} />
      </button>
      <Logo />
      <div className="flex min-w-0 items-center gap-2 rounded-xl border border-line bg-panel2 px-3 py-1.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-fin/10 text-fin"><Icon name="nodes" size={17} /></span>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-semibold text-white">Project: {s.project.name}</div>
          <div className="truncate text-[11px] text-slate-400">{s.run ? s.run.instruction : 'Belum ada instruksi'}</div>
        </div>
        <button onClick={rename} title="Ganti nama proyek" className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"><Icon name="edit" size={15} /></button>
      </div>

      <div className="flex items-center gap-3 rounded-2xl border px-4 py-1.5" style={{ borderColor: `${st.color}88`, background: `${st.color}12` }}>
        <span className={`h-3.5 w-3.5 rounded-full ${s.busy ? 'pulse-ring' : ''}`} style={{ background: st.color, ['--glow' as string]: `${st.color}88` }} />
        <div className="leading-tight">
          <div className="text-sm font-semibold text-white">{st.text}</div>
          <div className="text-[11px] text-slate-300">{st.sub}</div>
        </div>
      </div>
      <span className="hidden rounded-full border border-line px-2.5 py-1 text-[11px] text-slate-300 md:inline" title="Agen tidak bekerja dan tidak memakai sesi Claude tanpa perintah">On-Demand Mode</span>

      <div className="ml-auto flex items-center gap-1.5">
        <span className={`hidden text-[10px] sm:inline ${connected ? 'text-c3' : 'text-warn'}`}>{connected ? '● realtime' : '● terputus'}</span>
        <button className="flex items-center gap-1.5 rounded-lg border border-line bg-panel2 px-3 py-1.5 text-xs hover:border-fin/60" onClick={save}><Icon name="save" size={15} /><span className="hidden sm:inline">Save</span></button>
        <button className="flex items-center gap-1.5 rounded-lg border border-line bg-panel2 px-3 py-1.5 text-xs hover:border-fin/60" onClick={() => setLoadOpen(true)}><Icon name="load" size={15} /><span className="hidden sm:inline">Load</span></button>
        <button className="flex items-center gap-1.5 rounded-lg border border-line bg-panel2 px-3 py-1.5 text-xs hover:border-fin/60"
          onClick={() => { window.location.href = `/api/projects/${s.project.id}/export`; toast('Mengekspor proyek…'); }}><Icon name="export" size={15} /><span className="hidden sm:inline">Export</span></button>
        <button className="flex items-center gap-1.5 rounded-lg border border-line bg-panel2 px-3 py-1.5 text-xs hover:border-fin/60" onClick={() => setView('settings')}><Icon name="settings" size={15} /><span className="hidden md:inline">Settings</span></button>
        <button className="relative rounded-lg border border-line bg-panel2 p-1.5 hover:border-fin/60" aria-label="Persetujuan" onClick={() => nav('approvals')}>
          <Icon name="bell" size={17} />
          {pending > 0 && <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">{pending}</span>}
        </button>
      </div>
    </header>
  );
}
