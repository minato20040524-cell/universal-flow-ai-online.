import { useState, type ReactNode } from 'react';
import { api } from '../../api';
import { bytes, clock, hhmmss } from '../../lib/hooks';
import { useApp } from '../../store';
import { AGENT_COLOR, BUILDERS, LANE_COLOR, NODE_LABEL, type AgentId } from '../../types';
import { ConnectorPill } from '../nodes/AgentNode';
import { HubPanel } from '../collaboration/HubPanel';
import { ActivityLog, ProjectStats, TransferMonitor } from '../dashboard/BottomPanels';
import { WorkflowProgress } from '../dashboard/WorkflowProgress';
import { ArtifactView, DemoTag, DownloadLink } from '../files/ArtifactView';
import { ProjectOutput } from '../files/ProjectOutput';
import { Icon } from '../Icon';
import { FlowCanvas } from '../nodes/FlowCanvas';

const Page = ({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) => (
  <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
    <div className="mb-3 flex items-center gap-2"><h1 className="m-0 text-lg font-semibold text-white">{title}</h1><div className="ml-auto">{actions}</div></div>
    {children}
  </div>
);

function RunBanner() {
  const { s, act } = useApp();
  const run = s?.run;
  if (!s || !run || !['failed', 'paused', 'waiting_approval'].includes(run.status)) return null;
  const tone = run.status === 'failed' ? 'border-red-400/50 bg-red-500/10 text-red-100' : run.status === 'paused' ? 'border-warn/50 bg-warn/10 text-amber-100' : 'border-fin/50 bg-fin/10 text-cyan-100';
  return (
    <div className={`mx-3 mb-3 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-2 text-sm ${tone}`}>
      <Icon name={run.status === 'failed' ? 'alert' : 'bell'} size={18} />
      <span className="min-w-0 flex-1">
        {run.status === 'failed' && <>Workflow gagal — {run.error}</>}
        {run.status === 'paused' && <>Workflow dijeda. Tekan Resume untuk melanjutkan.</>}
        {run.status === 'waiting_approval' && <>Menunggu keputusan Anda di Approval Center / tab Decision pada Collaboration Hub.</>}
      </span>
      {run.status === 'failed' && <button className="rounded-lg border border-warn/70 px-3 py-1 text-xs font-semibold text-warn" onClick={() => act(() => api.post('/api/run/retry'), 'Mengulang langkah gagal')}>Retry Failed</button>}
      {run.status === 'paused' && <button className="rounded-lg border border-c3/70 px-3 py-1 text-xs font-semibold text-c3" onClick={() => act(() => api.post('/api/run/resume'))}>Resume</button>}
    </div>
  );
}

export function DashboardView() {
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <WorkflowProgress />
      <RunBanner />
      <div className="grid gap-3 px-3 pb-3 xl:grid-cols-[1fr_330px]">
        <div className="panel grid-bg h-[560px] overflow-hidden sm:h-[680px]"><FlowCanvas /></div>
        <ProjectOutput />
      </div>
      <div className="grid gap-3 px-3 pb-4 md:grid-cols-3">
        <ActivityLog /><TransferMonitor /><ProjectStats />
      </div>
    </div>
  );
}

export const NodeEditorView = () => (
  <div className="flex min-h-0 flex-1 flex-col p-3">
    <div className="mb-2 text-xs text-slate-400">Geser node, tarik dari port untuk menyambung kabel, pilih kabel/node lalu tekan Delete untuk menghapus. Perubahan tersimpan otomatis dan langsung dipakai jalur transfer.</div>
    <div className="panel grid-bg min-h-[520px] flex-1 overflow-hidden"><FlowCanvas full /></div>
  </div>
);

export const CollabView = () => (
  <Page title="Collaboration Hub">
    <div className="panel flex h-[70vh] min-h-[420px] flex-col p-4"><HubPanel /></div>
  </Page>
);

