import { useState, type ReactNode } from 'react';
import type { DataLink, DataSource } from '../../lib/studio/data';
import { CRON_PRESETS, COMPARISON_OPS, DELAY_UNITS, describeCron, isCondition, opNeedsRight, opWords, splitDelay } from '../../lib/studio/describe';
import { approvalMessage, formatDuration, nodeRunView } from '../../lib/studio/execution';
import { DEFAULT_PORT, flowOutputsOf, parsePluginRef, wouldCreateCycle, type ResolvedDefinition } from '../../lib/studio/graph';
import type { StudioIssue } from '../../lib/studio/issues';
import { flowLabel } from '../../lib/studio/layout';
import { relativeDate } from '../../lib/presentation';
import type {
  ActionNode,
  Comparison,
  ComparisonOp,
  ConditionNode,
  ConfigField,
  Credential,
  LiveSchedule,
  LiveWebhook,
  NodeRun,
  StepRecord,
  TransformNode,
  TriggerNode,
  WorkflowGraph,
  WorkflowNode,
} from '../../lib/types';
import { Button, JsonBlock } from '../../components/ui';
import { Link } from '../../state/navigation';
import { JsonField, TemplateField } from './fields';
import { Icon } from './icons';

const Section = ({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) => (
  <section className="insp-section">
    <div className="insp-section-head">
      <h3>{title}</h3>
      {actions}
    </div>
    {children}
  </section>
);

const IssueNotes = ({ issues }: { issues: readonly StudioIssue[] }) =>
  issues.length === 0 ? null : (
    <ul className="insp-issues">
      {issues.map((issue, index) => (
        <li key={`${issue.message}-${index}`} data-severity={issue.severity}>
          {issue.message}
        </li>
      ))}
    </ul>
  );

const fieldError = (issues: readonly StudioIssue[], field: string) => issues.find((issue) => issue.field === field)?.message;

/* ---------- Inputs of an action, from the module's config fields ---------- */

const textOf = (value: unknown): string => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value));

const InputField = ({
  field,
  value,
  issues,
  sources,
  readOnly,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  issues: readonly StudioIssue[];
  sources: readonly DataSource[];
  readOnly: boolean;
  onChange: (value: unknown) => void;
}) => {
  const error = fieldError(issues, field.key);
  switch (field.widget) {
    case 'toggle':
      return (
        <label className="checkbox insp-toggle">
          <input type="checkbox" checked={value === true} disabled={readOnly} onChange={(event) => onChange(event.target.checked)} />
          {field.label}
        </label>
      );
    case 'select':
      return (
        <div className="field">
          <label>
            <span className="label">{field.label}</span>
            <select value={textOf(value)} disabled={readOnly} onChange={(event) => onChange(field.options?.find((option) => String(option) === event.target.value) ?? event.target.value)}>
              <option value="">Choose…</option>
              {(field.options ?? []).map((option) => (
                <option key={String(option)} value={String(option)}>
                  {String(option)}
                </option>
              ))}
            </select>
          </label>
          {error ? <small className="error">{error}</small> : null}
        </div>
      );
    case 'json':
      return <JsonField label={field.label} value={value ?? (field.key === 'row' ? [] : {})} error={error} readOnly={readOnly} sources={sources} onChange={onChange} />;
    case 'number':
      return (
        <TemplateField
          label={field.label}
          value={textOf(value)}
          required={field.required}
          hint={field.description ?? 'A number, or data from an earlier step'}
          error={error}
          sources={sources}
          readOnly={readOnly}
          onChange={(text) => onChange(/^-?\d+(\.\d+)?$/.test(text.trim()) ? Number(text) : text)}
        />
      );
    case 'text':
    case 'textarea':
      return (
        <TemplateField
          label={field.label}
          value={textOf(value)}
          multiline={field.widget === 'textarea' || textOf(value).length > 40 || textOf(value).includes('\n')}
          required={field.required}
          hint={field.description}
          error={error}
          sources={sources}
          readOnly={readOnly}
          onChange={onChange}
        />
      );
  }
};

