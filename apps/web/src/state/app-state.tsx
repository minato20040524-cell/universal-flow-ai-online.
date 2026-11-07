import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, createApiClient, type ApiClient } from '../lib/api';
import type { Session, SignedInSession } from '../lib/types';
import { navigate } from './navigation';

type Toast = { id: number; message: string; tone: 'success' | 'error' };

type AppState = {
  api: ApiClient;
  session: Session | undefined;
  setSession: (session: Session) => void;
  notify: (message: string, tone?: Toast['tone']) => void;
};

const AppStateContext = createContext<AppState | undefined>(undefined);

export const AppStateProvider = ({ children }: { children: ReactNode }) => {
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const sessionRef = useRef<Session | undefined>(undefined);
  sessionRef.current = session;

  const api = useMemo(
    () =>
      createApiClient({
        csrfToken: () => (sessionRef.current?.authenticated ? sessionRef.current.csrfToken : undefined),
        onUnauthenticated: () => {
          if (sessionRef.current?.authenticated) setSession({ authenticated: false });
        },
      }),
    [],
  );

  useEffect(() => {
    api.session().then(setSession, () => setSession({ authenticated: false }));
  }, [api]);

  const notify = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    // Only the latest few stay on screen, so a burst of actions never buries the page.
    setToasts((current) => [...current, { id, message, tone }].slice(-3));
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 5000);
  }, []);

  const value = useMemo(() => ({ api, session, setSession, notify }), [api, session, notify]);

  return (
    <AppStateContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast" data-tone={toast.tone}>
            {toast.message}
          </div>
        ))}
      </div>
    </AppStateContext.Provider>
  );
};

export const useAppState = (): AppState => {
  const state = useContext(AppStateContext);
  if (!state) throw new Error('useAppState must be used inside AppStateProvider');
  return state;
};

/** For pages behind sign-in: the shell only renders them with a signed-in session. */
export const useSignedIn = (): SignedInSession & { api: ApiClient; notify: AppState['notify']; setSession: AppState['setSession'] } => {
  const { session, api, notify, setSession } = useAppState();
  if (!session?.authenticated) throw new Error('useSignedIn needs a signed-in session');
  return { ...session, api, notify, setSession };
};

export const canManage = (role: SignedInSession['role']) => role === 'admin' || role === 'owner';
export const canEdit = (role: SignedInSession['role']) => role !== 'viewer';

export type Resource<T> = { data: T | undefined; error: ApiError | Error | undefined; loading: boolean; reload: () => void };

/** Loads data when its dependencies change; `reload` fetches again after a change. */
export const useResource = <T,>(load: () => Promise<T>, deps: readonly unknown[]): Resource<T> => {
  const [state, setState] = useState<{ data: T | undefined; error: ApiError | Error | undefined; loading: boolean }>({ data: undefined, error: undefined, loading: true });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setState((current) => ({ ...current, loading: true }));
    load().then(
      (data) => active && setState({ data, error: undefined, loading: false }),
      (error: unknown) => active && setState({ data: undefined, error: error instanceof Error ? error : new Error(String(error)), loading: false }),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  return { ...state, reload: () => setVersion((current) => current + 1) };
};

/** Error text a person can act on. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : 'Something went wrong');

export const goToSignIn = () => navigate(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`, { replace: true });
