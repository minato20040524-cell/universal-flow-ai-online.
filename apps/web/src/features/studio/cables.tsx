import { memo, type ReactNode } from 'react';
import type { DataLink } from '../../lib/studio/data';
import type { EdgeState } from '../../lib/types';

export type CablePoint = { x: number; y: number };

export type Cable = {
  id: string;
  kind: 'flow' | 'data';
  from: CablePoint;
  to: CablePoint;
  /** The output port it leaves from; error cables are drawn dashed. */
  port: string | undefined;
  state: EdgeState | undefined;
  color: string | undefined;
  selected: boolean;
  /** Data cables stay faint unless they touch the selected step. */
  emphasis: boolean;
  target: { type: 'edge'; id: string } | { type: 'data'; link: DataLink };
};

export type DraftCable = { kind: 'flow' | 'data'; from: CablePoint; to: CablePoint };

/** Room around a curve for the stroke, the plugs and the hit area. */
const PAD = 14;

const reachOf = (from: CablePoint, to: CablePoint): number => {
  const dx = to.x - from.x;
  return dx >= 0 ? Math.max(40, dx * 0.5) : Math.max(110, -dx * 0.6);
};

/** A patch-cable curve: it leaves an output to the right and enters an input from the left. */
export const cablePath = (from: CablePoint, to: CablePoint): string => {
  const reach = reachOf(from, to);
  return `M ${from.x} ${from.y} C ${from.x + reach} ${from.y}, ${to.x - reach} ${to.y}, ${to.x} ${to.y}`;
};

/** The curve stays inside the box of its end and control points. */
const boxOf = (from: CablePoint, to: CablePoint) => {
  const reach = reachOf(from, to);
  const xs = [from.x, to.x, from.x + reach, to.x - reach];
  const ys = [from.y, to.y];
  return { minX: Math.min(...xs) - PAD, minY: Math.min(...ys) - PAD, maxX: Math.max(...xs) + PAD, maxY: Math.max(...ys) + PAD };
};

/**
 * One small SVG per cable, on a plane just above the boards' faces. Chromium
 * rasterizes only part of a single huge 3D-transformed layer, so cables are not
 * drawn on one shared sheet.
 */
const CableSheet = ({ from, to, z, children }: { from: CablePoint; to: CablePoint; z: number; children: (path: string) => ReactNode }) => {
  const box = boxOf(from, to);
  return (
    <svg
      className="cables"
      width={box.maxX - box.minX}
      height={box.maxY - box.minY}
      viewBox={`${box.minX} ${box.minY} ${box.maxX - box.minX} ${box.maxY - box.minY}`}
      style={{ transform: `translate3d(${box.minX}px, ${box.minY}px, ${z}px)` }}
      aria-hidden="true"
    >
      {children(cablePath(from, to))}
    </svg>
  );
};

type CableLayerProps = { cables: readonly Cable[]; draft: DraftCable | undefined; z: number };

const CableLayerView = ({ cables, draft, z }: CableLayerProps) => (
  <>
    {cables.map((cable) => (
      <CableSheet key={cable.id} from={cable.from} to={cable.to} z={z}>
        {(path) => (
          <g
            className="cable"
            data-kind={cable.kind}
            data-state={cable.state}
            data-error-port={cable.port === 'error' || undefined}
            data-selected={cable.selected || undefined}
            data-emphasis={cable.emphasis || undefined}
            data-cable={cable.id}
            style={cable.color ? { ['--cable-color' as string]: cable.color } : undefined}
          >
            <path className="cable-hit" d={path} />
            <path className="cable-body" d={path} />
            <path className="cable-sheen" d={path} />
            {cable.state === 'fired' ? <path className="cable-signal" d={path} /> : null}
            <circle className="cable-plug" cx={cable.from.x} cy={cable.from.y} r={cable.kind === 'flow' ? 5 : 3.5} />
            <circle className="cable-plug" cx={cable.to.x} cy={cable.to.y} r={cable.kind === 'flow' ? 5 : 3.5} />
          </g>
        )}
      </CableSheet>
    ))}
    {draft ? (
      <CableSheet from={draft.from} to={draft.to} z={z + 1}>
        {(path) => (
          <g className="cable cable-draft" data-kind={draft.kind}>
            <path className="cable-body" d={path} />
            <circle className="cable-plug" cx={draft.to.x} cy={draft.to.y} r={6} />
          </g>
        )}
      </CableSheet>
    ) : null}
  </>
);

export const CableLayer = memo(CableLayerView);
