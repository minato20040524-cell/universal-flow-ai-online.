import { useEffect, useState } from 'react';
import { describePermission } from '../../lib/presentation';
import type { PluginDetail } from '../../lib/types';
import { Button, Dialog, Loading } from '../../components/ui';
import { messageOf, useSignedIn } from '../../state/app-state';
import { navigate } from '../../state/navigation';

/** Asks for consent to exactly the access the plugin declares, then installs it. */
export const InstallDialog = ({ pluginId, onClose }: { pluginId: string | undefined; onClose: () => void }) => {
  const { api, notify } = useSignedIn();
  const [plugin, setPlugin] = useState<PluginDetail | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPlugin(undefined);
    setError(undefined);
    if (!pluginId) return;
    api.plugin(pluginId).then(setPlugin, (caught: unknown) => setError(messageOf(caught)));
  }, [api, pluginId]);

  const install = async () => {
    if (!plugin) return;
    setBusy(true);
    try {
      await api.install(plugin.manifest.id, plugin.manifest.permissions);
      notify(`${plugin.manifest.name} installed`);
      onClose();
      navigate(`/integrations/${encodeURIComponent(plugin.manifest.id)}`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const permissions = plugin?.manifest.permissions ?? [];
  return (
    <Dialog
      open={pluginId !== undefined}
      title={plugin ? `Install ${plugin.manifest.name}` : 'Install'}
      onClose={onClose}
      actions={
        <>
          <Button variant="primary" onClick={() => void install()} disabled={!plugin || busy}>
            {busy ? 'Installing…' : permissions.length > 0 ? 'Allow and install' : 'Install'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      {!plugin && !error ? <Loading label="Checking what it needs" /> : null}
      {plugin ? (
        <>
          <p>
            {permissions.length > 0
              ? `${plugin.manifest.name} will be able to:`
              : `${plugin.manifest.name} runs entirely inside Universal Flow and needs no outside access.`}
          </p>
          {permissions.length > 0 ? (
            <ul className="plain-list">
              {permissions.map((permission) => (
                <li key={permission}>{describePermission(permission)}</li>
              ))}
            </ul>
          ) : null}
          {plugin.manifest.limitations.length > 0 ? (
            <div className="notice">
              <strong>Limits:</strong> {plugin.manifest.limitations.join(' ')}
            </div>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
};
