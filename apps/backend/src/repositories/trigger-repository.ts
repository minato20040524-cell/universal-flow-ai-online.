import { EngineError } from '@universal-flow/core-engine';
import { col, ts, type SqlClient, type SqlRow } from '../db/sql.js';

export type WebhookRecord = {
  id: string;
  workspaceId: string;
  workflowId: string;
  triggerNodeId: string;
  credentialId: string;
  createdAt: number;
};

export type ScheduleRecord = {
  workflowId: string;
  triggerNodeId: string;
  workspaceId: string;
  workflowVersion: number;
  cron: string;
  timezone: string;
  nextRunAt: number;
};

export type OAuthStateRecord = {
  state: string;
  workspaceId: string;
  pluginId: string;
  pluginVersion: string;
  credentialId: string;
  redirectUri: string;
  expiresAt: number;
};

const toWebhook = (row: SqlRow): WebhookRecord => ({
  id: col.string(row, 'id'),
  workspaceId: col.string(row, 'workspace_id'),
  workflowId: col.string(row, 'workflow_id'),
  triggerNodeId: col.string(row, 'trigger_node_id'),
  credentialId: col.string(row, 'credential_id'),
  createdAt: col.epoch(row, 'created_at'),
});

const toSchedule = (row: SqlRow): ScheduleRecord => ({
  workflowId: col.string(row, 'workflow_id'),
  triggerNodeId: col.string(row, 'trigger_node_id'),
  workspaceId: col.string(row, 'workspace_id'),
  workflowVersion: col.number(row, 'workflow_version'),
  cron: col.string(row, 'cron'),
  timezone: col.string(row, 'timezone'),
  nextRunAt: col.epoch(row, 'next_run_at'),
});

export type TriggerRepository = {
  findWebhook: (id: string) => Promise<WebhookRecord | undefined>;
  findWebhookByNode: (workflowId: string, triggerNodeId: string) => Promise<WebhookRecord | undefined>;
  listWebhooks: (workflowId: string) => Promise<WebhookRecord[]>;
  insertWebhook: (record: WebhookRecord) => Promise<void>;

  /** Replaces all schedules of a workflow with the given set (activation) or none (deactivation). */
  replaceSchedules: (workflowId: string, schedules: ScheduleRecord[]) => Promise<void>;
  listSchedules: (workflowId: string) => Promise<ScheduleRecord[]>;
  /** Leases due schedules so only one scheduler instance handles each occurrence. */
  claimDueSchedules: (now: number, leaseMs: number, limit: number) => Promise<ScheduleRecord[]>;
  advanceSchedule: (record: ScheduleRecord, nextRunAt: number) => Promise<boolean>;

  insertOAuthState: (record: OAuthStateRecord, now: number) => Promise<void>;
  /** Reads and deletes in one statement: a state can be used once. */
  consumeOAuthState: (state: string, now: number) => Promise<OAuthStateRecord | undefined>;
};

