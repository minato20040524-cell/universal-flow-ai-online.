import { useState } from 'react';
import { clock, bytes } from '../../lib/hooks';
import { useApp } from '../../store';
import { Icon } from '../Icon';
import { ArtifactView, DemoTag, DownloadLink } from './ArtifactView';

const TABS = ['Preview', 'Files', 'Details'] as const;

export function FileRow({ a }: { a: import('../../types').Artifact }) {
  const { setPreviewId } = useApp();
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-slate-400"><Icon name={a.kind} size={14} /></span>
      <button className="min-w-0 flex-1 truncate text-left text-slate-200 hover:text-fin" onClick={() => setPreviewId(a.id)} title="Pratinjau">{a.name}</button>
      {a.demo && <DemoTag />}
      <span className="w-14 shrink-0 text-right text-slate-500">{bytes(a.size)}</span>
      <DownloadLink id={a.id} label="" />
    </div>
  );
}

export function ProjectOutput() {
  const { s, setView } = useApp();
  const [tab, setTab] = useState<(typeof TABS)[number]>('Preview');
  if (!s) return null;
  const run = s.run;
  const arts = s.artifacts.filter((a) => !run || a.runId === run.id);
  const hero = [...arts].reverse().find((a) => a.kind === 'image');
  const clip = [...arts].reverse().find((a) => a.kind === 'video');
  const audio = [...arts].reverse().find((a) => a.kind === 'audio');
  const total = arts.reduce((n, a) => n + a.size, 0);

  return (
    <aside className="panel flex min-h-0 flex-col gap-3 p-3">
      <div className="flex gap-1 rounded-xl bg-panel2 p-1 text-sm">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 rounded-lg py-1.5 ${tab === t ? 'bg-c1 text-white' : 'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      {tab === 'Preview' && (
        <div className="space-y-2">
          <div className="overflow-hidden rounded-xl border border-line bg-black/30">
            {hero ? <ArtifactView artifact={hero} /> : <div className="grid h-40 place-items-center text-xs text-slate-500">Belum ada hasil. Tekan Start Project.</div>}
          </div>
          {clip && <div className="h-24 overflow-hidden rounded-lg border border-line"><ArtifactView artifact={clip} compact /></div>}
          {audio && <ArtifactView artifact={audio} />}
        </div>
      )}
      {tab === 'Files' && (
        <div className="scroll-thin max-h-[300px] space-y-2 overflow-y-auto pr-1">
          {arts.length ? arts.map((a) => <FileRow key={a.id} a={a} />) : <div className="py-6 text-center text-xs text-slate-500">Belum ada berkas.</div>}
        </div>
      )}
      {tab === 'Details' && (
        <dl className="m-0 space-y-1.5 text-xs">
          {[
            ['Proyek', s.project.name],
            ['Instruksi', run?.instruction ?? '—'],
            ['Status', run ? run.status : 'idle'],
            ['Durasi', run ? clock(s.stats.durationMs) : '—'],
            ['Berkas', `${arts.length} (${bytes(total)})`],
            ['Mode', arts.some((a) => a.demo) ? 'DEMO (konten template lokal)' : 'Akun Claude'],
          ].map(([k, v]) => (
            <div key={k} className="flex gap-2"><dt className="w-20 shrink-0 text-slate-500">{k}</dt><dd className="m-0 min-w-0 break-words text-slate-200">{v}</dd></div>
          ))}
        </dl>
      )}

      <a href={arts.length ? `/api/projects/${s.project.id}/bundle.zip` : undefined}
        className={`flex items-center justify-center gap-2 rounded-xl py-2 text-sm font-semibold ${arts.length ? 'bg-c1 text-white hover:brightness-110' : 'pointer-events-none bg-slate-700/50 text-slate-500'}`} download>
        <Icon name="load" size={16} /> Download Project
      </a>

      <div>
        <div className="mb-1.5 flex items-center justify-between text-sm font-semibold text-white">
          <span>Project Files ({arts.length})</span>
        </div>
        <div className="scroll-thin max-h-[170px] space-y-1.5 overflow-y-auto pr-1">
          {arts.slice(-8).map((a) => <FileRow key={a.id} a={a} />)}
        </div>
        <button onClick={() => setView('files')} className="mt-2 text-xs text-fin hover:underline">Lihat semua file →</button>
      </div>
    </aside>
  );
}
