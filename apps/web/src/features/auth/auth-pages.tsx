import { useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { safeReturnPath } from '../../lib/router';
import { Logo } from '../../components/module';
import { Button, Field, InstallButton } from '../../components/ui';
import { messageOf, useAppState } from '../../state/app-state';
import { useInstallPrompt } from '../../state/install';
import { Link, navigate, useLocation } from '../../state/navigation';

/** Three modules patched together: a message comes in, a model rewrites it, it goes out. */
const MODULES = [
  { title: 'Telegram', x: 24, width: 126, inputs: [], outputs: [92, 128] },
  { title: 'Your model', x: 262, width: 132, inputs: [168, 236], outputs: [168] },
  { title: 'YouTube', x: 470, width: 80, inputs: [92], outputs: [] },
] as const;

const PatchIllustration = () => (
  <svg viewBox="0 0 560 300" role="img" aria-label="Three modules connected by patch cables: Telegram into your model, your model into YouTube">
    {MODULES.map((module) => (
      <g key={module.title}>
        <rect x={module.x} y="40" width={module.width} height="236" rx="6" fill="#20242A" stroke="#3A4149" />
        <text x={module.x + 14} y="68" fill="#D9DDE2" fontSize="15" fontFamily="Bahnschrift, 'DIN Alternate', 'Arial Narrow', sans-serif">
          {module.title}
        </text>
        {module.inputs.map((y) => (
          <circle key={`in-${y}`} cx={module.x} cy={y} r="9" fill="#0F1114" stroke="#8B949E" strokeWidth="3" />
        ))}
        {module.outputs.map((y) => (
          <circle key={`out-${y}`} cx={module.x + module.width} cy={y} r="9" fill="#0F1114" stroke="#8B949E" strokeWidth="3" />
        ))}
      </g>
    ))}
    <g fill="none" strokeWidth="5" strokeLinecap="round">
      <path d="M150 92 C 210 92, 200 168, 262 168" stroke="#E8AE1C" />
      <path d="M150 128 C 230 128, 190 236, 262 236" stroke="#2D9CDB" />
      <path d="M394 168 C 450 168, 420 92, 470 92" stroke="#3FB872" />
    </g>
  </svg>
);

const AuthLayout = ({ children }: { children: ReactNode }) => {
  const installer = useInstallPrompt();
  return (
    <main className="auth">
      <section className="auth-art">
        <a className="wordmark" href="/">
          <Logo size={32} />
          UNIVERSAL FLOW AI
        </a>
        <div>
          <h1>Patch any app into any other.</h1>
          <p>Connect AI models, social networks, storage and your own APIs, then wire them into workflows that run on their own.</p>
        </div>
        <PatchIllustration />
        <InstallButton className="install-on-art" available={installer.available} onInstall={() => void installer.install()} />
      </section>
      <section className="auth-form">{children}</section>
    </main>
  );
};

const useSignupState = () => {
  const { session } = useAppState();
  return session && !session.authenticated ? (session.signup ?? 'open') : 'open';
};

export const LoginPage = () => {
  const { api, setSession } = useAppState();
  const signup = useSignupState();
  const { search } = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      setSession(await api.login(email, password));
      navigate(safeReturnPath(search.get('next')), { replace: true });
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <form onSubmit={submit} noValidate>
        {signup === 'first' ? (
          <div className="notice first-run">
            <p>This server has no accounts yet. Create the first one; it will administer this Universal Flow.</p>
            <Link to="/signup" className="btn btn-primary">
              Create the first account
            </Link>
          </div>
        ) : null}
        <h2>Sign in</h2>
        <Field label="Email">{(props) => <input {...props} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />}</Field>
        <Field label="Password">
          {(props) => <input {...props} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />}
        </Field>
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        {signup === 'open' ? (
          <p className="switch">
            New to Universal Flow? <Link to="/signup">Create an account</Link>
          </p>
        ) : null}
        {signup === 'closed' ? <p className="switch">Accounts on this server are created by its administrator.</p> : null}
      </form>
    </AuthLayout>
  );
};

export const SignupPage = () => {
  const { api, setSession } = useAppState();
  const signup = useSignupState();
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (event: ChangeEvent<HTMLInputElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setErrors({});
    try {
      setSession(await api.signup({ ...form, workspaceName: form.workspaceName || `${form.name}'s workspace` }));
      navigate('/integrations', { replace: true });
    } catch (caught) {
      if (caught instanceof ApiError && caught.issues.length > 0) {
        setErrors(Object.fromEntries(caught.issues.map((issue) => [issue.path, issue.message])));
      } else {
        setError(messageOf(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  if (signup === 'closed') {
    return (
      <AuthLayout>
        <div className="auth-closed">
          <h2>Sign-up is closed</h2>
          <p>Accounts on this server are created by its administrator. Ask them for an invitation, then sign in.</p>
          <Link to="/login" className="btn">
            Sign in
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <form onSubmit={submit} noValidate>
        <h2>{signup === 'first' ? 'Create the first account' : 'Create your account'}</h2>
        {signup === 'first' ? <p className="hint">This account administers this server. Afterwards, sign-up closes unless the server allows it.</p> : null}
        <Field label="Your name">{(props) => <input {...props} type="text" autoComplete="name" value={form.name} onChange={set('name')} required />}</Field>
        <Field label="Email" error={errors.email ? `Email ${errors.email}` : undefined}>
          {(props) => <input {...props} type="email" autoComplete="email" value={form.email} onChange={set('email')} required />}
        </Field>
        <Field label="Password" hint="At least 10 characters." error={errors.password ? `Password ${errors.password}` : undefined}>
          {(props) => <input {...props} type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required />}
        </Field>
        <Field label="Workspace name" hint="You can invite your team and add more workspaces later.">
          {(props) => <input {...props} type="text" value={form.workspaceName} placeholder={form.name ? `${form.name}'s workspace` : 'My workspace'} onChange={set('workspaceName')} />}
        </Field>
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" disabled={busy || !form.name || !form.email || !form.password}>
          {busy ? 'Creating account…' : 'Create account'}
        </Button>
        <p className="switch">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </AuthLayout>
  );
};
