import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { describePermission, describeSource, integrationLamp, relativeDate } from '../../lib/presentation';
import type { ConfigField, Credential, IntegrationDetail, NodeDefinition, TestReport, UpdatePreview } from '../../lib/types';
import { Faceplate } from '../../components/module';
import { Button, Dialog, ErrorNotice, Field, JsonBlock, Lamp, Loading } from '../../components/ui';
import { canEdit, canManage, messageOf, useResource, useSignedIn } from '../../state/app-state';
import { Link, navigate, useLocation } from '../../state/navigation';

const TABS = [
  { id: 'connection', label: 'Connection' },
  { id: 'test', label: 'Test' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'nodes', label: 'Workflow nodes' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const CREDENTIAL_FIELDS: Record<string, { key: string; label: string; secret: boolean }[]> = {
  api_key: [{ key: 'apiKey', label: 'API key', secret: true }],
  bearer: [{ key: 'token', label: 'Access token', secret: true }],
  basic: [
    { key: 'username', label: 'Username', secret: false },
    { key: 'password', label: 'Password', secret: true },
  ],
};

const credentialLamp = (credential: Credential) =>
  credential.status === 'connected'
    ? { tone: 'ready' as const, label: 'Connected' }
    : credential.status === 'expired'
      ? { tone: 'fault' as const, label: 'Expired' }
      : { tone: 'attention' as const, label: 'Not finished' };

const ConnectionTab = ({ detail, onChange }: { detail: IntegrationDetail; onChange: () => void }) => {
  const { api, notify, role } = useSignedIn();
  const authType = detail.manifest.auth.type;
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [waitingFor, setWaitingFor] = useState<string | undefined>(undefined);

  // After the OAuth window opens, watch for the account to finish connecting.
  useEffect(() => {
    if (!waitingFor) return;
    const started = Date.now();
    const timer = window.setInterval(async () => {
      const credentials = await api.credentials().catch(() => []);
      const pending = credentials.find((credential) => credential.id === waitingFor);
      if (pending?.status === 'connected') {
        window.clearInterval(timer);
        setWaitingFor(undefined);
        notify(`${detail.manifest.name} is connected`);
        onChange();
      } else if (Date.now() - started > 3 * 60_000) {
        window.clearInterval(timer);
        setWaitingFor(undefined);
        setError('Sign-in did not finish. Start again when you are ready.');
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [waitingFor, api, notify, onChange, detail.manifest.name]);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (authType === 'oauth2') {
        const { authorizationUrl, credentialId } = await api.startOAuth(detail.manifest.id, values.clientId ?? '', values.clientSecret || undefined);
        window.open(authorizationUrl, '_blank', 'noopener,width=520,height=720');
        setWaitingFor(credentialId);
      } else {
        await api.connect(detail.manifest.id, values);
        notify(`${detail.manifest.name} account connected`);
        setValues({});
        onChange();
      }
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (credential: Credential) => {
    try {
      await api.disconnect(credential.id);
      notify('Account disconnected');
      onChange();
    } catch (caught) {
      notify(messageOf(caught), 'error');
    }
  };

  if (authType === 'none') {
    return (
      <section className="section">
        <h2>No account needed</h2>
        <p>{detail.manifest.name} works without signing in. Add it to a workflow and it is ready.</p>
      </section>
    );
  }

  const fields =
    authType === 'oauth2'
      ? [
          { key: 'clientId', label: 'Client ID', secret: false },
          { key: 'clientSecret', label: 'Client secret', secret: true },
        ]
      : (CREDENTIAL_FIELDS[authType] ?? []);

  return (
    <>
      <section className="section">
        <h2>Connected accounts</h2>
        {detail.credentials.length === 0 ? (
          <p>No account yet. Connect one below; workflows use it without ever seeing the secret.</p>
        ) : (
          <ul className="plain-list">
            {detail.credentials.map((credential) => (
              <li key={credential.id}>
                <span>
                  <Lamp lamp={credentialLamp(credential)} />
                  <span className="hint"> Added {relativeDate(credential.createdAt, Date.now())}</span>
                </span>
                {canManage(role) ? (
                  <Button size="small" variant="danger" onClick={() => void disconnect(credential)}>
                    Disconnect
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {canManage(role) ? (
        <section className="section">
          <h2>{detail.credentials.length === 0 ? 'Connect an account' : 'Connect another account'}</h2>
          <p>
            {authType === 'oauth2'
              ? `Enter the OAuth app you registered with ${detail.manifest.provider}, then sign in on their page. Use this redirect address: ${window.location.origin}/oauth/callback`
              : 'The secret is encrypted on the server. It is never shown again, not even to you.'}
          </p>
          <form onSubmit={connect} className="form-grid">
            {fields.map((field) => (
              <Field key={field.key} label={field.label}>
                {(props) => (
                  <input
                    {...props}
                    type={field.secret ? 'password' : 'text'}
                    autoComplete="off"
                    value={values[field.key] ?? ''}
                    onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                  />
                )}
              </Field>
            ))}
            <div className="actions">
              <Button type="submit" variant="primary" disabled={busy || Boolean(waitingFor) || !fields.some((field) => values[field.key])}>
                {authType === 'oauth2' ? (waitingFor ? 'Waiting for sign-in…' : 'Continue to sign in') : busy ? 'Connecting…' : 'Connect account'}
              </Button>
            </div>
          </form>
          {error ? (
            <p className="error-text" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
};

const inputControl = (field: ConfigField, value: string, setValue: (value: string) => void) =>
  (props: { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined }) => {
    switch (field.widget) {
      case 'textarea':
        return <textarea {...props} rows={4} value={value} onChange={(event) => setValue(event.target.value)} />;
      case 'json':
        return <textarea {...props} className="code" rows={4} value={value} onChange={(event) => setValue(event.target.value)} spellCheck={false} />;
      case 'select':
        return (
          <select {...props} value={value} onChange={(event) => setValue(event.target.value)}>
            <option value="">Choose…</option>
            {(field.options ?? []).map((option) => (
              <option key={String(option)} value={String(option)}>
                {String(option)}
              </option>
            ))}
          </select>
        );
      case 'toggle':
        return (
          <select {...props} value={value} onChange={(event) => setValue(event.target.value)}>
            <option value="">Not set</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        );
      case 'number':
        return <input {...props} type="number" value={value} onChange={(event) => setValue(event.target.value)} />;
      default:
        return <input {...props} type="text" value={value} onChange={(event) => setValue(event.target.value)} />;
    }
  };

/** Form strings → the JSON values the action's schema expects. */
const toInput = (fields: readonly ConfigField[], values: Record<string, string>): { input: Record<string, unknown>; problems: Record<string, string> } => {
  const input: Record<string, unknown> = {};
  const problems: Record<string, string> = {};
  for (const field of fields) {
    const raw = values[field.key] ?? '';
    if (raw === '') continue;
    if (field.widget === 'number') {
      const number = Number(raw);
      if (Number.isFinite(number)) input[field.key] = number;
      else problems[field.key] = 'Enter a number';
    } else if (field.widget === 'toggle') input[field.key] = raw === 'true';
    else if (field.widget === 'json') {
      try {
        input[field.key] = JSON.parse(raw);
      } catch {
        problems[field.key] = 'Enter valid JSON';
      }
    } else input[field.key] = raw;
  }
  return { input, problems };
};

const ReportView = ({ report }: { report: TestReport }) => (
  <div className="report" data-ok={String(report.ok)} aria-live="polite">
    <h3>{report.ok ? 'The test passed' : report.error ? 'The test failed' : 'The response does not match the outputs'}</h3>
    {report.error ? <p className="error-text">{report.error.message}</p> : null}
    {report.warnings.length > 0 ? (
      <ul className="issues">
        {report.warnings.map((warning, index) => (
          <li key={index}>
            {warning.path.replace('$.output.', '')}: {warning.message}
          </li>
        ))}
      </ul>
    ) : null}
    <dl>
      <dt>Status</dt>
      <dd>{report.status ?? 'No response'}</dd>
      <dt>Time</dt>
      <dd>{report.durationMs} ms</dd>
      {report.request ? (
        <>
          <dt>Request</dt>
          <dd>
            <code>
              {report.request.method} {report.request.url}
            </code>
          </dd>
        </>
      ) : null}
    </dl>
    {report.output !== undefined ? (
      <>
        <h4 className="label">Outputs</h4>
        <JsonBlock value={report.output} />
      </>
    ) : null}
    {report.rawResponse !== undefined ? (
      <details>
        <summary className="label">Raw response</summary>
        <JsonBlock value={report.rawResponse} />
      </details>
    ) : null}
  </div>
);

const TestTab = ({ detail, onActivated }: { detail: IntegrationDetail; onActivated: () => void }) => {
  const { api, notify, role } = useSignedIn();
  const actionNodes = detail.nodes.filter((node) => node.source.kind === 'plugin' && node.source.role === 'action');
  const [actionKey, setActionKey] = useState(actionNodes[0]?.source.kind === 'plugin' ? actionNodes[0].source.key : '');
  const node = actionNodes.find((candidate) => candidate.source.kind === 'plugin' && candidate.source.key === actionKey);
  const connected = detail.credentials.filter((credential) => credential.status === 'connected');
  const [credentialId, setCredentialId] = useState(connected[0]?.id ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [report, setReport] = useState<TestReport | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  if (detail.manifest.runtime !== 'http') {
    return (
      <section className="section">
        <h2>Tested by its maintainers</h2>
        <p>{detail.manifest.name} is an official module that runs inside Universal Flow, so there is no API request to test here.</p>
      </section>
    );
  }

  const run = async (event: FormEvent) => {
    event.preventDefault();
    const fields = node?.configFields ?? [];
    const converted = toInput(fields, values);
    setProblems(converted.problems);
    if (Object.keys(converted.problems).length > 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.test(detail.manifest.id, { action: actionKey, input: converted.input, ...(credentialId ? { credentialId } : {}) });
      setReport(result.report);
      if (result.activated) {
        notify(`${detail.manifest.name} passed its test and is now active`);
        onActivated();
      }
    } catch (caught) {
      setError(caught instanceof ApiError && caught.issues.length > 0 ? caught.issues.map((issue) => issue.message).join('. ') : messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const needsAccount = detail.manifest.auth.type !== 'none';

  return (
    <section className="section">
      <h2>Test the connection</h2>
      <p>
        {detail.integration.status === 'testing'
          ? 'Send one real request with sample values. When it passes, this integration becomes active and workflows can use it.'
          : 'Send one real request with sample values to check the API still answers as expected.'}
      </p>
      {needsAccount && connected.length === 0 ? <div className="notice">Connect an account first; this API needs one to answer.</div> : null}
      <form onSubmit={run} className="form-grid">
        {actionNodes.length > 1 ? (
          <Field label="Action">
            {(props) => (
              <select {...props} value={actionKey} onChange={(event) => setActionKey(event.target.value)}>
                {actionNodes.map((candidate) =>
                  candidate.source.kind === 'plugin' ? (
                    <option key={candidate.source.key} value={candidate.source.key}>
                      {candidate.subtitle}
                    </option>
                  ) : null,
                )}
              </select>
            )}
          </Field>
        ) : null}
        {needsAccount && connected.length > 0 ? (
          <Field label="Account">
            {(props) => (
              <select {...props} value={credentialId} onChange={(event) => setCredentialId(event.target.value)}>
                {connected.map((credential, index) => (
                  <option key={credential.id} value={credential.id}>
                    Account {index + 1}, added {relativeDate(credential.createdAt, Date.now())}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        {(node?.configFields ?? []).map((field) => (
          <Field key={field.key} label={`${field.label}${field.required ? '' : ' (optional)'}`} hint={field.description} error={problems[field.key]}>
            {inputControl(field, values[field.key] ?? '', (value) => setValues((current) => ({ ...current, [field.key]: value })))}
          </Field>
        ))}
        <div className="actions">
          <Button type="submit" variant="primary" disabled={busy || !canEdit(role)}>
            {busy ? 'Sending request…' : 'Run test'}
          </Button>
        </div>
      </form>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {report ? <ReportView report={report} /> : null}
    </section>
  );
};

const PermissionsTab = ({ detail }: { detail: IntegrationDetail }) => (
  <>
    <section className="section">
      <h2>What this app may do</h2>
      <p>Universal Flow blocks anything not on this list, including requests to any other address.</p>
      {detail.permissions.declared.length === 0 ? (
        <p>Nothing outside Universal Flow.</p>
      ) : (
        <ul className="plain-list">
          {detail.permissions.declared.map((permission) => (
            <li key={permission}>
              <span>{describePermission(permission)}</span>
              <span className="tag">{detail.permissions.granted.includes(permission) ? 'Allowed' : 'Not allowed'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
    <section className="section">
      <h2>What it cannot do</h2>
      {detail.manifest.limitations.length === 0 ? (
        <p>The publisher lists no limitations.</p>
      ) : (
        <ul className="plain-list">
          {detail.manifest.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      )}
    </section>
  </>
);

const NodesTab = ({ nodes }: { nodes: readonly NodeDefinition[] }) => (
  <section className="section">
    <h2>Nodes for workflows</h2>
    <p>Each action becomes a node in Spatial Studio, with these inputs and outputs.</p>
    <ul className="plain-list">
      {nodes.map((node) => (
        <li key={node.type}>
          <span>
            <strong>{node.subtitle}</strong>
            <span className="hint">
              {' '}
              {node.dataInputs.length} in, {node.dataOutputs.length} out
            </span>
          </span>
          <code>{node.type}</code>
        </li>
      ))}
    </ul>
  </section>
);

type ManageAction = { kind: 'update'; preview: UpdatePreview } | { kind: 'uninstall'; inUse: string | undefined } | undefined;

export const IntegrationDetailPage = ({ pluginId }: { pluginId: string }) => {
  const { api, notify, role } = useSignedIn();
  const { search } = useLocation();
  const resource = useResource(() => api.integration(pluginId), [api, pluginId]);
  const requested = search.get('tab');
  const [tab, setTab] = useState<TabId>(TABS.find((item) => item.id === requested)?.id ?? 'connection');
  const [manage, setManage] = useState<ManageAction>(undefined);
  const [busy, setBusy] = useState(false);

  const detail = resource.data;
  const firstAction = useMemo(() => detail?.nodes.find((node) => node.source.kind === 'plugin' && node.source.role === 'action'), [detail]);

  if (resource.loading && !detail) return <Loading label="Loading application" />;
  if (resource.error || !detail) {
    return (
      <>
        <Link to="/integrations" className="back">
          Applications
        </Link>
        {resource.error ? <ErrorNotice error={resource.error} onRetry={resource.reload} /> : null}
      </>
    );
  }

  const { integration, manifest } = detail;
  const lamp = integrationLamp(integration, detail.credentials, manifest.auth.type !== 'none');

  const toggle = async () => {
    setBusy(true);
    try {
      await api.setEnabled(pluginId, !integration.enabled);
      notify(integration.enabled ? `${manifest.name} disabled` : `${manifest.name} enabled`);
      resource.reload();
    } catch (error) {
      notify(messageOf(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const openUpdate = async () => {
    try {
      setManage({ kind: 'update', preview: await api.previewUpdate(pluginId) });
    } catch (error) {
      notify(messageOf(error), 'error');
    }
  };

  const confirmUpdate = async (preview: UpdatePreview) => {
    setBusy(true);
    try {
      await api.update(pluginId, preview.permissions.added);
      notify(`Updated ${manifest.name} to ${preview.to}`);
      setManage(undefined);
      resource.reload();
    } catch (error) {
      notify(messageOf(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const confirmUninstall = async (force: boolean) => {
    setBusy(true);
    try {
      await api.uninstall(pluginId, force);
      notify(`${manifest.name} uninstalled`);
      navigate('/integrations');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setManage({ kind: 'uninstall', inUse: error.message });
      else notify(messageOf(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Link to="/integrations" className="back">
        Applications
      </Link>
      <header className="page-head">
        <div>
          <h1>{manifest.name}</h1>
          <p>
            {manifest.provider}, version {manifest.version}. {manifest.description ?? ''}
          </p>
        </div>
        <div className="actions">
          <Lamp lamp={lamp} />
          {canManage(role) ? (
            <>
              {integration.updateAvailable ? (
                <Button onClick={() => void openUpdate()}>Update to {integration.updateAvailable}</Button>
              ) : null}
              <Button onClick={() => void toggle()} disabled={busy}>
                {integration.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button variant="danger" onClick={() => setManage({ kind: 'uninstall', inUse: undefined })}>
                Uninstall
              </Button>
            </>
          ) : null}
        </div>
      </header>

      <div className="detail">
        <Faceplate
          title={manifest.name}
          subtitle={firstAction?.subtitle ?? ''}
          category={manifest.category}
          inputs={firstAction?.dataInputs ?? []}
          outputs={firstAction?.dataOutputs ?? []}
          footer={
            <>
              <span>{describeSource(integration.source)}</span>
              <span>v{manifest.version}</span>
            </>
          }
        />
        <div>
          <div className="tabs" role="tablist" aria-label="Application settings">
            {TABS.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
          <div role="tabpanel">
            {tab === 'connection' ? <ConnectionTab detail={detail} onChange={resource.reload} /> : null}
            {tab === 'test' ? <TestTab detail={detail} onActivated={resource.reload} /> : null}
            {tab === 'permissions' ? <PermissionsTab detail={detail} /> : null}
            {tab === 'nodes' ? <NodesTab nodes={detail.nodes} /> : null}
          </div>
        </div>
      </div>

      <Dialog
        open={manage?.kind === 'update'}
        title={manage?.kind === 'update' ? `Update to ${manage.preview.to}` : 'Update'}
        onClose={() => setManage(undefined)}
        actions={
          <>
            <Button variant="primary" disabled={busy} onClick={() => manage?.kind === 'update' && void confirmUpdate(manage.preview)}>
              {manage?.kind === 'update' && manage.preview.permissions.added.length > 0 ? 'Allow and update' : 'Update'}
            </Button>
            <Button onClick={() => setManage(undefined)}>Cancel</Button>
          </>
        }
      >
        {manage?.kind === 'update' && manage.preview.permissions.added.length > 0 ? (
          <>
            <p>The new version asks for more access:</p>
            <ul className="plain-list">
              {manage.preview.permissions.added.map((permission) => (
                <li key={permission}>{describePermission(permission)}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>The new version needs no extra access. Workflows keep using the version they were saved with until you update them.</p>
        )}
      </Dialog>

      <Dialog
        open={manage?.kind === 'uninstall'}
        title={`Uninstall ${manifest.name}?`}
        onClose={() => setManage(undefined)}
        actions={
          <>
            <Button variant="danger" disabled={busy} onClick={() => void confirmUninstall(Boolean(manage?.kind === 'uninstall' && manage.inUse))}>
              {manage?.kind === 'uninstall' && manage.inUse ? 'Uninstall anyway' : 'Uninstall'}
            </Button>
            <Button onClick={() => setManage(undefined)}>Keep it</Button>
          </>
        }
      >
        {manage?.kind === 'uninstall' && manage.inUse ? (
          <p className="error-text">{manage.inUse}. Uninstalling anyway stops those workflows at this step.</p>
        ) : (
          <p>Its connected accounts stay in the vault until you disconnect them. You can install it again from the marketplace.</p>
        )}
      </Dialog>
    </>
  );
};
