import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import {
  AUTH_TYPES,
  FIELD_TYPES,
  HTTP_METHODS,
  buildManifest,
  emptyField,
  emptyForm,
  emptyRow,
  issuesFor,
  suggestActionKey,
  suggestBody,
  suggestPluginId,
  type CustomApiForm,
  type FieldRow,
  type KeyValueRow,
} from '../../lib/manifest-builder';
import type { AuthType, DataPort, Issue } from '../../lib/types';
import { Faceplate } from '../../components/module';
import { Button, Field, IssueList, JsonBlock } from '../../components/ui';
import { canEdit, messageOf, useResource, useSignedIn } from '../../state/app-state';
import { Link, navigate } from '../../state/navigation';

const AUTH_LABELS: Record<AuthType, string> = {
  none: 'No sign-in',
  api_key: 'API key',
  bearer: 'Bearer token',
  basic: 'Username and password',
  oauth2: 'OAuth 2.0',
};

const firstMessage = (issues: readonly Issue[], path: string) => issues.find((issue) => issue.path === path)?.message;

const KeyValueRows = ({ rows, onChange, keyLabel, valueLabel, keyPlaceholder, valuePlaceholder, addLabel }: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyLabel: string;
  valueLabel: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}) => (
  <div className="rows">
    {rows.map((row, index) => (
      <div key={row.id} className="row row-kv">
        <input
          type="text"
          aria-label={`${keyLabel} ${index + 1}`}
          placeholder={keyPlaceholder}
          value={row.key}
          onChange={(event) => onChange(rows.map((item) => (item.id === row.id ? { ...item, key: event.target.value } : item)))}
        />
        <input
          type="text"
          aria-label={`${valueLabel} ${index + 1}`}
          placeholder={valuePlaceholder}
          value={row.value}
          onChange={(event) => onChange(rows.map((item) => (item.id === row.id ? { ...item, value: event.target.value } : item)))}
        />
        <Button size="small" variant="quiet" aria-label={`Remove ${keyLabel.toLowerCase()} ${index + 1}`} onClick={() => onChange(rows.filter((item) => item.id !== row.id))}>
          Remove
        </Button>
      </div>
    ))}
    <div>
      <Button size="small" onClick={() => onChange([...rows, emptyRow()])}>
        {addLabel}
      </Button>
    </div>
  </div>
);

