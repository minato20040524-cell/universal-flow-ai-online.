import { EngineError, isStringArray, parseWorkflowGraph, parseWorkflowSettings, type Workflow, type WorkflowGraph, type WorkflowSettings } from '@universal-flow/core-engine';
import { col, jsonParam, ts, type SqlClient, type SqlRow } from '../db/sql.js';

export type WorkflowRecord = {
  id: string;
  workspaceId: string;
  name: string;
  currentVersion: number;
  active: boolean;
  activeVersion: number | undefined;
  createdAt: number;
  updatedAt: number;
};

export type WorkflowVersionRecord = {
  workflowId: string;
  version: number;
  graph: WorkflowGraph;
  settings: WorkflowSettings;
  pluginIds: string[];
  createdAt: number;
};

export type WorkflowRepository = {
  create: (input: { id: string; workspaceId: string; name: string; graph: WorkflowGraph; settings: WorkflowSettings; pluginIds: string[]; now: number }) => Promise<WorkflowRecord>;
  /** Adds an immutable version and makes it current. Fails if someone else saved first. */
  addVersion: (input: { id: string; workspaceId: string; expectedVersion: number; name: string; graph: WorkflowGraph; settings: WorkflowSettings; pluginIds: string[]; now: number }) => Promise<WorkflowRecord>;
  get: (workspaceId: string, id: string) => Promise<WorkflowRecord | undefined>;
  list: (workspaceId: string) => Promise<WorkflowRecord[]>;
  getVersion: (workflowId: string, version: number) => Promise<WorkflowVersionRecord | undefined>;
  setActive: (workspaceId: string, id: string, activeVersion: number | undefined, now: number) => Promise<WorkflowRecord>;
  delete: (workspaceId: string, id: string) => Promise<void>;
  /** Used by the plugin registry to refuse uninstalling a plugin that active workflows still need. */
  isPluginUsedByActiveWorkflow: (workspaceId: string, pluginId: string) => Promise<boolean>;
  /** Loads a pinned version as the engine's Workflow type. */
  loadForExecution: (workflowId: string, version: number) => Promise<Workflow | undefined>;
};

const toWorkflow = (row: SqlRow): WorkflowRecord => ({
  id: col.string(row, 'id'),
  workspaceId: col.string(row, 'workspace_id'),
  name: col.string(row, 'name'),
  currentVersion: col.number(row, 'current_version'),
  active: col.boolean(row, 'active'),
  activeVersion: col.optionalNumber(row, 'active_version'),
  createdAt: col.epoch(row, 'created_at'),
  updatedAt: col.epoch(row, 'updated_at'),
});

const toVersion = (row: SqlRow): WorkflowVersionRecord => {
  const pluginIds = col.json(row, 'plugin_ids');
  return {
    workflowId: col.string(row, 'workflow_id'),
    version: col.number(row, 'version'),
    graph: parseWorkflowGraph(col.json(row, 'graph')),
    settings: parseWorkflowSettings(col.json(row, 'settings')),
    pluginIds: isStringArray(pluginIds) ? pluginIds : [],
    createdAt: col.epoch(row, 'created_at'),
  };
};

