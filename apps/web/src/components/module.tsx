import type { ReactNode } from 'react';
import type { DataPort, MarketplacePlugin, NodeDefinition } from '../lib/types';
import { describeSource, installsLabel } from '../lib/presentation';
import { Link } from '../state/navigation';

/** Category colours match the node generator's defaults, so a module looks the same in every view. */
const CATEGORY_COLORS: Record<string, string> = {
  'ai-llm': '#7C5CFF',
  'ai-image': '#E0569B',
  'ai-video': '#F25F4C',
  'ai-audio': '#F2994A',
  'social-media': '#2D9CDB',
  messaging: '#27AE60',
  email: '#56CCF2',
  'cloud-storage': '#4F86F7',
  'office-documents': '#219653',
  database: '#9B51E0',
  webhooks: '#EB5757',
};

export const categoryColor = (category: string): string => CATEGORY_COLORS[category] ?? '#8A939D';

/** Two jacks and the cable between them; drawn for dark backgrounds (the rack). */
export const Logo = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <rect x="1.5" y="1.5" width="29" height="29" rx="6" fill="#2A3038" stroke="#4A525C" />
    <circle cx="10" cy="11" r="3.6" fill="#0F1114" stroke="#E8AE1C" strokeWidth="2" />
    <circle cx="22" cy="21" r="3.6" fill="#0F1114" stroke="#3FB872" strokeWidth="2" />
    <path d="M10 14.5c0 7 12 0 12 3" fill="none" stroke="#D9DDE2" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
);

/** A patch jack: a ring in the module's colour around a dark socket. */
export const Jack = ({ color, size = 14, title }: { color: string; size?: number; title?: string }) => (
  <svg className="jack" width={size} height={size} viewBox="0 0 14 14" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
    {title ? <title>{title}</title> : null}
    <circle cx="7" cy="7" r="6" fill="none" stroke={color} strokeWidth="2" />
    <circle cx="7" cy="7" r="3" fill="currentColor" opacity="0.8" />
  </svg>
);

const Port = ({ port, color }: { port: DataPort; color: string }) => (
  <span className="port">
    <Jack color={color} />
    <span>
      {port.label}
      {port.required ? <em> required</em> : null}
    </span>
  </span>
);

type FaceplateProps = {
  title: string;
  subtitle: string;
  category: string;
  inputs: readonly DataPort[];
  outputs: readonly DataPort[];
  footer?: ReactNode;
};

/** The module as Spatial Studio will show it: inputs on the left, outputs on the right. */
export const Faceplate = ({ title, subtitle, category, inputs, outputs, footer }: FaceplateProps) => {
  const color = categoryColor(category);
  return (
    <figure className="faceplate" style={{ ['--module-color' as string]: color }} aria-label={`${title} module`}>
      <div className="faceplate-title">
        <strong>{title || 'Untitled'}</strong>
        <span>{subtitle || 'No action yet'}</span>
      </div>
      <div className="faceplate-ports">
        <div className="port-column">
          <h4>Inputs</h4>
          {inputs.length === 0 ? <span className="port-empty">None</span> : inputs.map((port) => <Port key={port.key} port={port} color={color} />)}
        </div>
        <div className="port-column outputs">
          <h4>Outputs</h4>
          {outputs.length === 0 ? <span className="port-empty">None</span> : outputs.map((port) => <Port key={port.key} port={port} color={color} />)}
        </div>
      </div>
      {footer ? <figcaption className="faceplate-foot">{footer}</figcaption> : null}
    </figure>
  );
};

export const faceplateFromNode = (node: NodeDefinition | undefined) => ({
  inputs: node?.dataInputs ?? [],
  outputs: node?.dataOutputs ?? [],
  subtitle: node?.subtitle ?? '',
});

/** A column of jacks for a rack row; capped so a big schema does not stretch the row. */
export const JackColumn = ({ count, color, side }: { count: number; color: string; side: 'in' | 'out' }) => {
  const shown = Math.min(count, 4);
  return (
    <span className={`jacks ${side}`} aria-label={`${count} ${side === 'in' ? 'inputs' : 'outputs'}`}>
      {Array.from({ length: shown }, (_, index) => (
        <Jack key={index} color={color} size={12} />
      ))}
    </span>
  );
};

type TileProps = { plugin: MarketplacePlugin; action: ReactNode };

/** A narrow faceplate on a marketplace rail. */
export const Tile = ({ plugin, action }: TileProps) => {
  const color = categoryColor(plugin.category);
  const { ports } = plugin;
  return (
    <article className="tile" style={{ ['--module-color' as string]: color }}>
      <header>
        <Link to={`/marketplace/${encodeURIComponent(plugin.id)}`} className="tile-name">
          {plugin.name}
        </Link>
        <span className="provider">{plugin.provider}</span>
      </header>
      <p>{plugin.description ?? `${describeSource(plugin.source)} integration.`}</p>
      <footer className="tile-foot">
        <span className="tile-jacks" aria-label={`${ports.inputs} inputs, ${ports.outputs} outputs`}>
          {Array.from({ length: Math.min(ports.inputs + ports.outputs, 8) }, (_, index) => (
            <Jack key={index} color={color} size={11} />
          ))}
        </span>
        <small>{plugin.installs > 0 ? installsLabel(plugin.installs) : describeSource(plugin.source)}</small>
        {action}
      </footer>
    </article>
  );
};
