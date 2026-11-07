import { ENGINE_VERSION, EngineError, ValidationError } from '@universal-flow/core-engine';
import type { AppContext } from '../../context.js';
import { isRole } from '../../repositories/workspace-repository.js';
import type { CredentialService } from '../../services/credentials.js';
import { OAUTH_CALLBACK_PATH } from '../../services/constants.js';
import { object, optionalInteger, optionalString, queryInteger, queryString, string, stringMap } from '../input.js';
import { HttpError, requireAuth, type Route } from '../types.js';

const ok = (body: unknown, status = 200) => ({ status, body });
const param = (params: Record<string, string>, key: string): string => params[key] ?? '';

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

const page = (title: string, message: string) => ({
  status: 200,
  contentType: 'text/html; charset=utf-8',
  headers: { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" },
  body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;margin:3rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`,
});

export const systemRoutes = (ctx: AppContext, credentials: CredentialService): Route[] => [
  {
    method: 'GET',
    pattern: '/health',
    access: { kind: 'public' },
    handler: async () => {
      await ctx.sql.query('SELECT 1 AS ok');
      return ok({ status: 'ok', engine: ENGINE_VERSION, queue: await ctx.queue.counts() });
    },
  },
  {
    method: 'GET',
    pattern: '/v1/me',
    access: { kind: 'workspace', minRole: 'viewer' },
    handler: async (context) => {
      const auth = requireAuth(context);
      return ok({ workspace: await ctx.workspaces.getWorkspace(auth.workspaceId), role: auth.role, tokenId: auth.tokenId, isPlatformAdmin: auth.isPlatformAdmin });
    },
  },
  {
    method: 'GET',
    pattern: '/v1/categories',
    access: { kind: 'workspace', minRole: 'viewer' },
    handler: async () => ok({ categories: await ctx.categories.list() }),
  },
  {
    method: 'POST',
    pattern: '/v1/categories',
    access: { kind: 'platform-admin' },
    handler: async (context) => {
      const body = object(context.body);
      const icon = optionalString(body, 'icon');
      return ok(await ctx.categories.add({ slug: string(body, 'slug'), name: string(body, 'name'), ...(icon ? { icon } : {}) }), 201);
    },
  },
  {
    method: 'PATCH',
    pattern: '/v1/categories/:slug',
    access: { kind: 'platform-admin' },
    handler: async (context) => {
      const body = object(context.body);
      const name = optionalString(body, 'name');
      const icon = optionalString(body, 'icon');
      const sortOrder = optionalInteger(body, 'sortOrder', { min: 0, max: 10_000 });
      return ok(await ctx.categories.update(param(context.params, 'slug'), { ...(name ? { name } : {}), ...(icon ? { icon } : {}), ...(sortOrder === undefined ? {} : { sortOrder }) }));
    },
  },
  {
    method: 'DELETE',
    pattern: '/v1/categories/:slug',
    access: { kind: 'platform-admin' },
    handler: async (context) => {
      const slug = param(context.params, 'slug');
      await ctx.categories.remove(slug, { isInUse: async (candidate) => (await ctx.sql.query('SELECT 1 FROM plugin_versions WHERE category = $1 LIMIT 1', [candidate])).length > 0 });
      return { status: 204 };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/credentials',
    access: { kind: 'workspace', minRole: 'viewer' },
    handler: async (context) => ok({ credentials: await credentials.list(requireAuth(context)) }),
  },
  {
    method: 'POST',
    pattern: '/v1/credentials',
    access: { kind: 'workspace', minRole: 'admin' },
    handler: async (context) => {
      const body = object(context.body);
      const expiresAt = body.expiresAt === undefined ? undefined : Date.parse(string(body, 'expiresAt'));
      if (expiresAt !== undefined && !Number.isFinite(expiresAt)) throw new ValidationError('Invalid request', [{ path: 'expiresAt', message: 'must be an ISO date' }]);
      return ok(
        await credentials.create(requireAuth(context), { pluginId: string(body, 'pluginId'), values: stringMap(body, 'values'), ...(expiresAt === undefined ? {} : { expiresAt }) }),
        201,
      );
    },
  },
  {
    method: 'DELETE',
    pattern: '/v1/credentials/:id',
    access: { kind: 'workspace', minRole: 'admin' },
    handler: async (context) => {
      await credentials.remove(requireAuth(context), param(context.params, 'id'));
      return { status: 204 };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/oauth/:pluginId/start',
    access: { kind: 'workspace', minRole: 'admin' },
    handler: async (context) => {
      const body = object(context.body);
      const clientSecret = optionalString(body, 'clientSecret');
      return ok(await credentials.startOAuth(requireAuth(context), param(context.params, 'pluginId'), { clientId: string(body, 'clientId'), ...(clientSecret ? { clientSecret } : {}) }), 201);
    },
  },
  {
    method: 'GET',
    pattern: OAUTH_CALLBACK_PATH,
    access: { kind: 'public' },
    handler: async (context) => {
      const providerError = queryString(context.query, 'error');
      if (providerError) return page('Connection cancelled', `The provider reported: ${providerError}. You can close this window.`);
      const state = queryString(context.query, 'state');
      const code = queryString(context.query, 'code');
      if (!state || !code) throw new HttpError(400, 'INVALID_CALLBACK', 'Missing state or code');
      try {
        await credentials.completeOAuth(state, code);
        return page('Account connected', 'You can close this window and return to UNIVERSAL FLOW AI.');
      } catch (error) {
        if (!(error instanceof EngineError)) {
          console.error(JSON.stringify({ level: 'error', requestId: context.requestId, message: error instanceof Error ? error.stack ?? error.message : String(error) }));
        }
        const message = error instanceof EngineError ? error.message : 'Something went wrong while connecting the account.';
        return { ...page('Connection failed', message), status: 400 };
      }
    },
  },
  {
    method: 'GET',
    pattern: '/v1/tokens',
    access: { kind: 'workspace', minRole: 'admin' },
    handler: async (context) => ok({ tokens: await ctx.workspaces.listTokens(requireAuth(context).workspaceId) }),
  },
  {
    method: 'POST',
    pattern: '/v1/tokens',
    access: { kind: 'workspace', minRole: 'owner' },
    handler: async (context) => {
      const auth = requireAuth(context);
      const body = object(context.body);
      const role = body.role;
      if (!isRole(role)) throw new ValidationError('Invalid request', [{ path: 'role', message: 'must be viewer, editor, admin or owner' }]);
      const created = await ctx.workspaces.createToken({ workspaceId: auth.workspaceId, name: string(body, 'name', { maxLength: 100 }), role, now: ctx.clock.now() });
      await ctx.workspaces.audit({ workspaceId: auth.workspaceId, actor: auth.actor, action: 'token.create', target: created.info.id, details: { role } }, ctx.clock.now());
      return ok({ token: created.token, info: created.info, note: 'Store this token now; it is not shown again.' }, 201);
    },
  },
  {
    method: 'DELETE',
    pattern: '/v1/tokens/:id',
    access: { kind: 'workspace', minRole: 'owner' },
    handler: async (context) => {
      const auth = requireAuth(context);
      await ctx.workspaces.revokeToken(auth.workspaceId, param(context.params, 'id'), ctx.clock.now());
      await ctx.workspaces.audit({ workspaceId: auth.workspaceId, actor: auth.actor, action: 'token.revoke', target: param(context.params, 'id') }, ctx.clock.now());
      return { status: 204 };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/audit',
    access: { kind: 'workspace', minRole: 'admin' },
    handler: async (context) => ok({ entries: await ctx.workspaces.listAudit(requireAuth(context).workspaceId, queryInteger(context.query, 'limit', 100, { min: 1, max: 500 })) }),
  },
];
