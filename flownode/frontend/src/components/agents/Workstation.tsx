import { rawUrl } from '../../api';
import { useArtifactText } from '../../lib/hooks';
import type { Agent, Artifact, Snapshot } from '../../types';

const latest = (arts: Artifact[], producer: string, kinds: string[]): Artifact | undefined =>
  [...arts].reverse().find((a) => a.producer === producer && kinds.includes(a.kind));

const Empty = ({ text }: { text: string }) => (
  <div className="flex h-full items-center justify-center text-[10px] uppercase tracking-wide text-slate-500">{text}</div>
);

/** Layar mini Director: dokumen rencana terbaru + status distribusi tugas (nilai nyata). */
export function DirectorScreen({ s, agent }: { s: Snapshot; agent: Agent }) {
  const doc = latest(s.artifacts, agent.id, ['document']);
  const text = useArtifactText(doc?.id);
  if (!doc) return <Empty text="Belum ada pekerjaan" />;
  return (
    <div className="flex h-full gap-2">
      <pre className="m-0 min-w-0 flex-1 overflow-hidden whitespace-pre-wrap font-mono text-[8px] leading-[10px] text-slate-300">
        {(text ?? '').split('\n').filter(Boolean).slice(0, 9).join('\n')}
      </pre>
      <div className="w-[34%] shrink-0 space-y-1 border-l border-line pl-2">
        {s.agents.map((a) => (
          <div key={a.id} className="flex items-center gap-1 text-[8px] text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: a.color, opacity: a.status === 'idle' ? 0.35 : 1 }} />
            <span className="truncate">{a.role}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Layar mini Creator: thumbnail gambar/storyboard asli yang telah dibuat. */
export function CreatorScreen({ s, agent }: { s: Snapshot; agent: Agent }) {
  const mine = s.artifacts.filter((a) => a.producer === agent.id);
  const visuals = mine.filter((a) => a.kind === 'image' || a.kind === 'video').slice(-2);
  if (!mine.length) return <Empty text="Belum ada pekerjaan" />;
  const count = (k: string) => mine.filter((a) => a.kind === k).length;
  return (
    <div className="flex h-full gap-2">
      <div className="flex min-w-0 flex-1 gap-1.5">
        {visuals.map((a) => (
          <img key={a.id} src={rawUrl(a.id)} alt={a.name} className="h-full min-w-0 flex-1 rounded-md object-cover" draggable={false} />
        ))}
      </div>
      <div className="w-[30%] shrink-0 space-y-1 border-l border-line pl-2 text-[8px] text-slate-400">
        <div>Gambar {count('image')}</div>
        <div>Video {count('video')}</div>
        <div>3D {count('model3d')}</div>
        <div>Audio {count('audio')}</div>
      </div>
    </div>
  );
}

/** Layar mini Engineer: log build dan potongan kode terbaru. */
export function EngineerScreen({ s, agent }: { s: Snapshot; agent: Agent }) {
  const log = [...s.artifacts].reverse().find((a) => a.producer === agent.id && a.name.endsWith('.log'));
  const code = [...s.artifacts].reverse().find((a) => a.producer === agent.id && a.name.endsWith('.html'));
  const logText = useArtifactText(log?.id);
  const codeText = useArtifactText(code?.id);
  if (!log && !code) return <Empty text="Belum ada pekerjaan" />;
  return (
    <div className="flex h-full gap-2">
      <pre className="m-0 min-w-0 flex-1 overflow-hidden whitespace-pre-wrap font-mono text-[8px] leading-[10px] text-c3/90">
        {(codeText ?? '').split('\n').filter(Boolean).slice(0, 8).join('\n')}
      </pre>
      <div className="w-[42%] shrink-0 space-y-0.5 border-l border-line pl-2 font-mono text-[8px] leading-[10px]">
        {(logText ?? '').split('\n').filter(Boolean).slice(1, 6).map((l, i) => (
          <div key={i} className={/ok|lulus/i.test(l) ? 'text-c3' : 'text-slate-400'}>{l}</div>
        ))}
      </div>
    </div>
  );
}