const FieldRows = ({ rows, onChange, noun }: { rows: FieldRow[]; onChange: (rows: FieldRow[]) => void; noun: 'input' | 'output' }) => {
  const update = (id: string, patch: Partial<FieldRow>) => onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  return (
    <div className="rows">
      {rows.map((row, index) => (
        <div key={row.id} className="row row-field">
          <input type="text" aria-label={`${noun} ${index + 1} name`} placeholder="Name, e.g. prompt" value={row.key} onChange={(event) => update(row.id, { key: event.target.value })} />
          <input type="text" aria-label={`${noun} ${index + 1} label`} placeholder="Label shown in the node" value={row.label} onChange={(event) => update(row.id, { label: event.target.value })} />
          <select aria-label={`${noun} ${index + 1} type`} value={row.type} onChange={(event) => update(row.id, { type: FIELD_TYPES.find((type) => type === event.target.value) ?? 'string' })}>
            {FIELD_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          {noun === 'input' ? (
            <label className="checkbox">
              <input type="checkbox" checked={row.required} onChange={(event) => update(row.id, { required: event.target.checked })} />
              Required
            </label>
          ) : (
            <span />
          )}
          <Button size="small" variant="quiet" aria-label={`Remove ${noun} ${index + 1}`} onClick={() => onChange(rows.filter((item) => item.id !== row.id))}>
            Remove
          </Button>
        </div>
      ))}
      <div>
        <Button size="small" onClick={() => onChange([...rows, emptyField()])}>
          Add {noun}
        </Button>
      </div>
    </div>
  );
};

const Step = ({ title, intro, issues, show, children }: { title: string; intro: string; issues: readonly Issue[]; show: boolean; children: ReactNode }) => (
  <li className="step" data-state={show ? (issues.length > 0 ? 'invalid' : 'done') : undefined}>
    <section className="section" aria-label={title}>
      <h2>{title}</h2>
      <p>{intro}</p>
      {children}
    </section>
  </li>
);

const toPorts = (rows: readonly FieldRow[]): DataPort[] =>
  rows
    .filter((row) => row.key.trim())
    .map((row) => ({ key: row.key.trim(), label: row.label.trim() || row.key.trim(), type: row.type, required: row.required, description: undefined }));

export const CustomApiPage = () => {
  const { api, notify, role, workspace } = useSignedIn();
  const categories = useResource(() => api.categories(), [api]);
  const [form, setForm] = useState<CustomApiForm>(emptyForm);
  const [idEdited, setIdEdited] = useState(false);
  const [keyEdited, setKeyEdited] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const { manifest, issues } = useMemo(() => buildManifest(form), [form]);
  const shown = attempted ? issues : [];
  const set = (patch: Partial<CustomApiForm>) => setForm((current) => ({ ...current, ...patch }));
  const setAction = (patch: Partial<CustomApiForm['action']>) => setForm((current) => ({ ...current, action: { ...current.action, ...patch } }));
  const setAuth = (patch: Partial<CustomApiForm['auth']>) => setForm((current) => ({ ...current, auth: { ...current.auth, ...patch } }));
  const setErrors = (patch: Partial<CustomApiForm['errors']>) => setForm((current) => ({ ...current, errors: { ...current.errors, ...patch } }));

  if (!canEdit(role)) {
    return (
      <div className="empty">
        <h2>Editors add custom APIs</h2>
        <p>Your role in this workspace is viewer. Ask an admin to change it.</p>
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    setServerIssues([]);
    setError(undefined);
    if (issues.length > 0) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setBusy(true);
    try {
      const created = await api.createCustom(manifest);
      notify(`${form.name} created. Connect an account, then run a test to activate it.`);
      navigate(`/integrations/${encodeURIComponent(created.plugin.id)}?tab=${form.auth.type === 'none' ? 'test' : 'connection'}`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.issues.length > 0) setServerIssues(caught.issues);
      else setError(messageOf(caught));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setBusy(false);
    }
  };

  const bodyAllowed = form.action.method !== 'GET' && form.action.method !== 'DELETE';
  const outputNames = form.outputs.map((row) => row.key.trim()).filter(Boolean);

  return (
    <>
      <Link to="/integrations" className="back">
        Applications
      </Link>
      <header className="page-head">
        <div>
          <h1>Add a custom API</h1>
          <p>Describe one request to any HTTPS API. Universal Flow turns it into a module with the inputs and outputs you define.</p>
        </div>
      </header>

      <div className="builder">
        <form onSubmit={submit} noValidate>
          {attempted && issues.length > 0 ? <IssueList issues={issues} title={`Fix ${issues.length === 1 ? 'this' : `these ${issues.length} things`} to continue:`} /> : null}
          <IssueList issues={serverIssues} title="The server could not accept this API:" />
          {error ? (
            <p className="error-text" role="alert">
              {error}
            </p>
          ) : null}
          <ol className="steps">
            <Step title="Application" intro="How it appears in the marketplace list and in workflows." issues={issuesFor(shown, 'name', 'id', 'version', 'provider')} show={attempted}>
              <div className="form-grid">
                <Field label="Name" error={firstMessage(shown, 'name')}>
                  {(props) => (
                    <input
                      {...props}
                      type="text"
                      value={form.name}
                      placeholder="MY CUSTOM AI"
                      onChange={(event) => set({ name: event.target.value, ...(idEdited ? {} : { id: suggestPluginId(event.target.value, workspace.id) }) })}
                    />
                  )}
                </Field>
                <Field label="Provider" error={firstMessage(shown, 'provider')}>
                  {(props) => <input {...props} type="text" value={form.provider} placeholder="Who runs this API" onChange={(event) => set({ provider: event.target.value })} />}
                </Field>
                <Field label="Category">
                  {(props) => (
                    <select {...props} value={form.category} onChange={(event) => set({ category: event.target.value })}>
                      {(categories.data ?? [{ slug: 'custom-api', name: 'Custom API' }]).map((category) => (
                        <option key={category.slug} value={category.slug}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label="Plugin ID" hint="Stays the same across versions." error={firstMessage(shown, 'id')}>
                  {(props) => (
                    <input
                      {...props}
                      type="text"
                      value={form.id}
                      spellCheck={false}
                      onChange={(event) => {
                        setIdEdited(true);
                        set({ id: event.target.value });
                      }}
                    />
                  )}
                </Field>
                <Field label="Version" error={firstMessage(shown, 'version')}>
                  {(props) => <input {...props} type="text" value={form.version} onChange={(event) => set({ version: event.target.value })} />}
                </Field>
              </div>
              <Field label="Description (optional)">
                {(props) => <textarea {...props} rows={2} value={form.description} onChange={(event) => set({ description: event.target.value })} />}
              </Field>
            </Step>

            <Step title="Authentication" intro="How Universal Flow proves who it is. The secret itself is entered later, when you connect an account." issues={issuesFor(shown, 'auth')} show={attempted}>
              <div className="form-grid">
                <Field label="Authentication type">
                  {(props) => (
                    <select {...props} value={form.auth.type} onChange={(event) => setAuth({ type: AUTH_TYPES.find((type) => type === event.target.value) ?? 'none' })}>
                      {AUTH_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {AUTH_LABELS[type]}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                {form.auth.type === 'api_key' ? (
                  <>
                    <Field label="Send the key in">
                      {(props) => (
                        <select {...props} value={form.auth.apiKeyIn} onChange={(event) => setAuth({ apiKeyIn: event.target.value === 'query' ? 'query' : 'header' })}>
                          <option value="header">A header</option>
                          <option value="query">A query parameter</option>
                        </select>
                      )}
                    </Field>
                    <Field label={form.auth.apiKeyIn === 'header' ? 'Header name' : 'Parameter name'} error={firstMessage(shown, 'auth.apiKeyName')}>
                      {(props) => <input {...props} type="text" value={form.auth.apiKeyName} onChange={(event) => setAuth({ apiKeyName: event.target.value })} />}
                    </Field>
                  </>
                ) : null}
              </div>
              {form.auth.type === 'oauth2' ? (
                <div className="form-grid">
                  <Field label="Authorization URL" error={firstMessage(shown, 'auth.authorizationUrl')}>
                    {(props) => <input {...props} type="url" value={form.auth.authorizationUrl} placeholder="https://provider.com/oauth/authorize" onChange={(event) => setAuth({ authorizationUrl: event.target.value })} />}
                  </Field>
                  <Field label="Token URL" error={firstMessage(shown, 'auth.tokenUrl')}>
                    {(props) => <input {...props} type="url" value={form.auth.tokenUrl} placeholder="https://provider.com/oauth/token" onChange={(event) => setAuth({ tokenUrl: event.target.value })} />}
                  </Field>
                  <Field label="Scopes" hint="Separate with spaces or commas.">
                    {(props) => <input {...props} type="text" value={form.auth.scopes} onChange={(event) => setAuth({ scopes: event.target.value })} />}
                  </Field>
                </div>
              ) : null}
            </Step>

            <Step
              title="Request"
              intro="Where the request goes. Use {{input.name}} anywhere to insert a value from the node's inputs."
              issues={issuesFor(shown, 'action', 'baseUrl')}
              show={attempted}
            >
              <div className="form-grid">
                <Field label="What it does" hint="Shown on the node, e.g. Generate text." error={firstMessage(shown, 'action.name')}>
                  {(props) => (
                    <input
                      {...props}
                      type="text"
                      value={form.action.name}
                      onChange={(event) => setAction({ name: event.target.value, ...(keyEdited ? {} : { key: suggestActionKey(event.target.value) }) })}
                    />
                  )}
                </Field>
                <Field label="Action key" error={firstMessage(shown, 'action.key')}>
                  {(props) => (
                    <input
                      {...props}
                      type="text"
                      spellCheck={false}
                      value={form.action.key}
                      onChange={(event) => {
                        setKeyEdited(true);
                        setAction({ key: event.target.value });
                      }}
                    />
                  )}
                </Field>
              </div>
              <div className="form-grid">
                <Field label="Base URL" error={firstMessage(shown, 'baseUrl')}>
                  {(props) => <input {...props} type="url" value={form.baseUrl} spellCheck={false} onChange={(event) => set({ baseUrl: event.target.value })} />}
                </Field>
                <Field label="Method">
                  {(props) => (
                    <select {...props} value={form.action.method} onChange={(event) => setAction({ method: HTTP_METHODS.find((method) => method === event.target.value) ?? 'POST' })}>
                      {HTTP_METHODS.map((method) => (
                        <option key={method} value={method}>
                          {method}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label="Endpoint" hint="Added to the base URL." error={firstMessage(shown, 'action.path')}>
                  {(props) => <input {...props} type="text" spellCheck={false} value={form.action.path} placeholder="/v1/generate" onChange={(event) => setAction({ path: event.target.value })} />}
                </Field>
              </div>
              <div className="field">
                <span className="label">Headers</span>
                <KeyValueRows
                  rows={form.action.headers}
                  onChange={(headers) => setAction({ headers })}
                  keyLabel="Header"
                  valueLabel="Header value"
                  keyPlaceholder="Header name"
                  valuePlaceholder="Value"
                  addLabel="Add header"
                />
              </div>
              <div className="field">
                <span className="label">Query parameters</span>
                <KeyValueRows
                  rows={form.action.query}
                  onChange={(query) => setAction({ query })}
                  keyLabel="Parameter"
                  valueLabel="Parameter value"
                  keyPlaceholder="Name"
                  valuePlaceholder="Value or {{input.name}}"
                  addLabel="Add parameter"
                />
              </div>
              {bodyAllowed ? (
                <Field label="Request body (JSON)" error={firstMessage(shown, 'action.body')} hint="Leave empty to send no body.">
                  {(props) => <textarea {...props} className="code" rows={6} spellCheck={false} value={form.action.body} onChange={(event) => setAction({ body: event.target.value })} />}
                </Field>
              ) : null}
              {bodyAllowed && form.inputs.some((row) => row.key.trim()) ? (
                <div>
                  <Button size="small" onClick={() => setAction({ body: suggestBody(form.inputs) })}>
                    Fill the body from the inputs
                  </Button>
                </div>
              ) : null}
            </Step>

            <Step
              title="Inputs and outputs"
              intro="Inputs become the node's left jacks and its settings form; outputs are the right jacks other nodes can read."
              issues={issuesFor(shown, 'inputs', 'outputs', 'responseMapping')}
              show={attempted}
            >
              <div className="field">
                <span className="label">Inputs</span>
                <FieldRows rows={form.inputs} onChange={(inputs) => set({ inputs })} noun="input" />
              </div>
              <div className="field">
                <span className="label">Outputs</span>
                <FieldRows rows={form.outputs} onChange={(outputs) => set({ outputs })} noun="output" />
              </div>
              <div className="field">
                <span className="label">Response mapping</span>
                <small>Where each output is found in the response, as a JSON path such as $.choices[0].text. Without a mapping, the whole response is the output.</small>
                <KeyValueRows
                  rows={form.responseMapping}
                  onChange={(responseMapping) => set({ responseMapping })}
                  keyLabel="Output"
                  valueLabel="JSON path"
                  keyPlaceholder={outputNames[0] ?? 'Output name'}
                  valuePlaceholder="$.data.result"
                  addLabel="Add mapping"
                />
              </div>
            </Step>

            <Step title="Errors and limits" intro="When to try again, and what the API cannot do." issues={issuesFor(shown, 'errors')} show={attempted}>
              <div className="form-grid">
                <Field label="Retry on these status codes" error={firstMessage(shown, 'errors.retryOnStatus')} hint="Workflows retry these with growing pauses.">
                  {(props) => <input {...props} type="text" value={form.errors.retryOnStatus} onChange={(event) => setErrors({ retryOnStatus: event.target.value })} />}
                </Field>
                <Field label="Timeout in seconds" error={firstMessage(shown, 'errors.timeoutSeconds')}>
                  {(props) => <input {...props} type="number" min={1} max={120} value={form.errors.timeoutSeconds} onChange={(event) => setErrors({ timeoutSeconds: event.target.value })} />}
                </Field>
              </div>
              <Field label="Limitations (optional)" hint="One per line, e.g. 60 requests per minute. Shown to everyone who uses this module.">
                {(props) => <textarea {...props} rows={3} value={form.limitations} onChange={(event) => set({ limitations: event.target.value })} />}
              </Field>
              <div className="actions">
                <Button type="submit" variant="primary" disabled={busy}>
                  {busy ? 'Creating…' : 'Create integration'}
                </Button>
                <Link to="/integrations" className="btn">
                  Cancel
                </Link>
              </div>
            </Step>
          </ol>
        </form>

        <aside className="builder-preview" aria-label="Preview">
          <Faceplate
            title={form.name}
            subtitle={form.action.name}
            category={form.category}
            inputs={toPorts(form.inputs)}
            outputs={toPorts(form.outputs)}
            footer={
              <>
                <span>{AUTH_LABELS[form.auth.type]}</span>
                <span>{form.action.method}</span>
              </>
            }
          />
          <p className="hint">After you create it, connect an account and run one test. It becomes active once the test passes.</p>
          <details className="manifest-json">
            <summary>Manifest JSON</summary>
            <JsonBlock value={manifest} />
          </details>
        </aside>
      </div>
    </>
  );
};