/* ---------- Per kind ---------- */

type EditorProps<T extends WorkflowNode> = {
  node: T;
  issues: readonly StudioIssue[];
  sources: readonly DataSource[];
  readOnly: boolean;
  onChange: (node: T, field: string) => void;
};

const TIME_ZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Singapore', 'Europe/London', 'America/New_York'];
  }
})();
const LOCAL_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
})();

const TriggerEditor = ({
  node,
  issues,
  readOnly,
  onChange,
  webhook,
  schedule,
  canSeeSecrets,
  onRevealSecret,
}: EditorProps<TriggerNode> & { webhook: LiveWebhook | undefined; schedule: LiveSchedule | undefined; canSeeSecrets: boolean; onRevealSecret: () => Promise<string | undefined> }) => {
  const [secret, setSecret] = useState<string | undefined>(undefined);
  if (node.trigger === 'plugin') {
    return (
      <Section title="Trigger">
        <p className="hint">Started by the module when its event happens.</p>
      </Section>
    );
  }
  const setType = (trigger: TriggerNode['trigger']) => {
    const { schedule: _schedule, timezone: _timezone, ...rest } = node;
    onChange(trigger === 'schedule' ? { ...rest, trigger, schedule: node.schedule ?? '0 9 * * 1-5', timezone: node.timezone ?? LOCAL_ZONE } : { ...rest, trigger }, 'trigger');
  };
  return (
    <Section title="Starts">
      <div className="segmented segmented-wide" role="radiogroup" aria-label="How this workflow starts">
        {(['manual', 'webhook', 'schedule'] as const).map((type) => (
          <button key={type} type="button" role="radio" aria-checked={node.trigger === type} disabled={readOnly} onClick={() => setType(type)}>
            {{ manual: 'By hand', webhook: 'Webhook', schedule: 'Schedule' }[type]}
          </button>
        ))}
      </div>
      {node.trigger === 'manual' ? <p className="hint">Use Run in the toolbar. You can send a test payload with it.</p> : null}
      {node.trigger === 'webhook' ? (
        <div className="insp-live">
          {webhook ? (
            <>
              <p>Send a POST request here. Sign it with the secret (HMAC headers), or send the secret in x-uf-webhook-token. For a Telegram bot, register this address with setWebhook and use the secret as secret_token.</p>
              <code className="copyable">{webhook.url}</code>
              {canSeeSecrets ? (
                secret ? (
                  <>
                    <p className="hint">Signing secret. It is shown here only; Universal Flow keeps it encrypted.</p>
                    <code className="copyable">{secret}</code>
                  </>
                ) : (
                  <Button size="small" onClick={() => void onRevealSecret().then(setSecret)}>
                    Show signing secret
                  </Button>
                )
              ) : null}
            </>
          ) : (
            <p className="hint">The address appears here once the workflow is live.</p>
          )}
        </div>
      ) : null}
      {node.trigger === 'schedule' ? (
        <>
          <TemplateField
            label="Schedule (cron)"
            value={node.schedule ?? ''}
            placeholder="0 9 * * 1-5"
            hint={node.schedule ? describeCron(node.schedule) : 'Minute, hour, day, month, weekday'}
            error={fieldError(issues, 'schedule')}
            sources={[]}
            readOnly={readOnly}
            onChange={(schedule) => onChange({ ...node, schedule }, 'schedule')}
          />
          <div className="chips" role="group" aria-label="Common schedules">
            {CRON_PRESETS.map((preset) => (
              <button key={preset.cron} type="button" className="chip" aria-pressed={node.schedule === preset.cron} disabled={readOnly} onClick={() => onChange({ ...node, schedule: preset.cron }, 'schedule')}>
                {preset.label}
              </button>
            ))}
          </div>
          <div className="field">
            <label>
              <span className="label">Time zone</span>
              <select value={node.timezone ?? 'UTC'} disabled={readOnly} onChange={(event) => onChange({ ...node, timezone: event.target.value }, 'timezone')}>
                {[...new Set(['UTC', LOCAL_ZONE, ...TIME_ZONES])].map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {schedule ? <p className="hint">Next run {new Date(schedule.nextRunAt).toLocaleString()}.</p> : <p className="hint">Runs start once the workflow is live.</p>}
        </>
      ) : null}
    </Section>
  );
};

const ActionEditor = ({
  node,
  resolved,
  issues,
  sources,
  readOnly,
  credentials,
  onChange,
  onRepin,
}: EditorProps<ActionNode> & { resolved: ResolvedDefinition; credentials: readonly Credential[]; onRepin: () => void }) => {
  const { definition } = resolved;
  const pluginId = parsePluginRef(node.plugin)?.pluginId ?? node.plugin;
  const own = credentials.filter((credential) => credential.pluginId === pluginId);
  const fields = definition.configFields.length > 0 ? definition.configFields : Object.keys(node.input).map((key): ConfigField => ({ key, label: key, widget: 'text', required: false, options: undefined, defaultValue: undefined, description: undefined }));
  const attempts = node.retry?.maxAttempts ?? 1;
  return (
    <>
      <Section title="Module">
        <p className="insp-module">
          <span>{definition.title}</span>
          <code>{node.plugin}</code>
        </p>
        {resolved.status === 'missing' ? (
          <div className="notice">
            <p>This module is not installed in this workspace, so the step cannot run.</p>
            <div className="actions">
              <Link to={`/marketplace/${encodeURIComponent(pluginId)}`} className="btn btn-small">
                Find it in the Marketplace
              </Link>
            </div>
          </div>
        ) : null}
        {resolved.status === 'other-version' ? (
          <div className="notice">
            <p>
              The workflow uses version {resolved.pinned}; version {resolved.installed} is installed. Saved workflows keep their version until you move them.
            </p>
            {readOnly ? null : (
              <div className="actions">
                <Button size="small" onClick={onRepin}>
                  Use version {resolved.installed}
                </Button>
              </div>
            )}
          </div>
        ) : null}
        {definition.limitations.length > 0 ? (
          <div className="insp-limits">
            <h4>Limits of this module</h4>
            <ul>
              {definition.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>
      {definition.auth.required ? (
        <Section title="Account">
          <div className="field">
            <label>
              <span className="label">Account used by this step</span>
              <select
                value={node.credentialId ?? ''}
                disabled={readOnly}
                aria-invalid={Boolean(fieldError(issues, 'credentialId'))}
                onChange={(event) => {
                  const { credentialId: _old, ...rest } = node;
                  onChange(event.target.value ? { ...rest, credentialId: event.target.value } : rest, 'credentialId');
                }}
              >
                <option value="">Choose an account…</option>
                {own.map((credential) => (
                  <option key={credential.id} value={credential.id}>
                    {credential.authType === 'oauth2' ? 'Signed-in account' : 'Saved key'}, connected {relativeDate(credential.createdAt, Date.now())}
                    {credential.status === 'connected' ? '' : ` (${credential.status})`}
                  </option>
                ))}
              </select>
            </label>
            {fieldError(issues, 'credentialId') ? <small className="error">{fieldError(issues, 'credentialId')}</small> : <small>The key stays on the server; the workflow only stores which account to use.</small>}
          </div>
          <Link to={`/integrations/${encodeURIComponent(pluginId)}`} className="btn btn-small">
            {own.length === 0 ? 'Connect an account' : 'Manage accounts'}
          </Link>
        </Section>
      ) : null}
      <Section title="Inputs">
        {fields.length === 0 ? <p className="hint">This action takes no input.</p> : null}
        {fields.map((field) => (
          <InputField
            key={field.key}
            field={field}
            value={node.input[field.key]}
            issues={issues}
            sources={sources}
            readOnly={readOnly}
            onChange={(value) => onChange({ ...node, input: { ...node.input, [field.key]: value } }, `input.${field.key}`)}
          />
        ))}
      </Section>
      <Section title="When it fails">
        <div className="form-row">
          <div className="field">
            <label>
              <span className="label">Attempts</span>
              <input
                type="number"
                min={1}
                max={10}
                value={attempts}
                disabled={readOnly}
                onChange={(event) => {
                  const maxAttempts = Math.round(Number(event.target.value));
                  const { retry: _retry, ...rest } = node;
                  onChange(maxAttempts > 1 ? { ...rest, retry: { maxAttempts, backoffMs: node.retry?.backoffMs ?? 2000, factor: 2 } } : rest, 'retry');
                }}
              />
            </label>
          </div>
          <div className="field">
            <label>
              <span className="label">First wait (s)</span>
              <input
                type="number"
                min={0}
                step={0.5}
                value={(node.retry?.backoffMs ?? 2000) / 1000}
                disabled={readOnly || attempts <= 1}
                onChange={(event) => node.retry && onChange({ ...node, retry: { ...node.retry, backoffMs: Math.max(0, Number(event.target.value) * 1000) } }, 'retry')}
              />
            </label>
          </div>
        </div>
        <p className="hint">Only temporary failures are tried again (timeouts, rate limits, server errors). Waits double each time.</p>
        <label className="checkbox insp-toggle">
          <input
            type="checkbox"
            checked={node.continueOnError === true}
            disabled={readOnly}
            onChange={(event) => {
              const { continueOnError: _flag, ...rest } = node;
              onChange(event.target.checked ? { ...rest, continueOnError: true } : rest, 'continueOnError');
            }}
          />
          Carry on with the next step if it still fails
        </label>
        <p className="hint">Or patch the Error jack into another step to handle the failure there.</p>
      </Section>
    </>
  );
};

const comparisonsOf = (node: ConditionNode): { mode: 'all' | 'any'; rows: Comparison[] } | undefined => {
  const { when } = node;
  if ('op' in when) return { mode: 'all', rows: [when] };
  if ('all' in when && when.all.every((item) => 'op' in item)) return { mode: 'all', rows: when.all.filter((item): item is Comparison => 'op' in item) };
  if ('any' in when && when.any.every((item) => 'op' in item)) return { mode: 'any', rows: when.any.filter((item): item is Comparison => 'op' in item) };
  return undefined;
};

const isOp = (value: string): value is ComparisonOp => COMPARISON_OPS.some((op) => op === value);

const ConditionEditor = ({ node, sources, readOnly, onChange }: EditorProps<ConditionNode>) => {
  const simple = comparisonsOf(node);
  if (!simple) {
    return (
      <Section title="Condition">
        <JsonField label="Condition (advanced)" value={node.when} readOnly={readOnly} sources={sources} onChange={(when) => (isCondition(when) ? onChange({ ...node, when }, 'when') : undefined)} />
      </Section>
    );
  }
  const save = (rows: Comparison[], mode = simple.mode) => {
    const [only] = rows;
    onChange({ ...node, when: rows.length === 1 && only ? only : mode === 'all' ? { all: rows } : { any: rows } }, 'when');
  };
  const setRow = (index: number, row: Comparison) => save(simple.rows.map((existing, position) => (position === index ? row : existing)));
  return (
    <Section title="Condition">
      {simple.rows.length > 1 ? (
        <div className="segmented segmented-wide" role="radiogroup" aria-label="Combine checks">
          <button type="button" role="radio" aria-checked={simple.mode === 'all'} disabled={readOnly} onClick={() => save(simple.rows, 'all')}>
            All must hold
          </button>
          <button type="button" role="radio" aria-checked={simple.mode === 'any'} disabled={readOnly} onClick={() => save(simple.rows, 'any')}>
            Any may hold
          </button>
        </div>
      ) : null}
      {simple.rows.map((row, index) => (
        <div key={index} className="condition-row">
          <TemplateField label={`Value ${index + 1}`} value={textOf(row.left)} sources={sources} readOnly={readOnly} placeholder="Insert data" onChange={(left) => setRow(index, { ...row, left })} />
          <div className="field">
            <label>
              <span className="label">Check</span>
              <select
                value={row.op}
                disabled={readOnly}
                onChange={(event) => {
                  if (!isOp(event.target.value)) return;
                  const op = event.target.value;
                  setRow(index, opNeedsRight(op) ? { ...row, op, right: row.right ?? '' } : { op, left: row.left });
                }}
              >
                {COMPARISON_OPS.map((op) => (
                  <option key={op} value={op}>
                    {opWords(op)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {opNeedsRight(row.op) ? (
            <TemplateField label="Compared with" value={textOf(row.right)} sources={sources} readOnly={readOnly} onChange={(text) => setRow(index, { ...row, right: /^-?\d+(\.\d+)?$/.test(text.trim()) ? Number(text) : text })} />
          ) : null}
          {simple.rows.length > 1 && !readOnly ? (
            <Button size="small" variant="quiet" onClick={() => save(simple.rows.filter((_, position) => position !== index))}>
              Remove check
            </Button>
          ) : null}
        </div>
      ))}
      {readOnly ? null : (
        <Button size="small" onClick={() => save([...simple.rows, { op: 'eq', left: '', right: '' }])}>
          Add a check
        </Button>
      )}
      <p className="hint">The step continues on True or False. Numbers compare as numbers.</p>
    </Section>
  );
};

const TransformEditor = ({ node, sources, readOnly, onChange }: EditorProps<TransformNode>) => {
  const entries = Object.entries(node.output);
  const rename = (from: string, to: string) => {
    if (!to || to === from || to in node.output) return;
    onChange({ ...node, output: Object.fromEntries(entries.map(([key, value]) => [key === from ? to : key, value])) }, `rename.${from}`);
  };
  return (
    <Section title="Fields it builds">
      {entries.length === 0 ? <p className="hint">Add fields; each becomes an output jack later steps can read.</p> : null}
      {entries.map(([key, value]) => (
        <div key={key} className="transform-row">
          <div className="field">
            <label>
              <span className="label">Name</span>
              <input type="text" defaultValue={key} readOnly={readOnly} onBlur={(event) => rename(key, event.currentTarget.value.trim())} />
            </label>
          </div>
          <TemplateField label="Value" value={textOf(value)} sources={sources} readOnly={readOnly} onChange={(text) => onChange({ ...node, output: { ...node.output, [key]: text } }, `output.${key}`)} />
          {readOnly ? null : (
            <Button
              size="small"
              variant="quiet"
              onClick={() => {
                const { [key]: _removed, ...output } = node.output;
                onChange({ ...node, output }, 'output');
              }}
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      {readOnly ? null : (
        <Button
          size="small"
          onClick={() => {
            let index = entries.length + 1;
            while (`field${index}` in node.output) index += 1;
            onChange({ ...node, output: { ...node.output, [`field${index}`]: '' } }, 'output');
          }}
        >
          Add a field
        </Button>
      )}
    </Section>
  );
};

/* ---------- Connections, as a keyboard-friendly alternative to cables ---------- */

const Connections = ({
  node,
  graph,
  titles,
  readOnly,
  onConnect,
  onRemoveEdge,
}: {
  node: WorkflowNode;
  graph: WorkflowGraph;
  titles: ReadonlyMap<string, string>;
  readOnly: boolean;
  onConnect: (port: string, to: string) => void;
  onRemoveEdge: (edgeId: string) => void;
}) => {
  const ports = flowOutputsOf(node);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const incoming = graph.edges.filter((edge) => edge.to === node.id);
  return (
    <Section title="Connections">
      {node.kind === 'trigger' ? null : (
        <p className="hint">
          {incoming.length === 0 ? 'Nothing runs this step yet.' : `Runs after ${incoming.map((edge) => `${titles.get(edge.from) ?? edge.from} (${flowLabel(edge.port ?? DEFAULT_PORT)})`).join(', ')}.`}
        </p>
      )}
      {ports.map((port) => {
        const out = graph.edges.filter((edge) => edge.from === node.id && (edge.port ?? DEFAULT_PORT) === port);
        const candidates = graph.nodes.filter((target) => target.id !== node.id && target.kind !== 'trigger' && !out.some((edge) => edge.to === target.id) && !wouldCreateCycle(graph, node.id, target.id));
        return (
          <div key={port} className="connection-port">
            <h4>{flowLabel(port)}</h4>
            <ul className="plain-list">
              {out.map((edge) => (
                <li key={edge.id}>
                  <span>{titles.get(edge.to) ?? edge.to}</span>
                  {readOnly ? null : (
                    <Button size="small" variant="quiet" onClick={() => onRemoveEdge(edge.id)} aria-label={`Disconnect ${flowLabel(port)} from ${titles.get(edge.to) ?? edge.to}`}>
                      Disconnect
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {readOnly || candidates.length === 0 ? null : (
              <div className="connection-add">
                <label>
                  <span className="visually-hidden">Connect {flowLabel(port)} to</span>
                  <select value={choice[port] ?? ''} onChange={(event) => setChoice({ ...choice, [port]: event.target.value })}>
                    <option value="">Connect to…</option>
                    {candidates.map((target) => (
                      <option key={target.id} value={target.id}>
                        {titles.get(target.id) ?? target.id}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  size="small"
                  disabled={!choice[port]}
                  onClick={() => {
                    const target = choice[port];
                    if (target) onConnect(port, target);
                    setChoice({ ...choice, [port]: '' });
                  }}
                >
                  Connect
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </Section>
  );
};

/* ---------- The selected step in the run being shown ---------- */

export type RunContext = {
  executionId: string;
  run: NodeRun | undefined;
  steps: StepRecord[];
  canDecide: boolean;
  onDecide: (approved: boolean, comment: string) => Promise<void>;
};

const RunSection = ({ context }: { context: RunContext }) => {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const view = nodeRunView(context.run);
  const last = context.steps.at(-1);
  const waiting = context.run?.status === 'waiting' && context.run.waitingFor === 'approval';
  const decide = async (approved: boolean) => {
    setBusy(true);
    try {
      await context.onDecide(approved, comment);
    } finally {
      setBusy(false);
    }
  };
  if (!view && !last) {
    return (
      <Section title="In this run">
        <p className="hint">This step has not run.</p>
      </Section>
    );
  }
  return (
    <Section title="In this run">
      {view ? (
        <p className="lamp" data-tone={view.tone === 'running' || view.tone === 'waiting' ? 'attention' : view.tone}>
          {view.label}
        </p>
      ) : null}
      {waiting ? (
        <div className="approval-box">
          <p className="approval-message">{approvalMessage(context.run) ?? 'Approve to continue.'}</p>
          {context.canDecide ? (
            <>
              <div className="field">
                <label>
                  <span className="label">Note (optional)</span>
                  <textarea rows={2} value={comment} onChange={(event) => setComment(event.target.value)} />
                </label>
              </div>
              <div className="actions">
                <Button variant="primary" disabled={busy} onClick={() => void decide(true)}>
                  Approve
                </Button>
                <Button variant="danger" disabled={busy} onClick={() => void decide(false)}>
                  Reject
                </Button>
              </div>
            </>
          ) : (
            <p className="hint">An editor of this workspace decides.</p>
          )}
        </div>
      ) : null}
      {context.steps.length > 1 ? <p className="hint">{context.steps.length} records (attempts or loop rounds). The last one:</p> : null}
      {last ? (
        <dl className="run-facts">
          <dt>Attempt</dt>
          <dd>{last.attempt}</dd>
          <dt>Took</dt>
          <dd>{formatDuration(last.durationMs)}</dd>
          {last.port ? (
            <>
              <dt>Left by</dt>
              <dd>{flowLabel(last.port)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {last?.error ? <p className="error-text">{last.error.message}</p> : null}
      {last?.input !== undefined ? (
        <details>
          <summary>Input it received</summary>
          <JsonBlock value={last.input} />
        </details>
      ) : null}
      {last?.output !== undefined ? (
        <details open>
          <summary>Output</summary>
          <JsonBlock value={last.output} />
        </details>
      ) : null}
    </Section>
  );
};

/* ---------- The inspector ---------- */

export type NodeInspectorProps = {
  node: WorkflowNode;
  resolved: ResolvedDefinition;
  title: string;
  icon: string;
  color: string;
  issues: readonly StudioIssue[];
  credentials: readonly Credential[];
  sources: readonly DataSource[];
  graph: WorkflowGraph;
  titles: ReadonlyMap<string, string>;
  readOnly: boolean;
  webhook: LiveWebhook | undefined;
  schedule: LiveSchedule | undefined;
  canSeeSecrets: boolean;
  run: RunContext | undefined;
  onRevealSecret: () => Promise<string | undefined>;
  onChange: (node: WorkflowNode, group: string) => void;
  onConnect: (port: string, to: string) => void;
  onRemoveEdge: (edgeId: string) => void;
  onDelete: () => void;
  onOpenLoop: () => void;
  onRepin: () => void;
};

const KIND_LABELS: Record<WorkflowNode['kind'], string> = {
  trigger: 'Trigger',
  action: 'Action',
  condition: 'Condition',
  loop: 'Loop',
  delay: 'Delay',
  approval: 'User approval',
  transform: 'Transform',
};

export const NodeInspector = (props: NodeInspectorProps) => {
  const { node, issues, sources, readOnly } = props;
  const change = <T extends WorkflowNode>(next: T, field: string) => props.onChange(next, `${node.id}:${field}`);
  const general = issues.filter((issue) => !issue.field);
  return (
    <div className="inspector-body" key={node.id}>
      <header className="insp-head" style={{ ['--module-color' as string]: props.color }}>
        <span className="palette-icon" aria-hidden="true">
          <Icon name={props.icon} size={18} />
        </span>
        <div>
          <h2>{props.title}</h2>
          <p>
            {KIND_LABELS[node.kind]}, id <code>{node.id}</code>
          </p>
        </div>
      </header>
      <IssueNotes issues={general} />
      {props.run ? <RunSection context={props.run} /> : null}
      <Section title="Step">
        <div className="field">
          <label>
            <span className="label">Name on the board</span>
            <input type="text" value={node.name ?? ''} placeholder={props.title} readOnly={readOnly} onChange={(event) => change({ ...node, name: event.target.value }, 'name')} />
          </label>
          <small>
            Later steps read its output as <code>{`{{nodes.${node.id}.output…}}`}</code>.
          </small>
        </div>
      </Section>
      {node.kind === 'trigger' ? (
        <TriggerEditor node={node} issues={issues} sources={sources} readOnly={readOnly} onChange={change} webhook={props.webhook} schedule={props.schedule} canSeeSecrets={props.canSeeSecrets} onRevealSecret={props.onRevealSecret} />
      ) : null}
      {node.kind === 'action' ? <ActionEditor node={node} resolved={props.resolved} issues={issues} sources={sources} readOnly={readOnly} credentials={props.credentials} onChange={change} onRepin={props.onRepin} /> : null}
      {node.kind === 'condition' ? <ConditionEditor node={node} issues={issues} sources={sources} readOnly={readOnly} onChange={change} /> : null}
      {node.kind === 'transform' ? <TransformEditor node={node} issues={issues} sources={sources} readOnly={readOnly} onChange={change} /> : null}
      {node.kind === 'approval' ? (
        <Section title="Approval">
          <TemplateField
            label="Message for the approver"
            value={node.message}
            multiline
            sources={sources}
            readOnly={readOnly}
            hint="Shown with Approve and Reject. Approved and Rejected each have a jack."
            onChange={(message) => change({ ...node, message }, 'message')}
          />
        </Section>
      ) : null}
      {node.kind === 'delay' ? (
        <Section title="Wait">
          <div className="form-row">
            <div className="field">
              <label>
                <span className="label">For</span>
                <input
                  type="number"
                  min={0}
                  value={splitDelay(node.ms).amount}
                  disabled={readOnly}
                  aria-invalid={Boolean(fieldError(issues, 'ms'))}
                  onChange={(event) => change({ ...node, ms: Math.max(0, Math.round(Number(event.target.value) * splitDelay(node.ms).unit.ms)) }, 'ms')}
                />
              </label>
            </div>
            <div className="field">
              <label>
                <span className="label">Unit</span>
                <select
                  value={splitDelay(node.ms).unit.key}
                  disabled={readOnly}
                  onChange={(event) => {
                    const unit = DELAY_UNITS.find((candidate) => candidate.key === event.target.value);
                    if (unit) change({ ...node, ms: Math.max(1, splitDelay(node.ms).amount) * unit.ms }, 'ms');
                  }}
                >
                  {DELAY_UNITS.map((unit) => (
                    <option key={unit.key} value={unit.key}>
                      {unit.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <p className="hint">Waits longer than 10 seconds are kept on the server and resumed on time, even after a restart.</p>
        </Section>
      ) : null}
      {node.kind === 'loop' ? (
        <Section title="Loop">
          <TemplateField
            label="List to go through"
            value={node.items}
            sources={sources}
            readOnly={readOnly}
            error={fieldError(issues, 'items')}
            hint="Data that is a list, such as rows from a sheet."
            onChange={(items) => change({ ...node, items }, 'items')}
          />
          <div className="form-row">
            <div className="field">
              <label>
                <span className="label">Items at once</span>
                <input type="number" min={1} max={20} value={node.concurrency ?? 1} disabled={readOnly} onChange={(event) => change({ ...node, concurrency: Math.round(Number(event.target.value)) }, 'concurrency')} />
              </label>
            </div>
            <div className="field">
              <label>
                <span className="label">At most</span>
                <input type="number" min={1} value={node.maxIterations ?? 1000} disabled={readOnly} onChange={(event) => change({ ...node, maxIterations: Math.round(Number(event.target.value)) }, 'maxIterations')} />
              </label>
            </div>
          </div>
          <p className="hint">
            {node.body.nodes.length === 0 ? 'The loop is empty.' : `${node.body.nodes.length} ${node.body.nodes.length === 1 ? 'step' : 'steps'} inside.`} Inside, steps read the current item as {'{{item}}'}.
          </p>
          <Button onClick={props.onOpenLoop}>Open the loop</Button>
        </Section>
      ) : null}
      <Connections node={node} graph={props.graph} titles={props.titles} readOnly={readOnly} onConnect={props.onConnect} onRemoveEdge={props.onRemoveEdge} />
      {readOnly ? null : (
        <div className="insp-danger">
          <Button variant="danger" size="small" onClick={props.onDelete}>
            Remove this step
          </Button>
        </div>
      )}
    </div>
  );
};

export const EdgeInspector = ({ from, to, port, readOnly, onRemove }: { from: string; to: string; port: string; readOnly: boolean; onRemove: () => void }) => (
  <div className="inspector-body">
    <header className="insp-head">
      <div>
        <h2>Cable</h2>
        <p>
          {from} {flowLabel(port)} to {to}
        </p>
      </div>
    </header>
    <Section title="What it does">
      <p className="hint">
        When {from} finishes on {flowLabel(port)}, {to} runs. A step with several cables coming in waits for all of them, and runs if at least one fired.
      </p>
    </Section>
    {readOnly ? null : (
      <div className="insp-danger">
        <Button variant="danger" size="small" onClick={onRemove}>
          Unplug this cable
        </Button>
      </div>
    )}
  </div>
);

export const DataLinkInspector = ({ link, from, to, readOnly, onRemove }: { link: DataLink; from: string; to: string; readOnly: boolean; onRemove: () => void }) => (
  <div className="inspector-body">
    <header className="insp-head">
      <div>
        <h2>Data cable</h2>
        <p>
          {from} to {to} {link.toPort}
        </p>
      </div>
    </header>
    <Section title="What it carries">
      <code className="copyable">{`{{${link.reference}}}`}</code>
      <p className="hint">The value is read when {to} starts. Edit the text around it in the step's inputs.</p>
    </Section>
    {readOnly ? null : (
      <div className="insp-danger">
        <Button variant="danger" size="small" onClick={onRemove}>
          Unplug this cable
        </Button>
      </div>
    )}
  </div>
);
