import { useMemo, useState, type DragEvent } from 'react';
import type { NodeDefinition } from '../../lib/types';
import { Link } from '../../state/navigation';
import { Icon } from './icons';
import { NODE_DRAG_TYPE } from './stage';

type PaletteProps = {
  definitions: readonly NodeDefinition[];
  categoryNames: ReadonlyMap<string, string>;
  /** Inside a loop body, triggers and approvals are not allowed. */
  inLoop: boolean;
  /** The step a click attaches to, if one is selected. */
  attachTo: string | undefined;
  readOnly: boolean;
  onAdd: (definition: NodeDefinition) => void;
};

type Group = { id: string; title: string; items: NodeDefinition[] };

const isTrigger = (definition: NodeDefinition) =>
  (definition.source.kind === 'builtin' && definition.source.nodeKind === 'trigger') || (definition.source.kind === 'plugin' && definition.source.role === 'trigger');

const allowedInLoop = (definition: NodeDefinition) => !isTrigger(definition) && !(definition.source.kind === 'builtin' && definition.source.nodeKind === 'approval');

const groupsOf = (definitions: readonly NodeDefinition[], names: ReadonlyMap<string, string>): Group[] => {
  const start = definitions.filter(isTrigger);
  const logic = definitions.filter((definition) => definition.source.kind === 'builtin' && !isTrigger(definition));
  const apps = new Map<string, NodeDefinition[]>();
  for (const definition of definitions) {
    if (definition.source.kind !== 'plugin' || isTrigger(definition)) continue;
    apps.set(definition.category, [...(apps.get(definition.category) ?? []), definition]);
  }
  return [
    { id: 'start', title: 'Start', items: start },
    { id: 'logic', title: 'Logic and timing', items: logic },
    ...[...apps.entries()]
      .map(([category, items]) => ({ id: category, title: names.get(category) ?? category, items: [...items].sort((a, b) => a.title.localeCompare(b.title)) }))
      .sort((a, b) => a.title.localeCompare(b.title)),
  ].filter((group) => group.items.length > 0);
};

const matches = (definition: NodeDefinition, text: string) =>
  `${definition.title} ${definition.subtitle} ${definition.description ?? ''} ${definition.category}`.toLowerCase().includes(text.trim().toLowerCase());

export const Palette = ({ definitions, categoryNames, inLoop, attachTo, readOnly, onAdd }: PaletteProps) => {
  const [text, setText] = useState('');
  const groups = useMemo(() => {
    const usable = definitions.filter((definition) => !inLoop || allowedInLoop(definition));
    return groupsOf(text.trim() ? usable.filter((definition) => matches(definition, text)) : usable, categoryNames);
  }, [definitions, inLoop, text, categoryNames]);

  const onDragStart = (event: DragEvent<HTMLButtonElement>, definition: NodeDefinition) => {
    event.dataTransfer.setData(NODE_DRAG_TYPE, definition.type);
    event.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <aside className="palette" aria-label="Modules">
      <div className="palette-head">
        <h2>Modules</h2>
        <label className="palette-search">
          <span className="visually-hidden">Search modules</span>
          <Icon name="search" size={16} />
          <input type="search" placeholder="Search" value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <p className="hint">{readOnly ? 'You can look, but only editors can change this workflow.' : attachTo ? `Click to add after ${attachTo}, or drag onto the floor.` : 'Click to add, or drag onto the floor.'}</p>
      </div>
      <div className="palette-groups">
        {groups.length === 0 ? <p className="hint palette-none">No module matches “{text}”.</p> : null}
        {groups.map((group) => (
          <section key={group.id} className="palette-group" aria-labelledby={`palette-${group.id}`}>
            <h3 id={`palette-${group.id}`}>{group.title}</h3>
            <ul>
              {group.items.map((definition) => (
                <li key={definition.type}>
                  <button
                    type="button"
                    className="palette-item"
                    draggable={!readOnly}
                    disabled={readOnly}
                    onDragStart={(event) => onDragStart(event, definition)}
                    onClick={() => onAdd(definition)}
                    style={{ ['--module-color' as string]: definition.color }}
                    aria-label={`Add ${definition.subtitle ? `${definition.title}: ${definition.subtitle}` : definition.title}`}
                  >
                    <span className="palette-icon" aria-hidden="true">
                      <Icon name={definition.icon} size={16} />
                    </span>
                    <span className="palette-text">
                      <strong>{definition.subtitle || definition.title}</strong>
                      <span>{definition.subtitle ? definition.title : (definition.description ?? '')}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="palette-more">
          <Link to="/marketplace">Find more apps in the Marketplace</Link>
        </p>
      </div>
    </aside>
  );
};