export const createPgWorkflowRepository = (sql: SqlClient): WorkflowRepository => {
  const getOrThrow = async (workspaceId: string, id: string) => {
    const [row] = await sql.query('SELECT * FROM workflows WHERE workspace_id = $1 AND id = $2', [workspaceId, id]);
    if (!row) throw new EngineError('NOT_FOUND', `Workflow ${id} does not exist`);
    return toWorkflow(row);
  };

  return {
    create: async ({ id, workspaceId, name, graph, settings, pluginIds, now }) => {
      // One statement, so the workflow never exists without its first version.
      const [row] = await sql.query(
        `WITH workflow AS (
           INSERT INTO workflows (id, workspace_id, name, current_version, active, created_at, updated_at)
           VALUES ($1, $2, $3, 1, false, $4::timestamptz, $4::timestamptz) RETURNING *
         ), version AS (
           INSERT INTO workflow_versions (workflow_id, version, graph, settings, plugin_ids, created_at)
           SELECT id, 1, $5::jsonb, $6::jsonb, $7::jsonb, $4::timestamptz FROM workflow RETURNING version
         )
         SELECT workflow.* FROM workflow, version`,
        [id, workspaceId, name, ts(now), jsonParam(graph), jsonParam(settings), jsonParam(pluginIds)],
      );
      if (!row) throw new EngineError('CONFLICT', `Workflow ${id} could not be created`);
      return toWorkflow(row);
    },

    addVersion: async ({ id, workspaceId, expectedVersion, name, graph, settings, pluginIds, now }) => {
      const [row] = await sql.query(
        `WITH bumped AS (
           UPDATE workflows SET current_version = current_version + 1, name = $4, updated_at = $5::timestamptz
           WHERE workspace_id = $1 AND id = $2 AND current_version = $3::int RETURNING *
         ), version AS (
           INSERT INTO workflow_versions (workflow_id, version, graph, settings, plugin_ids, created_at)
           SELECT id, current_version, $6::jsonb, $7::jsonb, $8::jsonb, $5::timestamptz FROM bumped RETURNING version
         )
         SELECT bumped.* FROM bumped, version`,
        [workspaceId, id, expectedVersion, name, ts(now), jsonParam(graph), jsonParam(settings), jsonParam(pluginIds)],
      );
      if (!row) {
        await getOrThrow(workspaceId, id);
        throw new EngineError('CONFLICT', `Workflow ${id} was changed by someone else; reload version ${expectedVersion + 1} or later first`);
      }
      return toWorkflow(row);
    },

    get: async (workspaceId, id) => {
      const [row] = await sql.query('SELECT * FROM workflows WHERE workspace_id = $1 AND id = $2', [workspaceId, id]);
      return row ? toWorkflow(row) : undefined;
    },

    list: async (workspaceId) => (await sql.query('SELECT * FROM workflows WHERE workspace_id = $1 ORDER BY updated_at DESC', [workspaceId])).map(toWorkflow),

    getVersion: async (workflowId, version) => {
      const [row] = await sql.query('SELECT * FROM workflow_versions WHERE workflow_id = $1 AND version = $2::int', [workflowId, version]);
      return row ? toVersion(row) : undefined;
    },

    setActive: async (workspaceId, id, activeVersion, now) => {
      const [row] = await sql.query(
        `UPDATE workflows SET active = $3::boolean, active_version = $4::int, updated_at = $5::timestamptz
         WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [workspaceId, id, activeVersion !== undefined, activeVersion ?? null, ts(now)],
      );
      if (!row) throw new EngineError('NOT_FOUND', `Workflow ${id} does not exist`);
      return toWorkflow(row);
    },

    delete: async (workspaceId, id) => {
      const rows = await sql.query('DELETE FROM workflows WHERE workspace_id = $1 AND id = $2 RETURNING id', [workspaceId, id]);
      if (rows.length === 0) throw new EngineError('NOT_FOUND', `Workflow ${id} does not exist`);
    },

    isPluginUsedByActiveWorkflow: async (workspaceId, pluginId) => {
      const rows = await sql.query(
        `SELECT 1 FROM workflows w JOIN workflow_versions v ON v.workflow_id = w.id AND v.version = w.active_version
         WHERE w.workspace_id = $1 AND w.active AND v.plugin_ids @> jsonb_build_array($2::text) LIMIT 1`,
        [workspaceId, pluginId],
      );
      return rows.length > 0;
    },

    loadForExecution: async (workflowId, version) => {
      const [row] = await sql.query(
        `SELECT w.id, w.workspace_id, w.name, v.version, v.graph, v.settings, v.plugin_ids, v.created_at, v.workflow_id
         FROM workflows w JOIN workflow_versions v ON v.workflow_id = w.id WHERE w.id = $1 AND v.version = $2::int`,
        [workflowId, version],
      );
      if (!row) return undefined;
      const versionRecord = toVersion(row);
      return {
        id: col.string(row, 'id'),
        workspaceId: col.string(row, 'workspace_id'),
        name: col.string(row, 'name'),
        version: versionRecord.version,
        graph: versionRecord.graph,
        settings: versionRecord.settings,
      };
    },
  };
};

