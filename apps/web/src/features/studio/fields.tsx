import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { insertToken, referencesIn, type DataSource } from '../../lib/studio/data';
import { Icon } from './icons';

/** Form controls for the inspector: text that can hold data references, and the picker that inserts them. */

type PickerProps = { sources: readonly DataSource[]; onPick: (reference: string) => void; label: string; disabled?: boolean };

const PATH = /^[A-Za-z_$][\w$-]*(\.[A-Za-z_$][\w$-]*|\[\d+\])*$/;

export const DataPicker = ({ sources, onPick, label, disabled }: PickerProps) => {
  const [open, setOpen] = useState(false);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const pick = (reference: string) => {
    onPick(reference);
    setOpen(false);
  };

  return (
    <div
      className="picker"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button type="button" className="btn btn-quiet btn-small picker-toggle" aria-expanded={open} aria-controls={panelId} disabled={disabled} onClick={() => setOpen(!open)}>
        <Icon name="data" size={15} />
        Insert data
        <span className="visually-hidden"> into {label}</span>
      </button>
      {open ? (
        <div className="picker-panel" id={panelId} role="dialog" aria-label={`Data for ${label}`}>
          {sources.length === 0 ? <p className="hint">Connect an earlier step to this one first; its outputs then appear here.</p> : null}
          {sources.map((source) => {
            const path = paths[source.id] ?? '';
            const fullPath = source.pathPrefix && path ? `${source.pathPrefix}.${path.replace(/^\.+/, '')}` : undefined;
            return (
              <section key={source.id} className="picker-source">
                <h4>{source.title}</h4>
                <ul>
                  {source.choices.map((choice) => (
                    <li key={choice.reference}>
                      <button type="button" onClick={() => pick(choice.reference)} title={choice.description}>
                        <span>{choice.label}</span>
                        <code>{choice.type}</code>
                      </button>
                    </li>
                  ))}
                </ul>
                {source.pathPrefix ? (
                  <form
                    className="picker-path"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (fullPath && PATH.test(fullPath)) pick(fullPath);
                    }}
                  >
                    <label>
                      <span className="visually-hidden">Field inside {source.title}</span>
                      <input type="text" placeholder={source.id === '$item' ? 'field, e.g. email' : 'field, e.g. body.text'} value={path} onChange={(event) => setPaths({ ...paths, [source.id]: event.target.value })} />
                    </label>
                    <button type="submit" className="btn btn-small" disabled={!fullPath || !PATH.test(fullPath)}>
                      Insert
                    </button>
                  </form>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};

type TemplateFieldProps = {
  label: string;
  value: string;
  multiline?: boolean;
  placeholder?: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string | undefined;
  sources: readonly DataSource[];
  readOnly: boolean;
  onChange: (value: string) => void;
};

/** A text field that can mix plain text with `{{references}}`; the picker inserts at the caret. */
export const TemplateField = ({ label, value, multiline, placeholder, required, hint, error, sources, readOnly, onChange }: TemplateFieldProps) => {
  const id = useId();
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const caret = useRef<{ start: number; end: number } | undefined>(undefined);
  const remember = () => {
    const element = ref.current;
    if (element) caret.current = { start: element.selectionStart ?? value.length, end: element.selectionEnd ?? value.length };
  };
  const insert = (reference: string) => {
    const { start, end } = caret.current ?? { start: value.length, end: value.length };
    onChange(insertToken(value, reference, start, end));
  };
  const uses = referencesIn(value);
  const common = {
    id,
    ref,
    value,
    placeholder,
    readOnly,
    'aria-invalid': Boolean(error),
    'aria-describedby': hint || error ? `${id}-hint` : undefined,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    onSelect: remember,
    onKeyUp: remember,
    onBlur: remember,
  };
  return (
    <div className="field template-field">
      <div className="field-head">
        <label htmlFor={id}>
          <span className="label">{label}</span>
          {required ? <span className="required"> required</span> : null}
        </label>
        {readOnly ? null : <DataPicker sources={sources} onPick={insert} label={label} />}
      </div>
      {multiline ? <textarea {...common} rows={3} /> : <input type="text" {...common} />}
      {hint || error || uses.length > 0 ? (
        <small id={`${id}-hint`} className={error ? 'error' : undefined}>
          {error ?? (uses.length > 0 ? `Reads ${uses.map((use) => use.replace(/^nodes\./, '').replace('.output', '')).join(', ')}` : hint)}
        </small>
      ) : null}
    </div>
  );
};

type JsonFieldProps = { label: string; value: unknown; error?: string | undefined; readOnly: boolean; sources: readonly DataSource[]; onChange: (value: unknown) => void };

/** JSON edited as text; it is applied when it parses, so half-typed text never reaches the workflow. */
export const JsonField = ({ label, value, error, readOnly, sources, onChange }: JsonFieldProps) => {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<{ start: number; end: number } | undefined>(undefined);
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [parseError, setParseError] = useState<string | undefined>(undefined);
  const lastValue = useRef(value);
  useEffect(() => {
    if (value !== lastValue.current) {
      lastValue.current = value;
      setText(JSON.stringify(value ?? null, null, 2));
      setParseError(undefined);
    }
  }, [value]);
  const update = (next: string) => {
    setText(next);
    try {
      const parsed: unknown = JSON.parse(next);
      setParseError(undefined);
      lastValue.current = parsed;
      onChange(parsed);
    } catch {
      setParseError('Not valid JSON yet. Data goes inside quotes, like "{{trigger.body.text}}".');
    }
  };
  const remember = () => {
    const element = ref.current;
    if (element) caret.current = { start: element.selectionStart, end: element.selectionEnd };
  };
  const insert = (reference: string) => {
    const { start, end } = caret.current ?? { start: text.length, end: text.length };
    update(insertToken(text, reference, start, end));
  };
  return (
    <div className="field template-field">
      <div className="field-head">
        <label htmlFor={id}>
          <span className="label">{label}</span>
        </label>
        {readOnly ? null : <DataPicker sources={sources} onPick={insert} label={label} />}
      </div>
      <textarea
        id={id}
        ref={ref}
        className="code"
        rows={4}
        value={text}
        readOnly={readOnly}
        aria-invalid={Boolean(parseError ?? error)}
        onChange={(event) => update(event.target.value)}
        onSelect={remember}
        onKeyUp={remember}
        onBlur={remember}
      />
      {parseError ?? error ? <small className="error">{parseError ?? error}</small> : <small>JSON. Text in quotes can hold data from earlier steps.</small>}
    </div>
  );
};
