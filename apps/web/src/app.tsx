import { useEffect, type ReactNode } from 'react';
import { resolveRoute } from './lib/router';
import { Logo } from './components/module';
import { InstallButton, Loading } from './components/ui';
import { LoginPage, SignupPage } from './features/auth/auth-pages';
import { CustomApiPage } from './features/custom-api/custom-api-page';
import { IntegrationDetailPage } from './features/integrations/integration-detail-page';
import { IntegrationsPage } from './features/integrations/integrations-page';
import { MarketplacePage } from './features/marketplace/marketplace-page';
import { PluginPage } from './features/marketplace/plugin-page';
import { StudioPage } from './features/studio/studio-page';
import { WorkflowsPage } from './features/studio/workflows-page';
import { goToSignIn, messageOf, useAppState } from './state/app-state';
import { useInstallPrompt } from './state/install';
import { Link, navigate, useLocation } from './state/navigation';

const ROUTES = [
  { name: 'login', pattern: '/login' },
  { name: 'signup', pattern: '/signup' },
  { name: 'integrations', pattern: '/integrations' },
  { name: 'custom-api', pattern: '/integrations/new' },
  { name: 'integration', pattern: '/integrations/:pluginId' },
  { name: 'marketplace', pattern: '/marketplace' },
  { name: 'plugin', pattern: '/marketplace/:pluginId' },
  { name: 'workflows', pattern: '/workflows' },
  { name: 'studio', pattern: '/workflows/:workflowId' },
] as const;

const PUBLIC_ROUTES = new Set(['login', 'signup']);

const Wordmark = () => (
  <Link to="/integrations" className="wordmark" aria-label="Universal Flow AI home">
    <Logo />
    <span className="rack-label">UNIVERSAL FLOW</span>
  </Link>
);

/** `studio` gives Spatial Studio the whole window: the rack shrinks to its patch points. */
const Shell = ({ children, studio = false }: { children: ReactNode; studio?: boolean }) => {
  const { session, api, setSession, notify } = useAppState();
  const installer = useInstallPrompt();
  if (!session?.authenticated) return null;

  const switchWorkspace = async (workspaceId: string) => {
    try {
      setSession(await api.switchWorkspace(workspaceId));
      navigate('/integrations');
    } catch (error) {
      notify(messageOf(error), 'error');
    }
  };

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    setSession({ authenticated: false });
    navigate('/login', { replace: true });
  };

  return (
    <div className="shell" data-compact={studio || undefined}>
      <aside className="rack">
        <Wordmark />
        <nav className="rack-nav" aria-label="Main">
          <Link to="/integrations" title={studio ? 'Applications' : undefined}>
            <span className="patch-point" aria-hidden="true" />
            <span className="rack-label">Applications</span>
          </Link>
          <Link to="/marketplace" title={studio ? 'Marketplace' : undefined}>
            <span className="patch-point" aria-hidden="true" />
            <span className="rack-label">Marketplace</span>
          </Link>
          <Link to="/workflows" title={studio ? 'Workflows' : undefined}>
            <span className="patch-point" aria-hidden="true" />
            <span className="rack-label">Workflows</span>
          </Link>
        </nav>
        <div className="rack-footer">
          <InstallButton available={installer.available} onInstall={() => void installer.install()} />
          <label>
            Workspace
            <select value={session.workspace.id} onChange={(event) => void switchWorkspace(event.target.value)}>
              {session.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
          <span className="who">{session.user.name}</span>
          <span>{session.user.email}</span>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>
      <main className={studio ? 'panel panel-studio' : 'panel'} id="main">
        {children}
      </main>
    </div>
  );
};

const NotFound = () => (
  <div className="empty">
    <h2>This page does not exist</h2>
    <p>The link may be old, or the app was removed from this workspace.</p>
    <div className="actions">
      <Link to="/integrations" className="btn">
        Go to applications
      </Link>
    </div>
  </div>
);

export const App = () => {
  const { session } = useAppState();
  const { path } = useLocation();
  const route = resolveRoute(ROUTES, path === '/' ? '/integrations' : path);
  const isPublic = route !== undefined && PUBLIC_ROUTES.has(route.name);

  useEffect(() => {
    if (!session) return;
    if (!session.authenticated && !isPublic) goToSignIn();
    if (session.authenticated && isPublic) navigate('/integrations', { replace: true });
  }, [session, isPublic]);

  useEffect(() => {
    if (route?.name === 'studio') return; // Studio names the tab after the workflow.
    const titles: Record<string, string> = { login: 'Sign in', signup: 'Create account', integrations: 'Applications', 'custom-api': 'Add a custom API', marketplace: 'Marketplace', workflows: 'Workflows' };
    document.title = `${(route && titles[route.name]) ?? 'Universal Flow'} | UNIVERSAL FLOW AI`;
  }, [route?.name]);

  if (!session) return <Loading label="Starting" />;
  if (route?.name === 'login') return session.authenticated ? null : <LoginPage />;
  if (route?.name === 'signup') return session.authenticated ? null : <SignupPage />;
  if (!session.authenticated) return null;

  const page = (() => {
    switch (route?.name) {
      case 'integrations':
        return <IntegrationsPage />;
      case 'custom-api':
        return <CustomApiPage />;
      case 'integration':
        return <IntegrationDetailPage key={route.params.pluginId} pluginId={route.params.pluginId ?? ''} />;
      case 'marketplace':
        return <MarketplacePage />;
      case 'plugin':
        return <PluginPage key={route.params.pluginId} pluginId={route.params.pluginId ?? ''} />;
      case 'workflows':
        return <WorkflowsPage />;
      case 'studio':
        return <StudioPage key={route.params.workflowId} workflowId={route.params.workflowId ?? ''} />;
      default:
        return <NotFound />;
    }
  })();
  return (
    <Shell key={session.workspace.id} studio={route?.name === 'studio'}>
      {page}
    </Shell>
  );
};
