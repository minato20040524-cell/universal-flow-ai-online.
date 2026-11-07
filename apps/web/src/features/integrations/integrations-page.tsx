import { useMemo, useState, type ChangeEvent } from 'react';
import { integrationLamp, type Lamp as LampState } from '../../lib/presentation';
import type { InstalledIntegration, NodeDefinition } from '../../lib/types';
import { categoryColor, JackColumn } from '../../components/module';
import { Button, Dialog, Empty, ErrorNotice, Field, IssueList, Lamp, Loading } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { canEdit, messageOf, useResource, useSignedIn } from '../../state/app-state';
import { Link, navigate } from '../../state/navigation';

type Row = { integration: InstalledIntegration; lamp: LampState; node: NodeDefinition | undefined; categoryName: string };

const STATUS_FILTERS = [
  { value: '', label: 'Any status' },
  { value: 'ready', label: 'Ready' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'fault', label: 'Failing' },
  { value: 'off', label: 'Disabled' },
] as const;

const ImportDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { api, notify } = useSignedIn();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [issues, setIssues] = useState<ApiError['issues']>([]);
  const [busy, setBusy] = useState(false);

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) setText(await file.text());
  };

  const submit = async () => {
    setProblem(undefined);
    setIssues([]);
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      setProblem('This is not valid JSON. Paste the whole manifest file.');
      return;
    }
    setBusy(true);
    try {
      const created = await api.importManifest(manifest);
      notify(`Imported ${created.plugin.id}. Run a test to activate it.`);
      onClose();
      navigate(`/integrations/${encodeURIComponent(created.plugin.id)}?tab=test`);
    } catch (error) {
      if (error instanceof ApiError && error.issues.length > 0) setIssues(error.issues);
      else setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Import an integration"
      onClose={onClose}
      actions={
        <>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !text.trim()}>
            {busy ? 'Importing…' : 'Import'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <p>Add an integration from a manifest file, for example one exported from another workspace. It joins this workspace in test mode.</p>
      <Field label="Manifest file">{(props) => <input {...props} type="file" accept="application/json,.json" onChange={(event) => void readFile(event)} />}</Field>
      <Field label="Or paste the manifest JSON" error={problem}>
        {(props) => <textarea {...props} className="code" rows={8} value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} />}
      </Field>
      <IssueList issues={issues} title="Fix these before importing:" />
    </Dialog>
  );
};

export const IntegrationsPage = () => {
  const { api, role } = useSignedIn();
  const [text, setText] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [importing, setImporting] = useState(false);

  const resource = useResource(
    () => Promise.all([api.integrations(), api.credentials(), api.nodes(), api.categories()]),
    [api],
  );

  const rows = useMemo<Row[]>(() => {
    if (!resource.data) return [];
    const [integrations, credentials, nodes, categories] = resource.data;
    const names = new Map(categories.map((item) => [item.slug, item.name]));
    return integrations.map((integration) => {
      const node = nodes.find((candidate) => candidate.source.kind === 'plugin' && candidate.source.pluginId === integration.pluginId && candidate.source.role === 'action');
      return {
        integration,
        node,
        lamp: integrationLamp(integration, credentials, node?.auth.required ?? false),
        categoryName: names.get(integration.category) ?? integration.category,
      };
    });
  }, [resource.data]);

  const visible = rows.filter(({ integration, lamp }) => {
    const query = text.trim().toLowerCase();
    if (query && !`${integration.name} ${integration.provider} ${integration.pluginId}`.toLowerCase().includes(query)) return false;
    if (category && integration.category !== category) return false;
    if (status && lamp.tone !== status) return false;
    return true;
  });

  const categories = resource.data?.[3] ?? [];
  const usedCategories = categories.filter((item) => rows.some((row) => row.integration.category === item.slug));

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Applications &amp; Integrations</h1>
          <p>Every app this workspace can use in a workflow. Connect an account once and any workflow can use it.</p>
        </div>
        <div className="actions">
          {canEdit(role) ? (
            <>
              <Link to="/integrations/new" className="btn btn-primary">
                Add custom API
              </Link>
              <Button onClick={() => setImporting(true)}>Import</Button>
            </>
          ) : null}
          <Link to="/marketplace" className="btn">
            Browse marketplace
          </Link>
        </div>
      </header>

      {resource.loading && !resource.data ? <Loading label="Loading applications" /> : null}
      {resource.error ? <ErrorNotice error={resource.error} onRetry={resource.reload} /> : null}

      {resource.data && rows.length === 0 ? (
        <Empty
          title="No applications yet"
          actions={
            <>
              <Link to="/marketplace" className="btn btn-primary">
                Browse marketplace
              </Link>
              {canEdit(role) ? (
                <Link to="/integrations/new" className="btn">
                  Add custom API
                </Link>
              ) : null}
            </>
          }
        >
          Install an app from the marketplace, or describe any API yourself and it becomes a module you can wire into workflows.
        </Empty>
      ) : null}

      {rows.length > 0 ? (
        <>
          <div className="toolbar" role="search">
            <div className="field grow">
              <label htmlFor="integration-search" className="visually-hidden">
                Search applications
              </label>
              <input id="integration-search" type="search" placeholder="Search by name or provider" value={text} onChange={(event) => setText(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="integration-category" className="visually-hidden">
                Category
              </label>
              <select id="integration-category" value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="">All categories</option>
                {usedCategories.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="integration-status" className="visually-hidden">
                Status
              </label>
              <select id="integration-status" value={status} onChange={(event) => setStatus(event.target.value)}>
                {STATUS_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {visible.length === 0 ? <p className="hint">Nothing matches these filters.</p> : null}
          <ul className="rack-rows" aria-label="Installed applications">
            {visible.map(({ integration, lamp, node, categoryName }) => {
              const color = categoryColor(integration.category);
              return (
                <li key={integration.pluginId} className="rack-row">
                  <JackColumn count={node?.dataInputs.length ?? 0} color={color} side="in" />
                  <div className="name">
                    <Link to={`/integrations/${encodeURIComponent(integration.pluginId)}`}>{integration.name}</Link>
                    <span>{integration.provider}</span>
                  </div>
                  <span className="meta">{categoryName}</span>
                  <span className="version">
                    v{integration.version}
                    {integration.updateAvailable ? <span className="tag tag-update">Update {integration.updateAvailable}</span> : null}
                  </span>
                  <span className="lamp-cell">
                    <Lamp lamp={lamp} />
                  </span>
                  <JackColumn count={node?.dataOutputs.length ?? 0} color={color} side="out" />
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
    </>
  );
};
