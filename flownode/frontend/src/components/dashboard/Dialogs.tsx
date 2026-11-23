import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, downloadUrl } from '../../api';
import { bytes } from '../../lib/hooks';
import { useApp } from '../../store';
import { BUILDERS, NODE_LABEL } from '../../types';
import { Icon } from '../Icon';
import { ArtifactView, DemoTag } from '../files/ArtifactView';
import { ConnectorPill } from '../nodes/AgentNode';

export function Modal({ title, onClose, children, wide = false }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <motion.div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div role="dialog" aria-modal className={`panel max-h-[90vh] w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} overflow-hidden`} initial={{ y: 14, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 8, opacity: 0 }}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold text-white">
          <div className="min-w-0 flex-1 truncate">{title}</div>
          <button onClick={onClose} aria-label="Tutup" className="rounded p-1 text-slate-400 hover:bg-white/10"><Icon name="close" /></button>
        </div>
        <div className="scroll-thin max-h-[78vh] overflow-y-auto p-4">{children}</div>
      </motion.div>
    </motion.div>
  );
}

function StartDialog() {
  const { s, draft, setDraft, setStartOpen, act, setView } = useApp();
  const [text, setText] = useState(draft);
  const [disagree, setDisagree] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  if (!s) return null;
  const browserAgents = s.agents.filter((a) => a.connector.mode === 'browser');
  const go = async () => {
    setDraft(text);
    const r = await act(() => api.post('/api/run/start', { instruction: text, options: { simulateDisagreement: disagree } }), 'Workflow dimulai');
    if (r) { setStartOpen(false); setView('dashboard'); }
  };
  return (
    <Modal title="Start Project" onClose={() => setStartOpen(false)}>
      <label className="mb-1 block text-xs text-slate-400">Instruksi untuk proyek "{s.project.name}"</label>
      <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="Contoh: Buat animasi 3D pertarungan stickman di arena…"
        className="w-full rounded-lg border border-line bg-panel2 p-2 text-sm" />
      <div className="mt-2 rounded-lg border border-warn/40 bg-warn/5 p-2 text-[11px] text-slate-300">
        <b className="text-warn">Mode DEMO.</b> Konten dibuat oleh template lokal, bukan oleh akun Claude. Agen hanya bekerja setelah tombol ini ditekan dan kembali IDLE setelah selesai.
      </div>
      {browserAgents.length > 0 && (
        <div className="mt-2 rounded-lg border border-red-400/40 bg-red-500/5 p-2 text-[11px] text-red-200">
          {browserAgents.map((a) => a.name).join(', ')} memakai Browser Connector yang belum terhubung — workflow akan gagal di agen tersebut.
        </div>
      )}
      <label className="mt-3 flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" checked={disagree} onChange={(e) => setDisagree(e.target.checked)} />
        Uji: paksa agen tidak sepakat (menguji keputusan pengguna setelah {s.settings.maxRounds} ronde)
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded-lg border border-line px-4 py-2 text-sm" onClick={() => setStartOpen(false)}>Batal</button>
        <button disabled={!text.trim()} className="flex items-center gap-2 rounded-lg bg-c1 px-4 py-2 text-sm font-semibold" onClick={go}><Icon name="play" size={14} /> Mulai</button>
      </div>
    </Modal>
  );
}

