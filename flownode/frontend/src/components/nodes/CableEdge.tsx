import { useRef } from 'react';
import { getBezierPath, type EdgeProps } from 'reactflow';
import { useApp } from '../../store';
import { LANE_COLOR, edgeBaseColor, type Transfer } from '../../types';
import { iconPath, kindIcon } from '../Icon';

/** Objek file yang bergerak di sepanjang kabel. Posisi awal disinkronkan dari waktu mulai transfer nyata. */
function Flyer({ t, path, serverTime }: { t: Transfer; path: string; serverTime: number }) {
  const elapsed = useRef(Math.max(0, serverTime - t.startedAt) / 1000);
  const remain = Math.max(0.2, t.durationMs / 1000 - elapsed.current);
  const color = LANE_COLOR[t.lane];
  return (
    <g>
      <animateMotion path={path} dur={`${remain}s`} begin="0s" fill="freeze" calcMode="linear" />
      <rect x={-15} y={-15} width={30} height={30} rx={8} fill="#0B1120" stroke={color} strokeWidth={2} style={{ filter: `drop-shadow(0 0 6px ${color})` }} />
      <g transform="translate(-9 -9) scale(0.75)" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d={iconPath(kindIcon(t.kind))} />
      </g>
    </g>
  );
}

export function CableEdge(p: EdgeProps) {
  const { s } = useApp();
  const [path] = getBezierPath({
    sourceX: p.sourceX, sourceY: p.sourceY, targetX: p.targetX, targetY: p.targetY,
    sourcePosition: p.sourcePosition, targetPosition: p.targetPosition,
  });
  const transfers = s?.transfers ?? [];
  const moving = transfers.filter((t) => t.edgeId === p.id && t.status === 'moving');
  const last = transfers.find((t) => t.edgeId === p.id && t.status === 'done');
  const active = moving.length > 0;
  const base = edgeBaseColor(p.source, p.target);
  const color = active ? LANE_COLOR[moving[0]!.lane] : last ? LANE_COLOR[last.lane] : base;
  return (
    <g>
      <path d={path} fill="none" stroke="#0B1120" strokeWidth={8} strokeLinecap="round" />
      <path d={path} fill="none" stroke={color} strokeWidth={active ? 3.5 : 2.2} strokeOpacity={active ? 1 : last ? 0.75 : 0.5} strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 ${active ? 7 : 3}px ${color}${active ? '' : '88'})` }} />
      {active && (
        <path d={path} fill="none" stroke="#fff" strokeOpacity={0.85} strokeWidth={2} strokeLinecap="round" strokeDasharray="4 16" className="cable-flow" />
      )}
      {/* area klik lebar agar kabel mudah dipilih di layar sentuh */}
      <path d={path} fill="none" stroke="transparent" strokeWidth={22} className="react-flow__edge-interaction" />
      {moving.map((t) => (
        <Flyer key={t.id} t={t} path={path} serverTime={s!.serverTime} />
      ))}
    </g>
  );
}
