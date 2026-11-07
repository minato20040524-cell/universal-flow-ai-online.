import { timingSafeEqual } from 'node:crypto';
import {
  EngineError,
  ValidationError,
  createId,
  createWebhookSecret,
  isValidTimeZone,
  nextCronRun,
  parsePluginRef,
  parseWorkflowGraph,
  parseWorkflowSettings,
  unique,
  validateGraph,
  verifyWebhookSignature,
  type Issue,
  type WorkflowGraph,
  type WorkflowNode,
} from '@universal-flow/core-engine';
import type { AppContext } from '../context.js';
import { HttpError, type AuthContext } from '../http/types.js';
import { JOB_TYPES, type RunWorkflowPayload } from '../queue/job-types.js';
import type { WorkflowRecord } from '../repositories/workflow-repository.js';
import {
  TELEGRAM_SECRET_HEADER,
  WEBHOOK_PATH_PREFIX,
  WEBHOOK_SECRET_PLUGIN_ID,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TOKEN_HEADER,
} from './constants.js';

const NAME_MAX_LENGTH = 200;

/** Every node, including those inside loop bodies. */
const allNodes = (graph: WorkflowGraph): WorkflowNode[] =>
  graph.nodes.flatMap((node) => (node.kind === 'loop' ? [node, ...allNodes(node.body)] : [node]));

const pluginIdsOf = (graph: WorkflowGraph): string[] =>
  unique(
    allNodes(graph).flatMap((node) => {
      const ref = node.kind === 'action' ? node.plugin : node.kind === 'trigger' ? node.plugin : undefined;
      const parsed = ref ? parsePluginRef(ref) : undefined;
      return parsed ? [parsed.pluginId] : [];
    }),
  );

