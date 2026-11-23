import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { hhmmss } from '../../lib/hooks';
import { useApp } from '../../store';
import { AGENT_COLOR, NODE_LABEL, type CollabPhase, type Message } from '../../types';
import { Icon } from '../Icon';
import { DemoTag } from '../files/ArtifactView';

const TABS = ['Diskusi', 'Files', 'Decision', 'Activity'] as const;
type Tab = (typeof TABS)[number];

const FLOW: { id: CollabPhase; label: string }[] = [
  { id: 'proposal', label: 'PROPOSAL' }, { id: 'review', label: 'REVIEW' }, { id: 'critique', label: 'CRITIQUE' },
  { id: 'revision', label: 'REVISION' }, { id: 'reeval', label: 'RE-EVAL' }, { id: 'consensus', label: 'CONSENSUS' },
];
const PHASE_COLOR: Record<string, string> = {
  proposal: '#2196F3', review: '#2196F3', critique: '#F59E0B', revision: '#F59E0B', reeval: '#A855F7',
  consensus: '#10B981', decision: '#22D3EE', system: '#64748b',
};

function MessageRow({ m }: { m: Message }) {
  const color = AGENT_COLOR[m.sender] ?? '#64748b';
  return (
    <div className="flex gap-2 rounded-xl border border-line/70 bg-panel2/80 p-2">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full" style={{ background: `${color}33`, color }}>
        <Icon name="agents" size={13} />
      </span>
      <div className="min-w-0 flex-1 text-xs">
        <div className="flex items-center gap-1.5">
          <b className="text-slate-100">{NODE_LABEL[m.sender] ?? m.sender}</b>
          <span className="rounded px-1 text-[9px] font-semibold" style={{ background: `${PHASE_COLOR[m.phase]}22`, color: PHASE_COLOR[m.phase] }}>{m.phase.toUpperCase()}</span>
          {m.demo && <DemoTag />}
          <span className="ml-auto text-[10px] text-slate-500">{hhmmss(m.ts)}</span>
        </div>
        <p className="m-0 mt-0.5 break-words text-slate-300">{m.text}</p>
      </div>
    </div>
  );
}

export function HubPanel({ compact = false }: { compact?: boolean }) {
  const { s, draft, setDraft, act, setPreviewId } = useApp();
  const [tab, setTab] = useState<Tab>('Diskusi');
  const [note, setNote] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const run = s?.run ?? null;
  const msgs = (s?.messages ?? []).filter((m) => !run || m.runId === run.id);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs.length, tab]);
  if (!s) return null;

  const busy = s.busy;
  const current = [...msgs].reverse().find((m) => m.phase !== 'system')?.phase;
  const pending = s.approvals.filter((a) => a.status === 'pending');
  const files = s.artifacts.filter((a) => !run || a.runId === run.id);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="nodrag flex gap-1 rounded-lg bg-panel2 p-1 text-xs">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 rounded-md px-2 py-1 ${tab === t ? 'bg-c1/25 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
            {t}{t === 'Decision' && pending.length ? ` (${pending.length})` : ''}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[9px] font-semibold tracking-wide">
        {FLOW.map((f, i) => (
          <span key={f.id} className="flex items-center gap-1">
            <span style={{ color: current === f.id ? PHASE_COLOR[f.id] : '#475569' }}>{f.label}</span>
            {i < FLOW.length - 1 && <span className="text-slate-700">→</span>}
          </span>
        ))}
        <span className="text-slate-700">→</span>
        <span style={{ color: pending.length ? '#22D3EE' : '#475569' }}>USER APPROVAL</span>
      </div>

      <div className={`nodrag nowheel scroll-thin min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1 ${compact ? 'max-h-[190px]' : ''}`}>
        {tab === 'Diskusi' && (
          msgs.length ? msgs.map((m) => <MessageRow key={m.id} m={m} />) : (
            <div className="grid h-full place-items-center py-6 text-center text-xs text-slate-500">Belum ada diskusi. Hub aktif setelah START PROJECT.</div>
          )
        )}
        {tab === 'Files' && (files.length ? files.map((a) => (
          <button key={a.id} onClick={() => setPreviewId(a.id)} className="flex w-full items-center gap-2 rounded-lg border border-line/70 bg-panel2/80 p-2 text-left text-xs hover:border-fin/50">
            <Icon name={a.kind} size={14} /> <span className="min-w-0 flex-1 truncate">{a.name}</span>
            <span className="text-slate-500">{NODE_LABEL[a.producer] ?? a.producer}</span>
          </button>
        )) : <div className="py-6 text-center text-xs text-slate-500">Belum ada berkas bersama.</div>)}
        {tab === 'Decision' && (
          <>
            {pending.length === 0 && <div className="py-3 text-center text-xs text-slate-500">Tidak ada keputusan tertunda.</div>}
            {pending.map((a) => (
              <div key={a.id} className="rounded-xl border border-fin/40 bg-fin/5 p-2 text-xs">
                <b className="text-fin">{a.title}</b>
                <p className="m-0 my-1 text-slate-300">{a.detail}</p>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Catatan (opsional)" className="mb-1.5 w-full rounded-md border border-line bg-panel2 px-2 py-1 text-xs" />
                <div className="flex gap-2">
                  <button className="flex-1 rounded-md bg-c3/90 py-1 font-semibold text-black" onClick={() => act(() => api.post(`/api/approvals/${a.id}`, { decision: 'approved', note }), 'Disetujui')}>Setujui</button>
                  <button className="flex-1 rounded-md border border-warn/70 py-1 font-semibold text-warn" onClick={() => act(() => api.post(`/api/approvals/${a.id}`, { decision: 'rejected', note }), 'Ditolak')}>Tolak / Revisi</button>
                </div>
              </div>
            ))}
            {s.approvals.filter((a) => a.status !== 'pending').slice(0, 5).map((a) => (
              <div key={a.id} className="rounded-lg border border-line/60 p-2 text-[11px] text-slate-400">
                {a.title}: <b className={a.status === 'approved' ? 'text-c3' : 'text-warn'}>{a.status === 'approved' ? 'disetujui' : 'ditolak'}</b>{a.note ? ` — ${a.note}` : ''}
              </div>
            ))}
          </>
        )}
        {tab === 'Activity' && s.activity.slice(0, 20).map((e) => (
          <div key={e.id} className="rounded-lg border border-line/60 px-2 py-1 text-[11px] text-slate-300">
            <span className="text-slate-500">{hhmmss(e.ts)}</span> {NODE_LABEL[e.agent] ?? e.agent}: {e.activity}{e.file ? ` · ${e.file}` : ''}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form className="nodrag flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          placeholder={busy ? 'Instruksi baru dapat ditulis saat IDLE' : 'Tulis instruksi proyek…'}
          className="min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-3 py-1.5 text-xs placeholder:text-slate-500"
        />
        <button type="submit" disabled title="Instruksi dikirim lewat tombol Start Project" className="hidden" />
        <span className="hidden text-[10px] text-slate-500 sm:inline">Start Project ▸ kirim</span>
      </form>
    </div>
  );
}