export function ApprovalView() {
  const { s, act } = useApp();
  const [note, setNote] = useState('');
  if (!s) return null;
  const pending = s.approvals.filter((a) => a.status === 'pending');
  const done = s.approvals.filter((a) => a.status !== 'pending');
  return (
    <Page title="Approval Center">
      <div className="space-y-3">
        {pending.length === 0 && <div className="panel p-6 text-center text-sm text-slate-500">Tidak ada persetujuan tertunda. Persetujuan muncul saat workflow membutuhkan keputusan Anda.</div>}
        {pending.map((a) => (
          <div key={a.id} className="panel border-fin/50 p-4">
            <div className="flex items-center gap-2 font-semibold text-fin"><Icon name="approvals" size={18} />{a.title}</div>
            <p className="my-2 text-sm text-slate-300">{a.detail}</p>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Catatan untuk revisi (opsional)" className="mb-2 w-full rounded-lg border border-line bg-panel2 px-3 py-2 text-sm" />
            <div className="flex gap-2">
              <button className="rounded-lg bg-c3 px-4 py-2 text-sm font-semibold text-black" onClick={() => act(() => api.post(`/api/approvals/${a.id}`, { decision: 'approved', note }), 'Disetujui')}>Setujui</button>
              <button className="rounded-lg border border-warn/70 px-4 py-2 text-sm font-semibold text-warn" onClick={() => act(() => api.post(`/api/approvals/${a.id}`, { decision: 'rejected', note }), 'Ditolak')}>Tolak / Minta revisi</button>
            </div>
          </div>
        ))}
        {done.length > 0 && <h2 className="m-0 pt-2 text-sm font-semibold text-slate-400">Riwayat</h2>}
        {done.map((a) => (
          <div key={a.id} className="panel flex items-center gap-3 p-3 text-sm">
            <span className={a.status === 'approved' ? 'text-c3' : 'text-warn'}>{a.status === 'approved' ? 'Disetujui' : 'Ditolak'}</span>
            <span className="flex-1">{a.title}{a.note ? ` — ${a.note}` : ''}</span>
            <span className="text-xs text-slate-500">{hhmmss(a.decidedAt ?? a.createdAt)}</span>
          </div>
        ))}
      </div>
    </Page>
  );
}

export function AgentManagerView() {
  const { s, act } = useApp();
  if (!s) return null;
  return (
    <Page title="Agent Manager">
      <div className="mb-3 rounded-xl border border-line bg-panel p-3 text-xs text-slate-300">
        Setiap akun Claude dirancang memakai <b>profil browser terpisah</b>, login <b>manual</b> oleh Anda, dan dapat diambil alih kapan saja. Tidak memakai API key.
        Controller browser belum tersedia di versi ini (Tahap C/D), sehingga mode <b>Browser</b> melaporkan "Belum terhubung" dan menolak menjalankan tugas — FLOWNODE tidak pernah mengklaim terhubung bila belum.
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {s.agents.map((a) => (
          <div key={a.id} className="panel p-4" style={{ borderColor: `${a.color}77` }}>
            <div className="mb-2 flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: a.color }} /><b className="text-white">{a.name}</b><span className="text-xs text-slate-400">{a.role}</span><span className="ml-auto"><ConnectorPill agent={a} /></span></div>
            <div className="mb-2 text-xs text-slate-400">{a.connector.note}</div>
            <div className="mb-2 text-xs">Status: <b>{a.status === 'idle' ? 'IDLE' : a.status}</b>{a.task ? ` — ${a.task}` : ''}</div>
            <label className="mb-1 block text-xs text-slate-400">Connector</label>
            <select disabled={s.busy} value={a.connector.mode} onChange={(e) => act(() => api.put(`/api/agents/${a.id}/connector`, { mode: e.target.value }))} className="mb-2 w-full rounded-lg border border-line bg-panel2 px-2 py-1.5 text-sm">
              <option value="demo">Demo (template lokal)</option>
              <option value="browser">Browser (sesi Claude — belum tersedia)</option>
            </select>
            <div className="mb-2 text-[11px] text-slate-500">Profil sesi: <code>{a.connector.profileDir}</code></div>
            <label className="mb-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={a.connector.takeover} onChange={(e) => act(() => api.put(`/api/agents/${a.id}/takeover`, { on: e.target.checked }))} /> Manual takeover</label>
            <button disabled title="Tersedia setelah Browser Controller (Tahap C/D)" className="w-full rounded-lg border border-line py-1.5 text-xs">Login manual (Tahap C/D)</button>
            <div className="mt-2 flex flex-wrap gap-1">{a.skills.map((k) => <span key={k.id} className="rounded-full border border-line px-2 py-0.5 text-[10px] text-slate-300">{k.name}</span>)}</div>
          </div>
        ))}
      </div>
    </Page>
  );
}