const parseDefinition = (input: { graph: unknown; settings: unknown }) => {
  const graph = parseWorkflowGraph(input.graph);
  const issues = validateGraph(graph, { isBody: false });
  if (issues.length > 0) throw new ValidationError('Invalid workflow', issues);
  return { graph, settings: parseWorkflowSettings(input.settings) };
};

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export const createWorkflowService = (ctx: AppContext) => {
  const audit = (auth: AuthContext, action: string, target: string, details: Record<string, unknown> = {}) =>
    ctx.workspaces.audit({ workspaceId: auth.workspaceId, actor: auth.actor, action, target, details }, ctx.clock.now());

  const getOrThrow = async (auth: AuthContext, id: string): Promise<WorkflowRecord> => {
    const workflow = await ctx.workflows.get(auth.workspaceId, id);
    if (!workflow) throw new EngineError('NOT_FOUND', `Workflow ${id} does not exist`);
    return workflow;
  };

  const versionOrThrow = async (workflowId: string, version: number) => {
    const record = await ctx.workflows.getVersion(workflowId, version);
    if (!record) throw new EngineError('NOT_FOUND', `Workflow ${workflowId} has no version ${version}`);
    return record;
  };

  const webhookUrl = (id: string) => `${ctx.publicBaseUrl}${WEBHOOK_PATH_PREFIX}${id}`;

  /** Every plugin a version uses must be installed, enabled and runnable before it may go live. */
  const checkRunnable = async (auth: AuthContext, graph: WorkflowGraph): Promise<void> => {
    const issues: Issue[] = [];
    for (const node of allNodes(graph)) {
      if (node.kind !== 'action') continue;
      try {
        await ctx.plugins.resolveForExecution(auth.workspaceId, node.plugin);
      } catch (error) {
        issues.push({ path: `nodes.${node.id}`, message: error instanceof Error ? error.message : String(error) });
      }
      if (node.credentialId) {
        const credential = await ctx.secrets.info(node.credentialId);
        if (credential?.workspaceId !== auth.workspaceId) issues.push({ path: `nodes.${node.id}.credentialId`, message: 'does not exist in this workspace' });
        else if (credential.pluginId !== parsePluginRef(node.plugin)?.pluginId) {
          issues.push({ path: `nodes.${node.id}.credentialId`, message: `belongs to ${credential.pluginId}, not to this node's plugin` });
        }
      }
    }
    if (issues.length > 0) throw new ValidationError('Workflow cannot run yet', issues);
  };

  const ensureWebhook = async (auth: AuthContext, workflowId: string, triggerNodeId: string) => {
    const existing = await ctx.triggers.findWebhookByNode(workflowId, triggerNodeId);
    if (existing) return existing;
    const secret = await ctx.secrets.put({ workspaceId: auth.workspaceId, pluginId: WEBHOOK_SECRET_PLUGIN_ID, authType: 'none', values: { secret: createWebhookSecret() } });
    const record = { id: createId('hook'), workspaceId: auth.workspaceId, workflowId, triggerNodeId, credentialId: secret.id, createdAt: ctx.clock.now() };
    await ctx.triggers.insertWebhook(record);
    return record;
  };

  const enqueueRun = async (payload: Omit<RunWorkflowPayload, 'executionId'>) => {
    const executionId = createId('exec');
    const { job } = await ctx.queue.enqueue({ type: JOB_TYPES.runWorkflow, payload: { ...payload, executionId }, concurrencyKey: executionId });
    return { executionId, jobId: job.id };
  };

  return {
    list: (auth: AuthContext) => ctx.workflows.list(auth.workspaceId),

    get: async (auth: AuthContext, id: string, version?: number) => {
      const workflow = await getOrThrow(auth, id);
      const record = await versionOrThrow(id, version ?? workflow.currentVersion);
      return { workflow, version: record };
    },

    create: async (auth: AuthContext, input: { name: string; graph: unknown; settings: unknown }) => {
      const { graph, settings } = parseDefinition(input);
      const workflow = await ctx.workflows.create({
        id: createId('wf'),
        workspaceId: auth.workspaceId,
        name: input.name.slice(0, NAME_MAX_LENGTH),
        graph,
        settings,
        pluginIds: pluginIdsOf(graph),
        now: ctx.clock.now(),
      });
      await audit(auth, 'workflow.create', workflow.id);
      return workflow;
    },

    update: async (auth: AuthContext, id: string, input: { name?: string; graph: unknown; settings: unknown; expectedVersion: number }) => {
      const current = await getOrThrow(auth, id);
      const { graph, settings } = parseDefinition(input);
      const workflow = await ctx.workflows.addVersion({
        id,
        workspaceId: auth.workspaceId,
        expectedVersion: input.expectedVersion,
        name: (input.name ?? current.name).slice(0, NAME_MAX_LENGTH),
        graph,
        settings,
        pluginIds: pluginIdsOf(graph),
        now: ctx.clock.now(),
      });
      await audit(auth, 'workflow.update', id, { version: workflow.currentVersion });
      return workflow;
    },

    remove: async (auth: AuthContext, id: string) => {
      await getOrThrow(auth, id);
      await ctx.workflows.delete(auth.workspaceId, id);
      await audit(auth, 'workflow.delete', id);
    },

    /** Goes live: pins a version, opens its webhooks and starts its schedules. */
    activate: async (auth: AuthContext, id: string, requestedVersion?: number) => {
      const workflow = await getOrThrow(auth, id);
      const version = requestedVersion ?? workflow.currentVersion;
      const record = await versionOrThrow(id, version);
      await checkRunnable(auth, record.graph);
      const now = ctx.clock.now();
      const triggers = record.graph.nodes.flatMap((node) => (node.kind === 'trigger' ? [node] : []));

      const webhooks = [];
      for (const trigger of triggers.filter((node) => node.trigger === 'webhook')) {
        const hook = await ensureWebhook(auth, id, trigger.id);
        webhooks.push({ triggerNodeId: trigger.id, webhookId: hook.id, url: webhookUrl(hook.id) });
      }
      const schedules = triggers.flatMap((node) => {
        if (node.trigger !== 'schedule' || !node.schedule) return [];
        const timezone = node.timezone ?? 'UTC';
        if (!isValidTimeZone(timezone)) throw new ValidationError('Invalid schedule', [{ path: `nodes.${node.id}.timezone`, message: 'is not an IANA time zone' }]);
        return [{ workflowId: id, triggerNodeId: node.id, workspaceId: auth.workspaceId, workflowVersion: version, cron: node.schedule, timezone, nextRunAt: nextCronRun(node.schedule, now, timezone) }];
      });
      await ctx.triggers.replaceSchedules(id, schedules);
      const activated = await ctx.workflows.setActive(auth.workspaceId, id, version, now);
      await audit(auth, 'workflow.activate', id, { version });
      return {
        workflow: activated,
        webhooks,
        schedules: schedules.map((schedule) => ({ triggerNodeId: schedule.triggerNodeId, cron: schedule.cron, timezone: schedule.timezone, nextRunAt: schedule.nextRunAt })),
      };
    },

    deactivate: async (auth: AuthContext, id: string) => {
      await getOrThrow(auth, id);
      await ctx.triggers.replaceSchedules(id, []);
      const workflow = await ctx.workflows.setActive(auth.workspaceId, id, undefined, ctx.clock.now());
      await audit(auth, 'workflow.deactivate', id);
      return workflow;
    },

    /** What is live right now, for anyone in the workspace: webhook URLs and upcoming schedule runs, never secrets. */
    liveTriggers: async (auth: AuthContext, id: string) => {
      const workflow = await getOrThrow(auth, id);
      if (!workflow.active || workflow.activeVersion === undefined) return { active: false, version: undefined, webhooks: [], schedules: [] };
      const record = await versionOrThrow(id, workflow.activeVersion);
      const webhookNodes = new Set(record.graph.nodes.flatMap((node) => (node.kind === 'trigger' && node.trigger === 'webhook' ? [node.id] : [])));
      const hooks = (await ctx.triggers.listWebhooks(id)).filter((hook) => webhookNodes.has(hook.triggerNodeId));
      const schedules = await ctx.triggers.listSchedules(id);
      return {
        active: true,
        version: workflow.activeVersion,
        webhooks: hooks.map((hook) => ({ triggerNodeId: hook.triggerNodeId, webhookId: hook.id, url: webhookUrl(hook.id) })),
        schedules: schedules.map((schedule) => ({ triggerNodeId: schedule.triggerNodeId, cron: schedule.cron, timezone: schedule.timezone, nextRunAt: schedule.nextRunAt })),
      };
    },

    /** Admin view with signing secrets, for configuring the calling service. */
    webhooks: async (auth: AuthContext, id: string) => {
      await getOrThrow(auth, id);
      const hooks = await ctx.triggers.listWebhooks(id);
      return Promise.all(
        hooks.map(async (hook) => {
          const { secret } = await ctx.secrets.reveal(hook.credentialId, auth.workspaceId);
          return { triggerNodeId: hook.triggerNodeId, webhookId: hook.id, url: webhookUrl(hook.id), secret };
        }),
      );
    },

    /** Manual run of any saved version; it does not need to be active. */
    run: async (auth: AuthContext, id: string, input: { payload: unknown; version?: number; triggerNodeId?: string }) => {
      const workflow = await getOrThrow(auth, id);
      const version = input.version ?? workflow.currentVersion;
      const record = await versionOrThrow(id, version);
      await checkRunnable(auth, record.graph);
      const queued = await enqueueRun({ workspaceId: auth.workspaceId, workflowId: id, version, triggerNodeId: input.triggerNodeId, payload: input.payload ?? {} });
      await audit(auth, 'workflow.run', id, { version, executionId: queued.executionId });
      return queued;
    },

    /**
     * Inbound webhook. Callers authenticate with an HMAC signature
     * (x-uf-timestamp + x-uf-signature over "timestamp.body") or, for services
     * that can only send a fixed header, with x-uf-webhook-token (or Telegram's
     * x-telegram-bot-api-secret-token, set through setWebhook's secret_token).
     */
    receiveWebhook: async (webhookId: string, request: { rawBody: string; headers: Record<string, string>; query: URLSearchParams }) => {
      const notFound = new HttpError(404, 'NOT_FOUND', 'Unknown webhook');
      const hook = await ctx.triggers.findWebhook(webhookId);
      if (!hook) throw notFound;
      const workflow = await ctx.workflows.get(hook.workspaceId, hook.workflowId);
      if (!workflow?.active || workflow.activeVersion === undefined) throw notFound;
      const record = await versionOrThrow(workflow.id, workflow.activeVersion);
      if (!record.graph.nodes.some((node) => node.kind === 'trigger' && node.id === hook.triggerNodeId && node.trigger === 'webhook')) throw notFound;

      const { secret = '' } = await ctx.secrets.reveal(hook.credentialId, hook.workspaceId);
      const signature = request.headers[WEBHOOK_SIGNATURE_HEADER];
      const token = request.headers[WEBHOOK_TOKEN_HEADER] ?? request.headers[TELEGRAM_SECRET_HEADER];
      const verified = signature
        ? verifyWebhookSignature({ secret, body: request.rawBody, timestampMs: Number(request.headers[WEBHOOK_TIMESTAMP_HEADER]), signature, nowMs: ctx.clock.now() })
        : token !== undefined && safeEqual(token, secret);
      if (!verified) throw new HttpError(401, 'INVALID_SIGNATURE', 'Webhook signature or token is missing or wrong');

      let body: unknown = request.rawBody;
      if (request.headers['content-type']?.includes('application/json') && request.rawBody !== '') {
        try {
          body = JSON.parse(request.rawBody);
        } catch {
          throw new HttpError(400, 'INVALID_JSON', 'Body is not valid JSON');
        }
      }
      const payload = {
        body,
        query: Object.fromEntries(request.query.entries()),
        headers: { 'content-type': request.headers['content-type'], 'user-agent': request.headers['user-agent'] },
        receivedAt: new Date(ctx.clock.now()).toISOString(),
      };
      return enqueueRun({ workspaceId: hook.workspaceId, workflowId: workflow.id, version: workflow.activeVersion, triggerNodeId: hook.triggerNodeId, payload });
    },
  };
};

export type WorkflowService = ReturnType<typeof createWorkflowService>;
