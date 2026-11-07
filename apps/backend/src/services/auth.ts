import { EngineError, ValidationError } from '@universal-flow/core-engine';
import { DUMMY_HASH, hashPassword, passwordProblem, verifyPassword } from '../auth/passwords.js';
import { clearedSessionCookie, csrfTokenFor, sessionCookie } from '../auth/cookies.js';
import type { AppContext } from '../context.js';
import { HttpError, type AuthContext } from '../http/types.js';
import { normalizeEmail, type SessionContext, type UserRepository } from '../repositories/user-repository.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const THROTTLE = { maxFailures: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 } as const;

export type AuthOptions = {
  users: UserRepository;
  /** Derived from the master key; signs CSRF tokens. */
  sessionSecret: Buffer;
  secureCookies: boolean;
  allowSignup: boolean;
  sessionTtlMs: number;
};

/**
 * Who may create an account: `first` while the platform has no users (that
 * account becomes the platform administrator), then `open` or `closed`
 * depending on ALLOW_SIGNUP.
 */
export type SignupState = 'first' | 'open' | 'closed';

export type SessionPayload = {
  authenticated: true;
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  workspace: { id: string; name: string };
  role: string;
  workspaces: { id: string; name: string; role: string }[];
  csrfToken: string;
};

export const createAuthService = (ctx: AppContext, options: AuthOptions) => {
  const { users } = options;
  const maxAgeSeconds = Math.floor(options.sessionTtlMs / 1000);

  const payloadFor = async (session: SessionContext): Promise<SessionPayload> => {
    const memberships = await users.memberships(session.userId);
    const current = memberships.find((membership) => membership.workspaceId === session.workspaceId);
    return {
      authenticated: true,
      user: { id: session.userId, email: session.email, name: session.name, isPlatformAdmin: session.isPlatformAdmin },
      workspace: { id: session.workspaceId, name: current?.workspaceName ?? '' },
      role: session.role,
      workspaces: memberships.map((membership) => ({ id: membership.workspaceId, name: membership.workspaceName, role: membership.role })),
      csrfToken: csrfTokenFor(options.sessionSecret, session.id),
    };
  };

  const startSession = async (userId: string, workspaceId: string) => {
    const now = ctx.clock.now();
    const { token } = await users.createSession({ userId, workspaceId, now, ttlMs: options.sessionTtlMs });
    const session = await users.resolveSession(token, now);
    if (!session) throw new EngineError('CONFLICT', 'Session could not be started');
    return { cookie: sessionCookie(token, { secure: options.secureCookies, maxAgeSeconds }), payload: await payloadFor(session) };
  };

  const signupState = async (): Promise<SignupState> => {
    if ((await users.count()) === 0) return 'first';
    return options.allowSignup ? 'open' : 'closed';
  };

  const audit = (workspaceId: string, actor: string, action: string, details: Record<string, unknown> = {}) =>
    ctx.workspaces.audit({ workspaceId, actor, action, target: actor, details }, ctx.clock.now());

  return {
    /** Resolves a cookie into the request's auth context; used by the HTTP server for every request. */
    authenticate: async (sessionToken: string): Promise<AuthContext | undefined> => {
      const session = await users.resolveSession(sessionToken, ctx.clock.now());
      if (!session) return undefined;
      return {
        via: 'session',
        workspaceId: session.workspaceId,
        role: session.role,
        tokenId: session.id,
        isPlatformAdmin: session.isPlatformAdmin,
        actor: `user:${session.userId}`,
        userId: session.userId,
        csrfToken: csrfTokenFor(options.sessionSecret, session.id),
      };
    },

    signup: async (input: { email: string; name: string; password: string; workspaceName: string }) => {
      const state = await signupState();
      if (state === 'closed') throw new HttpError(403, 'SIGNUP_CLOSED', 'Sign-up is closed; ask an administrator for an account');
      const email = normalizeEmail(input.email);
      const issues = [
        ...(EMAIL_PATTERN.test(email) ? [] : [{ path: 'email', message: 'is not a valid email address' }]),
        ...(passwordProblem(input.password) ? [{ path: 'password', message: passwordProblem(input.password) ?? '' }] : []),
      ];
      if (issues.length > 0) throw new ValidationError('Invalid sign-up', issues);
      const now = ctx.clock.now();
      const user = await users.create({ email, name: input.name.trim(), passwordHash: await hashPassword(input.password), isPlatformAdmin: state === 'first', now });
      const workspace = await ctx.workspaces.createWorkspace(input.workspaceName.trim(), now);
      await users.addMembership(user.id, workspace.id, 'owner', now);
      await audit(workspace.id, `user:${user.id}`, 'auth.signup');
      return startSession(user.id, workspace.id);
    },

    /**
     * Same answer and similar timing for an unknown email and a wrong password.
     * Five failures in 15 minutes lock the email and the client address for 15 minutes.
     */
    login: async (input: { email: string; password: string }, clientIp: string) => {
      const now = ctx.clock.now();
      const email = normalizeEmail(input.email);
      const keys = [`email:${email}`, `ip:${clientIp}`];
      for (const key of keys) {
        const lockedUntil = await users.lockedUntil(key, now);
        if (lockedUntil !== undefined) {
          const seconds = Math.ceil((lockedUntil - now) / 1000);
          throw new HttpError(429, 'TOO_MANY_ATTEMPTS', `Too many failed sign-ins; try again in ${Math.ceil(seconds / 60)} minutes`, { 'retry-after': String(seconds) });
        }
      }
      const user = await users.findByEmail(email);
      const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
      if (!user || !passwordOk) {
        for (const key of keys) await users.recordFailure(key, now, THROTTLE);
        throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is wrong');
      }
      await users.clearFailures(`email:${email}`);
      const [first] = await users.memberships(user.id);
      if (!first) throw new HttpError(403, 'NO_WORKSPACE', 'This account does not belong to any workspace yet');
      await audit(first.workspaceId, `user:${user.id}`, 'auth.login', { clientIp });
      return startSession(user.id, first.workspaceId);
    },

    session: async (sessionToken: string | undefined): Promise<SessionPayload | { authenticated: false; signup: SignupState }> => {
      const session = sessionToken ? await users.resolveSession(sessionToken, ctx.clock.now()) : undefined;
      return session ? payloadFor(session) : { authenticated: false, signup: await signupState() };
    },

    logout: async (sessionToken: string | undefined) => {
      if (sessionToken) await users.revokeSession(sessionToken, ctx.clock.now());
      return clearedSessionCookie(options.secureCookies);
    },

    switchWorkspace: async (auth: AuthContext, workspaceId: string, sessionToken: string) => {
      const memberships = await users.memberships(auth.userId ?? '');
      if (!memberships.some((membership) => membership.workspaceId === workspaceId)) throw new EngineError('NOT_FOUND', `Workspace ${workspaceId} does not exist`);
      await users.switchWorkspace(auth.tokenId, workspaceId);
      const session = await users.resolveSession(sessionToken, ctx.clock.now());
      if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'Your session has ended; sign in again');
      return payloadFor(session);
    },

    createWorkspace: async (auth: AuthContext, name: string, sessionToken: string) => {
      const now = ctx.clock.now();
      const workspace = await ctx.workspaces.createWorkspace(name.trim(), now);
      await users.addMembership(auth.userId ?? '', workspace.id, 'owner', now);
      await users.switchWorkspace(auth.tokenId, workspace.id);
      await audit(workspace.id, auth.actor, 'workspace.create');
      const session = await users.resolveSession(sessionToken, now);
      if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'Your session has ended; sign in again');
      return payloadFor(session);
    },
  };
};

export type AuthService = ReturnType<typeof createAuthService>;
