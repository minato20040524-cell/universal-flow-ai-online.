import { downloadUrl, rawUrl } from '../../api';
import { useArtifactText } from '../../lib/hooks';
import type { Artifact } from '../../types';
import { Icon, kindIcon } from '../Icon';

const lines = (t: string | null, n: number): string => (t ?? '').split('\n').slice(0, n).join('\n');

/** Pratinjau nyata sebuah artefak sesuai jenisnya. */
export function ArtifactView({ artifact, compact = false }: { artifact: Artifact; compact?: boolean }) {
  const isText = ['document', 'code', 'dataset', 'model3d', 'folder'].includes(artifact.kind);
  const text = useArtifactText(isText ? artifact.id : undefined);

  if (artifact.kind === 'image' || artifact.kind === 'video') {
    return <img src={rawUrl(artifact.id)} alt={artifact.name} className={`w-full ${compact ? 'h-full object-cover' : 'max-h-[60vh] object-contain'} rounded-lg bg-black/30`} draggable={false} />;
  }
  if (artifact.kind === 'audio') {
    return compact ? (
      <div className="flex h-full items-center justify-center text-c2"><Icon name="audio" size={28} /></div>
    ) : (
      <audio controls src={rawUrl(artifact.id)} className="w-full nodrag" />
    );
  }
  if (artifact.kind === 'model3d') {
    const v = (text ?? '').split('\n').filter((l) => l.startsWith('v ')).length;
    const f = (text ?? '').split('\n').filter((l) => l.startsWith('f ')).length;
    return (
      <div className="flex h-full items-center justify-center gap-3 text-c2">
        <Icon name="model3d" size={compact ? 30 : 44} />
        <div className="text-[11px] leading-4 text-slate-300">{v} vertex<br />{f} face</div>
      </div>
    );
  }
  return (
    <pre className={`m-0 overflow-hidden whitespace-pre-wrap break-all font-mono ${compact ? 'text-[8px] leading-[10px]' : 'max-h-[50vh] overflow-auto text-[11px] leading-4'} text-slate-300`}>
      {compact ? lines(text, 7) : text}
    </pre>
  );
}

export function KindBadge({ kind }: { kind: string }) {
  return <Icon name={kindIcon(kind)} size={14} />;
}

export function DemoTag() {
  return <span className="rounded border border-warn/50 px-1 text-[9px] font-semibold tracking-wide text-warn">DEMO</span>;
}

export function DownloadLink({ id, label = 'Unduh' }: { id: string; label?: string }) {
  return (
    <a href={downloadUrl(id)} className="inline-flex items-center gap-1 text-xs text-fin hover:underline" download>
      <Icon name="load" size={13} /> {label}
    </a>
  );
}
