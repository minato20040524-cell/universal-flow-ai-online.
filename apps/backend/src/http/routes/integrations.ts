import { PLUGIN_SOURCES, ValidationError } from '@universal-flow/core-engine';
import type { IntegrationService } from '../../services/integrations.js';
import { object, optionalString, queryString, string, stringList } from '../input.js';
import { requireAuth, type Route } from '../types.js';

const ok = (body: unknown, status = 200) => ({ status, body });
const param = (params: Record<string, string>, key: string): string => params[key] ?? '';

const sourceFilter = (value: string | undefined) => {
  if (value === undefined) return {};
  const source = PLUGIN_SOURCES.find((candidate) => candidate === value);
  if (!source) throw new ValidationError('Invalid request', [{ path: 'source', message: `must be one of ${PLUGIN_SOURCES.join(', ')}` }]);
  return { source };
};

export const integrationRoutes = (integrations: IntegrationService): Route[] => [
  {
    method: 'GET',
    pattern: '/v1/marketplace',
    access: { kind: 'workspace', minRole: 'viewer' },
    handler: async (context) => {
      const { query } = context;
      const text = queryString(query, 'text');
      const category = queryString(query, 'category');
      const provider = queryString(query, 'provider');
      return ok({
        plugins: await integrations.marketplace(requireAuth(context), {
          ...(text ? { text } : {}),
          ...(category ? { category } : {}),
          ...(provider ? { provider } : {}),
          ...sourceFilter(queryString(query, 'source')),
        }),
      });
    },
  },
  {
    method: 'GET',
    pattern: '/v1/marketplace/:pluginId',
    access: { kind: 'workspace', minRole: 'viewer' },
    handler: async (context) => ok(await integrations.pluginDetails(requireAuth(context), param(context.params, 'pluginId'))),
  },
  {
    method: 'POST',
    pattern: '/v1/marketplace/submissions',
    access: { kind: 'workspace', minRole: 'editor' },
    handler: async (context) => ok(await integrations.submitCommunity(requireAuth(context), object(context.body).manifest), 201),
  },
  {
    method: 'GET',
    pattern: '/v1/integrations',
    access: { kind: 'workspace', minRole: 'viewer' },
    handler: async (context) => ok({ integrations: await integrations.list(requireAuth(context)) }),
  },
  {
    method: 'POST',
    pattern: '/v1/integrations/custom',
    access: { kind: 'workspace', minRole: 'editor' },
    handler: async (context) => ok(await integrations.registerCustom(requireAuth(context), object(context.body).manifest), 201),
  },
  {
    // Import Integration: the same as building one, from a manifest file.
    method: 'POST',
    pattern: '/v1/integrations/import',
    access: { kind: 'workspace', minRole: 'editor' },
    handler: async (context) => ok(await integrations.registerCustom(requireAuth(context), object(context.body).manifest), 201),
  },
  {
    method: 'GET',
    pattern: '/v1/integrations/:pluginId',
    access: { kind: 'workspace', minRole: 'viewer' },
    handler: async (context) => ok(await integrations.get(requireAuth(context), param(context.params, 'pluginId'))),
  },
  {
    method: 'POST',
    pattern: '/v1/integrations/:pluginId/install',
    access: { kind: 'workspace', minRole: 'admin' },
    handler: async (context) => {
      const body = object(context.body ?? {});
      const version = optionalString(body, 'version');
      return ok(
        await integrations.install(requireAuth(context), param(context.params, 'pluginId'), {
          grantPermissions: stringList(body, 'grantPermissions'),
          ...(version ? { version } : {}),
        }),
        201,
      );
    },
  },
  {
    method: 'GET',
    pattern: '/v1/integrations/:pluginId/update-preview',
    access: { kind: 'workspace', minRole: 'admin' },
    handler: async (context) => ok(await integrations.previewUpdate(requireAuth(context), param(context.params, 'pluginId'), queryString(context.query, 'version'))),
  },
  {
    method: 'POST',
    pattern: '/v1/integrations/:pluginId/update',
    access: { kind: 'workspace', minRole: 'admin' },
    handler: async (context) => {
      const body = object(context.body ?? {});
      const toVersion = optionalString(body, 'version');
      return ok(
        await integrations.update(requireAuth(context), param(context.params, 'pluginId'), {
          grantPermissions: stringList(body, 'grantPermissions'),
          ...(toVersion ? { toVersion } : {}),
        }),
      );
    },
  },
  {
    method: 'POST',
    pattern: '/v1/integrations/:pluginId/enable',
    access: { kind: 'workspace', minRole: 'admin' },
    handler: async (context) => ok(await integrations.setEnabled(requireAuth(context), param(context.params, 'pluginId'), true)),
  },
  {
    method: 'POST',
    pattern: '/v1/integrations/:pluginId/disable',
    access: { kind: 'workspace', minRole: 'admin' },
    handler: async (context) => ok(await integrations.setEnabled(requireAuth(context), param(context.params, 'pluginId'), false)),
  },
  {
    method: 'DELETE',
    pattern: '/v1/integrations/:pluginId',
    access: { kind: 'workspace', minRole: 'admin' },
    handler: async (context) => {
      await integrations.uninstall(requireAuth(context), param(context.params, 'pluginId'), context.query.get('force') === 'true');
      return { status: 204 };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/integrations/:pluginId/test',
    access: { kind: 'workspace', minRole: 'editor' },
    handler: async (context) => {
      const body = object(context.body);
      const input = body.input === undefined ? {} : object(body.input, 'input');
      const version = optionalString(body, 'version');
      const credentialId = optionalString(body, 'credentialId');
      return ok(
        await integrations.test(requireAuth(context), param(context.params, 'pluginId'), {
          action: string(body, 'action'),
          input,
          ...(version ? { version } : {}),
          ...(credentialId ? { credentialId } : {}),
        }),
      );
    },
  },
  {
    method: 'GET',
    pattern: '/v1/nodes',
    access: { kind: 'workspace', minRole: 'viewer' },
    handler: async (context) => ok({ nodes: await integrations.palette(requireAuth(context)) }),
  },
  {
    method: 'POST',
    pattern: '/v1/admin/plugins',
    access: { kind: 'platform-admin' },
    handler: async (context) => ok(await integrations.registerOfficial(requireAuth(context), object(context.body).manifest), 201),
  },
  {
    method: 'POST',
    pattern: '/v1/admin/plugins/:pluginId/versions/:version/approve',
    access: { kind: 'platform-admin' },
    handler: async (context) =>
      ok(await integrations.review(requireAuth(context), param(context.params, 'pluginId'), param(context.params, 'version'), 'approve', optionalString(object(context.body ?? {}), 'note'))),
  },
  {
    method: 'POST',
    pattern: '/v1/admin/plugins/:pluginId/versions/:version/reject',
    access: { kind: 'platform-admin' },
    handler: async (context) =>
      ok(await integrations.review(requireAuth(context), param(context.params, 'pluginId'), param(context.params, 'version'), 'reject', string(object(context.body), 'note'))),
  },
  {
    method: 'POST',
    pattern: '/v1/admin/plugins/:pluginId/revoke',
    access: { kind: 'platform-admin' },
    handler: async (context) => {
      await integrations.revoke(requireAuth(context), param(context.params, 'pluginId'), string(object(context.body), 'note'));
      return { status: 204 };
    },
  },
];
