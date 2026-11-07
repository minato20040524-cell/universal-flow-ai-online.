import { ValidationError, type ExecutionStatus } from '@universal-flow/core-engine';
import type { ExecutionService } from '../../services/executions.js';
import type { WorkflowService } from '../../services/workflows.js';
import { boolean, object, optionalInteger, optionalString, queryInteger, queryString, string } from '../input.js';
import { requireAuth, type Route } from '../types.js';

const ok = (body: unknown, status = 200) => ({ status, body });
const param = (params: Record<string, string>, key: string): string => params[key] ?? '';
const VERSION_RANGE = { min: 1, max: 1_000_000 };
const EXECUTION_STATUSES: readonly ExecutionStatus[] = ['running', 'waiting', 'succeeded', 'failed', 'cancelled'];
const WEBHOOK_MAX_BYTES = 1024 * 1024;

export const workflowRoutes = (workflows: WorkflowService, executions: ExecutionService): Route[] => [
  {
    method: 'GET',
    pattern: '/v1/workflows',
    access: { kind: 'workspace', minRole: 'viewer' },
    handler: async (context) => ok({ workflows: await workflows.list(requireAuth(context)) }),
  },
  {
    method: 'POST',
    pattern: '/v1/workflows',
    access: { kind: 'workspace', minRole: 'editor' },
    handler: async (context) => {
      const body = object(context.body);
      return ok(await workflows.create(requireAuth(context), { name: string(body, 'name', { maxLength: 200 }), graph: body.graph, settings: body.settings }), 201);
    },
  },
  {
    method: 'GET',
    pattern: '/v1/workflows/:id',
    access: { kind: 'workspace', minRole: 'viewer' },
    handler: async (context) => {
      const version = context.query.has('version') ? queryInteger(context.query, 'version', 1, VERSION_RANGE) : undefined;
      return ok(await workflows.get(requireAuth(context), param(context.params, 'id'), version));
    },
  },
  {
    method: 'PUT',
    pattern: '/v1/workflows/:id',
    access: { kind: 'workspace', minRole: 'editor' },
    handler: async (context) => {
      const body = object(context.body);
      const expectedVersion = optionalInteger(body, 'expectedVersion', VERSION_RANGE);
      if (expectedVersion === undefined) {
        throw new ValidationError('Invalid request', [{ path: 'expectedVersion', message: 'is required so concurrent edits are never lost' }]);
      }
      const name = optionalString(body, 'name');
      return ok(await workflows.update(requireAuth(context), param(context.params, 'id'), { graph: body.graph, settings: body.settings, expectedVersion, ...(name ? { name } : {}) }));
    },
  },
  {
    method: 'DELETE',
    pattern: '/v1/workflows/:id',
    access: { kind: 'workspace', minRole: 'admin' },
    handler: async (context) => {
      await workflows.remove(requireAuth(context), param(context.params, 'id'));
      return { status: 204 };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/workflows/:id/activate',
    access: { kind: 'workspace', minRole: 'editor' },
    handler: async (context) => ok(await workflows.activate(requireAuth(context), param(context.params, 'id'), optionalInteger(object(context.body ?? {}), 'version', VERSION_RANGE))),
  },
  {
    method: 'POST',
    pattern: '/v1/workflows/:id/deactivate',
    access: { kind: 'workspace', minRole: 'editor' },
    handler: async (context) => ok(await workflows.deactivate(requireAuth(context), param(context.params, 'id'))),
  },
  {
    method: 'GET',
    pattern: '/v1/workflows/:id/triggers',
    access: { kind: 'workspace', minRole: 'viewer' },
    handler: async (context) => ok(await workflows.liveTriggers(requireAuth(context), param(context.params, 'id'))),
  },
  {
    method: 'GET',
    pattern: '/v1/workflows/:id/webhooks',
    access: { kind: 'workspace', minRole: 'admin' },
    handler: async (context) => ok({ webhooks: await workflows.webhooks(requireAuth(context), param(context.params, 'id')) }),
  },
  {
    method: 'POST',
    pattern: '/v1/workflows/:id/run',
    access: { kind: 'workspace', minRole: 'editor' },
    handler: async (context) => {
      const body = object(context.body ?? {});
      const version = optionalInteger(body, 'version', VERSION_RANGE);
      const triggerNodeId = optionalString(body, 'triggerNodeId');
      return ok(
        await workflows.run(requireAuth(context), param(context.params, 'id'), {
          payload: body.payload,
          ...(version === undefined ? {} : { version }),
          ...(triggerNodeId ? { triggerNodeId } : {}),
        }),
        202,
      );
    },
  },
  {
    method: 'GET',
    pattern: '/v1/executions',
    access: { kind: 'workspace', minRole: 'viewer' },
    handler: async (context) => {
      const status = queryString(context.query, 'status');
      const knownStatus = EXECUTION_STATUSES.find((candidate) => candidate === status);
      if (status && !knownStatus) throw new ValidationError('Invalid request', [{ path: 'status', message: `must be one of ${EXECUTION_STATUSES.join(', ')}` }]);
      const workflowId = queryString(context.query, 'workflowId');
      return ok({
        executions: await executions.list(requireAuth(context), {
          limit: queryInteger(context.query, 'limit', 50, { min: 1, max: 200 }),
          ...(workflowId ? { workflowId } : {}),
          ...(knownStatus ? { status: knownStatus } : {}),
        }),
      });
    },
  },
  {
    method: 'GET',
    pattern: '/v1/executions/:id',
    access: { kind: 'workspace', minRole: 'viewer' },
    handler: async (context) => ok(await executions.get(requireAuth(context), param(context.params, 'id'))),
  },
  {
    method: 'POST',
    pattern: '/v1/executions/:id/approvals/:nodeId',
    access: { kind: 'workspace', minRole: 'editor' },
    handler: async (context) => {
      const body = object(context.body);
      const comment = optionalString(body, 'comment');
      return ok(
        await executions.decide(requireAuth(context), param(context.params, 'id'), param(context.params, 'nodeId'), {
          approved: boolean(body, 'approved'),
          ...(comment ? { comment } : {}),
        }),
        202,
      );
    },
  },
  {
    method: 'POST',
    pattern: '/v1/executions/:id/cancel',
    access: { kind: 'workspace', minRole: 'editor' },
    handler: async (context) => ok(await executions.cancel(requireAuth(context), param(context.params, 'id'))),
  },
  {
    method: 'POST',
    pattern: '/hooks/:webhookId',
    access: { kind: 'public' },
    maxBodyBytes: WEBHOOK_MAX_BYTES,
    rawBodyOnly: true,
    handler: async (context) =>
      ok(await workflows.receiveWebhook(param(context.params, 'webhookId'), { rawBody: context.rawBody, headers: context.headers, query: context.query }), 202),
  },
];