function LoadDialog() {
  const { s, setLoadOpen, act } = useApp();
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  if (!s) return null;
  const importFile = async (f: File) => {
    try {
      const j = JSON.parse(await f.text());
      const r = await act(() => api.post('/api/projects/import', j), 'Proyek diimpor');
      if (r) setLoadOpen(false);
    } catch {
      await act(() => Promise.reject(new Error('Berkas bukan JSON yang valid.')));
    }
  };
  return (
    <Modal title="Proyek" onClose={() => setLoadOpen(false)}>
      <div className="space-y-1.5">
        {s.projects.map((p) => (
          <div key={p.id} className={`flex items-center gap-2 rounded-lg border p-2 text-sm ${p.id === s.project.id ? 'border-fin/60 bg-fin/5' : 'border-line'}`}>
            <span className="min-w-0 flex-1 truncate">{p.name}{p.id === s.project.id ? ' (aktif)' : ''}</span>
            <button disabled={p.id === s.project.id || s.busy} className="rounded border border-line px-2 py-1 text-xs hover:border-fin/60" onClick={async () => (await act(() => api.post(`/api/projects/${p.id}/open`), 'Proyek dibuka')) && setLoadOpen(false)}>Buka</button>
            <button disabled={s.busy || s.projects.length < 2} className="rounded border border-red-400/40 px-2 py-1 text-xs text-red-300" onClick={() => window.confirm(`Hapus proyek "${p.name}"?`) && act(() => api.del(`/api/projects/${p.id}`), 'Proyek dihapus')}><Icon name="trash" size={13} /></button>
          </div>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama proyek baru" className="min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-3 py-2 text-sm" />
        <button disabled={!name.trim() || s.busy} className="rounded-lg bg-c1 px-3 py-2 text-sm font-semibold" onClick={async () => { if (await act(() => api.post('/api/projects', { name }), 'Proyek dibuat')) { setName(''); setLoadOpen(false); } }}>Buat</button>
      </div>
      <div className="mt-3">
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
        <button className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:border-fin/60" onClick={() => file.current?.click()}><Icon name="load" size={15} /> Impor dari berkas .flownode.json</button>
      </div>
    </Modal>
  );
}

function PreviewDialog({ id }: { id: string }) {
  const { s, setPreviewId } = useApp();
  const a = s?.artifacts.find((x) => x.id === id);
  if (!a) return null;
  return (
    <Modal wide title={<span className="flex items-center gap-2"><Icon name={a.kind} size={16} /> {a.name} {a.demo && <DemoTag />}</span>} onClose={() => setPreviewId(null)}>
      <ArtifactView artifact={a} />
      <div className="mt-3 flex items-center gap-3 text-xs text-slate-400">
        <span>{bytes(a.size)}</span><span>dibuat oleh {NODE_LABEL[a.producer] ?? a.producer}</span><span>v{a.version}</span>
        <a href={downloadUrl(a.id)} download className="ml-auto flex items-center gap-1 text-fin hover:underline"><Icon name="load" size={14} /> Unduh</a>
      </div>
    </Modal>
  );
}

function ExpandDialog({ id }: { id: string }) {
  const { s, setExpanded, setPreviewId, act } = useApp();
  if (!s) return null;
  const agent = s.agents.find((a) => a.id === id);
  const builder = BUILDERS.find((b) => b.id === id);
  if (agent) {
    const mine = s.artifacts.filter((a) => a.producer === agent.id);
    const history = s.activity.filter((e) => e.agent === agent.id).slice(0, 25);
    return (
      <Modal wide title={`${agent.name} — ${agent.role}`} onClose={() => setExpanded(null)}>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2"><ConnectorPill agent={agent} /><span className="text-xs text-slate-400">{agent.connector.note}</span></div>
            <div className="rounded-lg border border-line p-2 text-xs"><b>Status:</b> {agent.status === 'idle' ? 'IDLE' : agent.status}{agent.task ? ` — ${agent.task}` : ''}</div>
            <div>
              <div className="mb-1 text-xs font-semibold text-slate-400">Skills</div>
              <div className="flex flex-wrap gap-1">{agent.skills.map((k) => <span key={k.id} className="rounded-full border border-line px-2 py-0.5 text-[11px]">{k.name}{k.enabled ? '' : ' (nonaktif)'}</span>)}</div>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={agent.connector.takeover} onChange={(e) => act(() => api.put(`/api/agents/${agent.id}/takeover`, { on: e.target.checked }))} />
              Manual takeover (agen ini tidak dijalankan otomatis)
            </label>
            <div>
              <div className="mb-1 text-xs font-semibold text-slate-400">Berkas ({mine.length})</div>
              <div className="space-y-1">{mine.map((a) => <button key={a.id} className="block w-full truncate rounded border border-line px-2 py-1 text-left text-xs hover:border-fin/60" onClick={() => setPreviewId(a.id)}>{a.name}</button>)}{!mine.length && <div className="text-xs text-slate-500">Belum ada.</div>}</div>
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold text-slate-400">Activity history</div>
            <div className="scroll-thin max-h-[380px] space-y-1 overflow-y-auto text-xs">
              {history.map((e) => <div key={e.id} className="rounded border border-line/60 px-2 py-1 text-slate-300"><span className="text-slate-500">{new Date(e.ts).toLocaleTimeString('en-GB', { hour12: false })}</span> {e.activity}{e.file ? ` · ${e.file}` : ''}</div>)}
              {!history.length && <div className="text-slate-500">Belum ada aktivitas.</div>}
            </div>
          </div>
        </div>
      </Modal>
    );
  }
  if (builder) {
    const files = s.artifacts.filter((a) => (builder.kinds as readonly string[]).includes(a.kind));
    return (
      <Modal wide title={builder.name} onClose={() => setExpanded(null)}>
        <div className="grid gap-3 sm:grid-cols-2">
          {files.map((a) => (
            <button key={a.id} onClick={() => setPreviewId(a.id)} className="rounded-xl border border-line p-2 text-left hover:border-fin/60">
              <div className="mb-1 h-24 overflow-hidden rounded-lg bg-black/30 p-1"><ArtifactView artifact={a} compact /></div>
              <div className="truncate text-xs">{a.name} {a.demo && <DemoTag />}</div>
            </button>
          ))}
          {!files.length && <div className="text-sm text-slate-500">Belum ada berkas di builder ini.</div>}
        </div>
      </Modal>
    );
  }
  return null;
}

export function Overlays() {
  const { startOpen, loadOpen, previewId, expanded, toasts } = useApp();
  return (
    <>
      <AnimatePresence>{startOpen && <StartDialog key="start" />}</AnimatePresence>
      <AnimatePresence>{loadOpen && <LoadDialog key="load" />}</AnimatePresence>
      <AnimatePresence>{expanded && <ExpandDialog key={`x-${expanded}`} id={expanded} />}</AnimatePresence>
      <AnimatePresence>{previewId && <PreviewDialog key={`p-${previewId}`} id={previewId} />}</AnimatePresence>
      <div className="pointer-events-none fixed bottom-3 left-1/2 z-[60] flex -translate-x-1/2 flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`pointer-events-auto rounded-xl border px-4 py-2 text-sm shadow-xl ${t.tone === 'error' ? 'border-red-400/60 bg-red-950/90 text-red-100' : t.tone === 'ok' ? 'border-c3/60 bg-emerald-950/90 text-emerald-100' : 'border-line bg-panel text-slate-200'}`}>{t.text}</div>
        ))}
      </div>
    </>
  );
}
