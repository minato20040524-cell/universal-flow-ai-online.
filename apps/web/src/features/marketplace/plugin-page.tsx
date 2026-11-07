import { useState } from 'react';
import { describePermission, describeSource, relativeDate } from '../../lib/presentation';
import { Faceplate } from '../../components/module';
import { Button, ErrorNotice, Loading } from '../../components/ui';
import { canManage, useResource, useSignedIn } from '../../state/app-state';
import { Link } from '../../state/navigation';
import { InstallDialog } from './install-dialog';

export const PluginPage = ({ pluginId }: { pluginId: string }) => {
  const { api, role } = useSignedIn();
  const resource = useResource(() => Promise.all([api.plugin(pluginId), api.integrations()]), [api, pluginId]);
  const [installing, setInstalling] = useState(false);

  if (resource.loading && !resource.data) return <Loading label="Loading module" />;
  if (resource.error || !resource.data) {
    return (
      <>
        <Link to="/marketplace" className="back">
          Marketplace
        </Link>
        {resource.error ? <ErrorNotice error={resource.error} onRetry={resource.reload} /> : null}
      </>
    );
  }

  const [plugin, installed] = resource.data;
  const { manifest } = plugin;
  const isInstalled = installed.some((integration) => integration.pluginId === manifest.id);
  const node = plugin.nodes.find((candidate) => candidate.source.kind === 'plugin' && candidate.source.role === 'action');

  return (
    <>
      <Link to="/marketplace" className="back">
        Marketplace
      </Link>
      <header className="page-head">
        <div>
          <h1>{manifest.name}</h1>
          <p>
            {manifest.provider}. {describeSource(plugin.source)} module, version {manifest.version}.
          </p>
        </div>
        <div className="actions">
          {isInstalled ? (
            <Link to={`/integrations/${encodeURIComponent(manifest.id)}`} className="btn btn-primary">
              Open in Applications
            </Link>
          ) : canManage(role) ? (
            <Button variant="primary" onClick={() => setInstalling(true)}>
              Install
            </Button>
          ) : (
            <span className="hint">Ask an admin to install it.</span>
          )}
        </div>
      </header>
      <div className="detail">
        <Faceplate
          title={manifest.name}
          subtitle={node?.subtitle ?? ''}
          category={manifest.category}
          inputs={node?.dataInputs ?? []}
          outputs={node?.dataOutputs ?? []}
          footer={
            <>
              <span>{manifest.auth.type === 'none' ? 'No sign-in' : 'Needs an account'}</span>
              <span>v{manifest.version}</span>
            </>
          }
        />
        <div>
          {manifest.description ? (
            <section className="section">
              <h2>About</h2>
              <p>{manifest.description}</p>
              {manifest.docs ? (
                <p>
                  <a href={manifest.docs} target="_blank" rel="noreferrer noopener">
                    Read the documentation
                  </a>
                </p>
              ) : null}
            </section>
          ) : null}
          <section className="section">
            <h2>Actions</h2>
            <ul className="plain-list">
              {manifest.actions.map((action) => (
                <li key={action.key}>
                  <span>{action.name}</span>
                  <span className="hint">{action.description ?? ''}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="section">
            <h2>Access it needs</h2>
            {manifest.permissions.length === 0 ? (
              <p>None outside Universal Flow.</p>
            ) : (
              <ul className="plain-list">
                {manifest.permissions.map((permission) => (
                  <li key={permission}>{describePermission(permission)}</li>
                ))}
              </ul>
            )}
            {manifest.limitations.length > 0 ? (
              <>
                <h3>Limits</h3>
                <ul className="plain-list">
                  {manifest.limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
          <section className="section">
            <h2>Versions</h2>
            <ul className="plain-list">
              {plugin.versions.map((version) => (
                <li key={version.version}>
                  <span>{version.version}</span>
                  <span className="hint">Published {relativeDate(version.registeredAt, Date.now())}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
      <InstallDialog pluginId={installing ? manifest.id : undefined} onClose={() => setInstalling(false)} />
    </>
  );
};
