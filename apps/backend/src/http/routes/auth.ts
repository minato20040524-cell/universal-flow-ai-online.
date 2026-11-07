import { SESSION_COOKIE, parseCookies } from '../../auth/cookies.js';
import type { AuthService } from '../../services/auth.js';
import { object, string } from '../input.js';
import { requireAuth, type RequestContext, type Route } from '../types.js';

const cookieToken = (context: RequestContext): string | undefined => parseCookies(context.headers.cookie)[SESSION_COOKIE];

export const authRoutes = (auth: AuthService): Route[] => [
  {
    method: 'POST',
    pattern: '/v1/auth/signup',
    access: { kind: 'public' },
    handler: async (context) => {
      const body = object(context.body);
      const { cookie, payload } = await auth.signup({
        email: string(body, 'email', { maxLength: 254 }),
        name: string(body, 'name', { maxLength: 100 }),
        password: string(body, 'password', { maxLength: 200 }),
        workspaceName: string(body, 'workspaceName', { maxLength: 100 }),
      });
      return { status: 201, body: payload, headers: { 'set-cookie': cookie } };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/auth/login',
    access: { kind: 'public' },
    handler: async (context) => {
      const body = object(context.body);
      const { cookie, payload } = await auth.login({ email: string(body, 'email', { maxLength: 254 }), password: string(body, 'password', { maxLength: 200 }) }, context.clientIp);
      return { status: 200, body: payload, headers: { 'set-cookie': cookie } };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/auth/session',
    access: { kind: 'public' },
    handler: async (context) => ({ status: 200, body: await auth.session(cookieToken(context)) }),
  },
  {
    method: 'POST',
    pattern: '/v1/auth/logout',
    access: { kind: 'user' },
    handler: async (context) => ({ status: 204, headers: { 'set-cookie': await auth.logout(cookieToken(context)) } }),
  },
  {
    method: 'POST',
    pattern: '/v1/auth/workspace',
    access: { kind: 'user' },
    handler: async (context) =>
      ({ status: 200, body: await auth.switchWorkspace(requireAuth(context), string(object(context.body), 'workspaceId'), cookieToken(context) ?? '') }),
  },
  {
    method: 'POST',
    pattern: '/v1/auth/workspaces',
    access: { kind: 'user' },
    handler: async (context) =>
      ({ status: 201, body: await auth.createWorkspace(requireAuth(context), string(object(context.body), 'name', { maxLength: 100 }), cookieToken(context) ?? '') }),
  },
];