export function SkillManagerView() {
  const { s, act } = useApp();
  const [f, setF] = useState({ name: '', description: '', agent: 'claude-01' as AgentId | 'all' });
  if (!s) return null;
  return (
    <Page title="Skill Manager">
      <div className="panel mb-4 grid gap-2 p-3 sm:grid-cols-[1fr_1.5fr_160px_auto]">
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Nama skill" className="rounded-lg border border-line bg-panel2 px-3 py-2 text-sm" />
        <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Deskripsi" className="rounded-lg border border-line bg-panel2 px-3 py-2 text-sm" />
        <select value={f.agent} onChange={(e) => setF({ ...f, agent: e.target.value as AgentId | 'all' })} className="rounded-lg border border-line bg-panel2 px-2 py-2 text-sm">
          {s.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}<option value="all">Semua agen</option>
        </select>
        <button disabled={!f.name.trim()} className="rounded-lg bg-c1 px-4 py-2 text-sm font-semibold" onClick={async () => { if (await act(() => api.post('/api/skills', f), 'Skill ditambahkan')) setF({ ...f, name: '', description: '' }); }}>Tambah</button>
      </div>
      <div className="space-y-2">
        {s.skills.map((k) => (
          <div key={k.id} className="panel flex flex-wrap items-center gap-3 p-3 text-sm">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: AGENT_COLOR[k.agent] ?? '#22D3EE' }} />
            <div className="min-w-0 flex-1"><b>{k.name}</b><div className="text-xs text-slate-400">{k.description}</div></div>
            <span className="text-xs text-slate-400">{k.agent === 'all' ? 'Semua agen' : NODE_LABEL[k.agent]}</span>
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={k.enabled} onChange={(e) => act(() => api.patch(`/api/skills/${k.id}`, { enabled: e.target.checked }))} /> aktif</label>
            <button className="rounded border border-red-400/40 p-1.5 text-red-300" aria-label="Hapus" onClick={() => act(() => api.del(`/api/skills/${k.id}`))}><Icon name="trash" size={14} /></button>
          </div>
        ))}
      </div>
    </Page>
  );
}

export function BuildersView() {
  const { s, setPreviewId } = useApp();
  if (!s) return null;
  return (
    <Page title="Builders">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {BUILDERS.map((b) => {
          const files = s.artifacts.filter((a) => (b.kinds as readonly string[]).includes(a.kind));
          return (
            <div key={b.id} className="panel p-3">
              <div className="mb-2 flex items-center gap-2 font-semibold text-white"><Icon name={b.kinds[0]!} size={16} />{b.name}<span className="ml-auto text-xs font-normal text-slate-400">{files.length} berkas</span></div>
              <div className="grid grid-cols-2 gap-2">
                {files.slice(-4).map((a) => (
                  <button key={a.id} onClick={() => setPreviewId(a.id)} className="rounded-lg border border-line p-1 text-left hover:border-fin/60">
                    <div className="mb-1 h-16 overflow-hidden rounded bg-black/30 p-1"><ArtifactView artifact={a} compact /></div>
                    <div className="truncate text-[10px]">{a.name}</div>
                  </button>
                ))}
                {!files.length && <div className="col-span-2 py-4 text-center text-xs text-slate-500">Kosong</div>}
              </div>
            </div>
          );
        })}
      </div>
    </Page>
  );
}

export function FilesView() {
  const { s, setPreviewId } = useApp();
  const [kind, setKind] = useState('all');
  if (!s) return null;
  const list = s.artifacts.filter((a) => kind === 'all' || a.kind === kind);
  const kinds = ['all', ...new Set(s.artifacts.map((a) => a.kind))];
  return (
    <Page title={`Project Files (${s.artifacts.length})`} actions={s.artifacts.length ? <a href={`/api/projects/${s.project.id}/bundle.zip`} download className="flex items-center gap-1.5 rounded-lg bg-c1 px-3 py-1.5 text-sm font-semibold"><Icon name="load" size={15} /> Unduh semua (.zip)</a> : null}>
      <div className="mb-3 flex flex-wrap gap-1.5">{kinds.map((k) => <button key={k} onClick={() => setKind(k)} className={`rounded-full border px-3 py-1 text-xs ${kind === k ? 'border-fin text-fin' : 'border-line text-slate-400'}`}>{k}</button>)}</div>
      <div className="panel divide-y divide-line">
        {list.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
            <Icon name={a.kind} size={16} />
            <button className="min-w-0 flex-1 truncate text-left hover:text-fin" onClick={() => setPreviewId(a.id)}>{a.name}</button>
            {a.demo && <DemoTag />}
            <span className="text-xs text-slate-400">{NODE_LABEL[a.producer] ?? a.producer}</span>
            <span className="w-16 text-right text-xs text-slate-400">{bytes(a.size)}</span>
            <span className="text-xs text-slate-500">v{a.version}</span>
            <DownloadLink id={a.id} />
          </div>
        ))}
        {!list.length && <div className="p-6 text-center text-sm text-slate-500">Belum ada berkas.</div>}
      </div>
    </Page>
  );
}