export const createPgTriggerRepository = (sql: SqlClient): TriggerRepository => ({
  findWebhook: async (id) => {
    const [row] = await sql.query('SELECT * FROM webhooks WHERE id = $1', [id]);
    return row ? toWebhook(row) : undefined;
  },
  findWebhookByNode: async (workflowId, triggerNodeId) => {
    const [row] = await sql.query('SELECT * FROM webhooks WHERE workflow_id = $1 AND trigger_node_id = $2', [workflowId, triggerNodeId]);
    return row ? toWebhook(row) : undefined;
  },
  listWebhooks: async (workflowId) => (await sql.query('SELECT * FROM webhooks WHERE workflow_id = $1 ORDER BY trigger_node_id', [workflowId])).map(toWebhook),
  insertWebhook: async (record) => {
    const rows = await sql.query(
      `INSERT INTO webhooks (id, workspace_id, workflow_id, trigger_node_id, credential_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz) ON CONFLICT (workflow_id, trigger_node_id) DO NOTHING RETURNING id`,
      [record.id, record.workspaceId, record.workflowId, record.triggerNodeId, record.credentialId, ts(record.createdAt)],
    );
    if (rows.length === 0) throw new EngineError('CONFLICT', `Webhook for ${record.workflowId}/${record.triggerNodeId} already exists`);
  },

  replaceSchedules: async (workflowId, schedules) => {
    // One statement: upsert the new set and drop the rest, so readers never see a half-replaced set.
    await sql.query(
      `WITH incoming AS (
         SELECT * FROM jsonb_to_recordset($2::jsonb)
           AS s(trigger_node_id text, workspace_id text, workflow_version int, cron text, timezone text, next_run_at timestamptz)
       ), upserted AS (
         INSERT INTO schedules (workflow_id, trigger_node_id, workspace_id, workflow_version, cron, timezone, next_run_at)
         SELECT $1, trigger_node_id, workspace_id, workflow_version, cron, timezone, next_run_at FROM incoming
         ON CONFLICT (workflow_id, trigger_node_id) DO UPDATE SET
           workflow_version = EXCLUDED.workflow_version, cron = EXCLUDED.cron, timezone = EXCLUDED.timezone,
           next_run_at = EXCLUDED.next_run_at, lease_until = NULL
         RETURNING trigger_node_id
       )
       DELETE FROM schedules
       WHERE workflow_id = $1 AND trigger_node_id NOT IN (SELECT trigger_node_id FROM incoming)
       RETURNING workflow_id`,
      [
        workflowId,
        JSON.stringify(
          schedules.map((schedule) => ({
            trigger_node_id: schedule.triggerNodeId,
            workspace_id: schedule.workspaceId,
            workflow_version: schedule.workflowVersion,
            cron: schedule.cron,
            timezone: schedule.timezone,
            next_run_at: ts(schedule.nextRunAt),
          })),
        ),
      ],
    );
  },

  listSchedules: async (workflowId) => (await sql.query('SELECT * FROM schedules WHERE workflow_id = $1 ORDER BY trigger_node_id', [workflowId])).map(toSchedule),

  claimDueSchedules: async (now, leaseMs, limit) =>
    (
      await sql.query(
        `UPDATE schedules SET lease_until = $1::timestamptz + ($2::int * interval '1 millisecond')
         WHERE (workflow_id, trigger_node_id) IN (
           SELECT workflow_id, trigger_node_id FROM schedules
           WHERE next_run_at <= $1::timestamptz AND (lease_until IS NULL OR lease_until < $1::timestamptz)
           ORDER BY next_run_at LIMIT $3::int
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [ts(now), leaseMs, limit],
      )
    ).map(toSchedule),

  advanceSchedule: async (record, nextRunAt) => {
    const rows = await sql.query(
      `UPDATE schedules SET next_run_at = $4::timestamptz, lease_until = NULL
       WHERE workflow_id = $1 AND trigger_node_id = $2 AND next_run_at = $3::timestamptz RETURNING workflow_id`,
      [record.workflowId, record.triggerNodeId, ts(record.nextRunAt), ts(nextRunAt)],
    );
    return rows.length > 0;
  },

  insertOAuthState: async (record, now) => {
    await sql.query(
      `INSERT INTO oauth_states (state, workspace_id, plugin_id, plugin_version, credential_id, redirect_uri, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz) RETURNING state`,
      [record.state, record.workspaceId, record.pluginId, record.pluginVersion, record.credentialId, record.redirectUri, ts(now), ts(record.expiresAt)],
    );
  },

  consumeOAuthState: async (state, now) => {
    const [row] = await sql.query('DELETE FROM oauth_states WHERE state = $1 AND expires_at > $2::timestamptz RETURNING *', [state, ts(now)]);
    if (!row) return undefined;
    return {
      state: col.string(row, 'state'),
      workspaceId: col.string(row, 'workspace_id'),
      pluginId: col.string(row, 'plugin_id'),
      pluginVersion: col.string(row, 'plugin_version'),
      credentialId: col.string(row, 'credential_id'),
      redirectUri: col.string(row, 'redirect_uri'),
      expiresAt: col.epoch(row, 'expires_at'),
    };
  },
});
