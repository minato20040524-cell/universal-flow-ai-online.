import { useMemo, useState } from 'react';
import { ApiError } from '../../lib/api';
import { describeSource, marketplaceShelves } from '../../lib/presentation';
import type { MarketplacePlugin, PluginSource } from '../../lib/types';
import { Tile } from '../../components/module';
import { Button, Dialog, ErrorNotice, Field, IssueList, Loading } from '../../components/ui';
import { canEdit, canManage, messageOf, useResource, useSignedIn } from '../../state/app-state';
import { Link } from '../../state/navigation';
import { InstallDialog } from './install-dialog';

const SOURCES: readonly PluginSource[] = ['official', 'community', 'custom'];

const PublishDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { api, notify } = useSignedIn();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [issues, setIssues] = useState<ApiError['issues']>([]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setProblem(undefined);
    setIssues([]);
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      setProblem('This is not valid JSON. Paste the whole manifest.');
      return;
    }
    setBusy(true);
    try {
      await api.submitPlugin(manifest);
      notify('Sent for review. It appears in the marketplace once it is approved.');
      setText('');
      onClose();
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
      title="Publish a plugin"
      onClose={onClose}
      actions={
        <>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !text.trim()}>
            {busy ? 'Sending…' : 'Send for review'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <p>Share a plugin with every workspace. A reviewer checks its permissions and the hosts it calls before it is listed.</p>
      <Field label="Plugin manifest (JSON)" error={problem}>
        {(props) => <textarea {...props} className="code" rows={10} spellCheck={false} value={text} onChange={(event) => setText(event.target.value)} />}
      </Field>
      <IssueList issues={issues} title="Fix these before sending:" />
    </Dialog>
  );
};

export const MarketplacePage = () => {
  const { api, role } = useSignedIn();
  const resource = useResource(() => Promise.all([api.marketplace(), api.categories()]), [api]);
  const [text, setText] = useState('');
  const [category, setCategory] = useState('');
  const [source, setSource] = useState('');
  const [installing, setInstalling] = useState<string | undefined>(undefined);
  const [publishing, setPublishing] = useState(false);

  const [plugins, categories] = resource.data ?? [[], []];
  const filtering = Boolean(text.trim() || category || source);
  const results = useMemo(() => {
    const query = text.trim().toLowerCase();
    return plugins.filter(
      (plugin) =>
        (!query || `${plugin.name} ${plugin.provider} ${plugin.description ?? ''}`.toLowerCase().includes(query)) &&
        (!category || plugin.category === category) &&
        (!source || plugin.source === source),
    );
  }, [plugins, text, category, source]);
  const shelves = useMemo(() => marketplaceShelves(plugins, Date.now()), [plugins]);

  const action = (plugin: MarketplacePlugin) =>
    plugin.installed ? (
      <Link to={`/integrations/${encodeURIComponent(plugin.id)}`} className="btn btn-small">
        Installed, open
      </Link>
    ) : canManage(role) ? (
      <Button size="small" onClick={() => setInstalling(plugin.id)} aria-label={`Install ${plugin.name}`}>
        Install
      </Button>
    ) : (
      <Link to={`/marketplace/${encodeURIComponent(plugin.id)}`} className="btn btn-small">
        Details
      </Link>
    );

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Marketplace</h1>
          <p>Modules you can install into this workspace. Each one says exactly which services it may reach.</p>
        </div>
        <div className="actions">
          {canEdit(role) ? <Button onClick={() => setPublishing(true)}>Publish a plugin</Button> : null}
          <Link to="/integrations/new" className="btn">
            Add custom API
          </Link>
        </div>
      </header>

      <div className="toolbar" role="search">
        <div className="field grow">
          <label htmlFor="market-search" className="visually-hidden">
            Search the marketplace
          </label>
          <input id="market-search" type="search" placeholder="Search apps, models and services" value={text} onChange={(event) => setText(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="market-category" className="visually-hidden">
            Category
          </label>
          <select id="market-category" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">All categories</option>
            {categories.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="market-source" className="visually-hidden">
            Source
          </label>
          <select id="market-source" value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="">Any publisher</option>
            {SOURCES.map((item) => (
              <option key={item} value={item}>
                {describeSource(item)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {resource.loading && !resource.data ? <Loading label="Loading the marketplace" /> : null}
      {resource.error ? <ErrorNotice error={resource.error} onRetry={resource.reload} /> : null}

      {resource.data && filtering ? (
        <section aria-label="Search results">
          <p className="hint">{results.length === 1 ? '1 module' : `${results.length} modules`}</p>
          {results.length === 0 ? (
            <div className="empty">
              <h2>Nothing found</h2>
              <p>If the service has an HTTPS API, you can add it yourself in a few minutes.</p>
              <div className="actions">
                <Link to="/integrations/new" className="btn btn-primary">
                  Add custom API
                </Link>
              </div>
            </div>
          ) : (
            <div className="grid-results">
              {results.map((plugin) => (
                <Tile key={plugin.id} plugin={plugin} action={action(plugin)} />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {resource.data && !filtering
        ? shelves.map((shelf) => (
            <section key={shelf.id} className="shelf" aria-labelledby={`shelf-${shelf.id}`}>
              <div className="shelf-head">
                <h2 id={`shelf-${shelf.id}`}>{shelf.title}</h2>
                <p>{shelf.description}</p>
              </div>
              <div className="rail">
                {shelf.plugins.map((plugin) => (
                  <Tile key={plugin.id} plugin={plugin} action={action(plugin)} />
                ))}
              </div>
            </section>
          ))
        : null}

      <InstallDialog pluginId={installing} onClose={() => setInstalling(undefined)} />
      <PublishDialog open={publishing} onClose={() => setPublishing(false)} />
    </>
  );
};