export function AnalyticsView() {
  const { s } = useApp();
  if (!s) return null;
  const run = s.run;
  const max = (xs: number[]) => Math.max(1, ...xs);
  const perAgent = s.agents.map((a) => ({ a, n: s.artifacts.filter((x) => x.producer === a.id).length }));
  const lanes = (['research', 'visual', 'technical', 'revision', 'final'] as const).map((l) => ({ l, n: s.transfers.filter((t) => t.lane === l && t.status === 'done').length }));
  const failed = s.transfers.filter((t) => t.status === 'failed').length;
  const Bar = ({ label, n, m, color }: { label: string; n: number; m: number; color: string }) => (
    <div className="mb-2 flex items-center gap-2 text-xs"><span className="w-28 shrink-0 text-slate-300">{label}</span><div className="h-3 flex-1 overflow-hidden rounded bg-slate-800"><div className="h-full rounded" style={{ width: `${(n / m) * 100}%`, background: color }} /></div><span className="w-8 text-right">{n}</span></div>
  );
  return (
    <Page title="Analytics">
      <div className="mb-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[['Berkas', s.stats.files], ['Total ukuran', bytes(s.stats.totalBytes)], ['Transfer sukses', s.transfers.filter((t) => t.status === 'done').length], ['Transfer gagal', failed], ['Langkah selesai', `${s.stats.tasksDone}/${s.stats.tasksTotal}`], ['Durasi run terakhir', run ? clock(s.stats.durationMs) : '—'], ['Status', run?.status ?? 'idle'], ['Pesan hub', s.messages.length]].map(([k, v]) => (
          <div key={String(k)} className="panel p-3"><div className="text-xs text-slate-400">{k}</div><div className="text-xl font-semibold text-white">{v}</div></div>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="panel p-4"><h3 className="m-0 mb-3 text-sm text-slate-300">Berkas per agen</h3>{perAgent.map(({ a, n }) => <Bar key={a.id} label={a.name} n={n} m={max(perAgent.map((x) => x.n))} color={a.color} />)}</div>
        <div className="panel p-4"><h3 className="m-0 mb-3 text-sm text-slate-300">Transfer per jalur</h3>{lanes.map(({ l, n }) => <Bar key={l} label={l} n={n} m={max(lanes.map((x) => x.n))} color={LANE_COLOR[l]} />)}</div>
      </div>
    </Page>
  );
}

export function SettingsView() {
  const { s, act } = useApp();
  const [rounds, setRounds] = useState<number | null>(null);
  if (!s) return null;
  const v = rounds ?? s.settings.maxRounds;
  return (
    <Page title="Settings">
      <div className="panel max-w-xl space-y-4 p-4 text-sm">
        <div>
          <label className="mb-1 block text-slate-300">Batas ronde kolaborasi sebelum meminta keputusan pengguna</label>
          <div className="flex gap-2">
            <input type="number" min={1} max={6} value={v} onChange={(e) => setRounds(Number(e.target.value))} className="w-24 rounded-lg border border-line bg-panel2 px-3 py-2" />
            <button className="rounded-lg bg-c1 px-4 py-2 font-semibold" onClick={() => act(() => api.put('/api/settings', { maxRounds: v }), 'Tersimpan')}>Simpan</button>
          </div>
        </div>
        <div className="rounded-lg border border-line p-3 text-xs text-slate-400">
          <b className="text-slate-200">On-Demand Mode</b> — tidak ada polling dan tidak ada pekerjaan otomatis. Agen IDLE sampai Anda menekan Start Project.<br />
          Durasi animasi per kabel: {s.settings.hopMs} ms (env <code>FLOWNODE_HOP_MS</code>).
        </div>
        <button className="rounded-lg border border-line px-4 py-2 hover:border-fin/60" onClick={() => act(() => api.post(`/api/projects/${s.project.id}/graph/reset`), 'Tata letak direset')}>Reset tata letak & kabel default</button>
      </div>
    </Page>
  );
}
