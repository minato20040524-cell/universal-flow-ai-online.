import {
  EngineError,
  isStringArray,
  parseManifest,
  type Category,
  type CategoryStore,
  type Installation,
  type PluginSource,
  type PluginStore,
  type PluginVersionRecord,
  type VersionStatus,
} from '@universal-flow/core-engine';
import { col, isUniqueViolation, jsonParam, ts, type SqlClient, type SqlRow } from '../db/sql.js';

const SOURCES: readonly PluginSource[] = ['official', 'community', 'custom'];
const STATUSES: readonly VersionStatus[] = ['testing', 'pending_review', 'active', 'rejected', 'revoked'];

const oneOf = <T extends string>(allowed: readonly T[], value: string, column: string): T => {
  const match = allowed.find((candidate) => candidate === value);
  if (!match) throw new EngineError('WORKFLOW', `Unexpected ${column} "${value}" in database`);
  return match;
};

const toCategory = (row: SqlRow): Category => ({
  slug: col.string(row, 'slug'),
  name: col.string(row, 'name'),
  icon: col.optionalString(row, 'icon'),
  sortOrder: col.number(row, 'sort_order'),
  isSystem: col.boolean(row, 'is_system'),
});

export const createPgCategoryStore = (sql: SqlClient): CategoryStore => ({
  list: async () => (await sql.query('SELECT * FROM categories ORDER BY sort_order')).map(toCategory),
  get: async (slug) => {
    const [row] = await sql.query('SELECT * FROM categories WHERE slug = $1', [slug]);
    return row ? toCategory(row) : undefined;
  },
  insert: async (category) => {
    const rows = await sql.query(
      `INSERT INTO categories (slug, name, icon, sort_order, is_system) VALUES ($1, $2, $3, $4::int, $5::boolean)
       ON CONFLICT (slug) DO NOTHING RETURNING slug`,
      [category.slug, category.name, category.icon ?? null, category.sortOrder, category.isSystem],
    );
    if (rows.length === 0) throw new EngineError('CONFLICT', `Category "${category.slug}" already exists`);
  },
  update: async (category) => {
    await sql.query('UPDATE categories SET name = $2, icon = $3, sort_order = $4::int WHERE slug = $1 RETURNING slug', [
      category.slug,
      category.name,
      category.icon ?? null,
      category.sortOrder,
    ]);
  },
  delete: async (slug) => {
    await sql.query('DELETE FROM categories WHERE slug = $1 RETURNING slug', [slug]);
  },
});

const toVersionRecord = (row: SqlRow): PluginVersionRecord => ({
  // Stored manifests were validated on the way in; parsing again keeps the types honest.
  manifest: parseManifest(col.json(row, 'manifest')),
  source: oneOf(SOURCES, col.string(row, 'source'), 'source'),
  status: oneOf(STATUSES, col.string(row, 'status'), 'status'),
  checksum: col.string(row, 'checksum'),
  ownerWorkspaceId: col.optionalString(row, 'owner_workspace_id'),
  registeredAt: col.epoch(row, 'registered_at'),
  reviewNote: col.optionalString(row, 'review_note'),
});

const toInstallation = (row: SqlRow): Installation => {
  const granted = col.json(row, 'granted_permissions');
  return {
    workspaceId: col.string(row, 'workspace_id'),
    pluginId: col.string(row, 'plugin_id'),
    version: col.string(row, 'version'),
    enabled: col.boolean(row, 'enabled'),
    grantedPermissions: isStringArray(granted) ? granted : [],
    installedAt: col.epoch(row, 'installed_at'),
    updatedAt: col.epoch(row, 'updated_at'),
  };
};

export const createPgPluginStore = (sql: SqlClient): PluginStore => ({
  getVersion: async (pluginId, version) => {
    const [row] = await sql.query('SELECT * FROM plugin_versions WHERE plugin_id = $1 AND version = $2', [pluginId, version]);
    return row ? toVersionRecord(row) : undefined;
  },
  listVersions: async (pluginId) => (await sql.query('SELECT * FROM plugin_versions WHERE plugin_id = $1', [pluginId])).map(toVersionRecord),
  listAllVersions: async () => (await sql.query('SELECT * FROM plugin_versions')).map(toVersionRecord),

  insertVersion: async (record) => {
    const { manifest } = record;
    const rows = await sql.query(
      `INSERT INTO plugin_versions
         (plugin_id, version, source, status, owner_workspace_id, name, provider, category, manifest, checksum, review_note, registered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::timestamptz)
       ON CONFLICT (plugin_id, version) DO NOTHING
       RETURNING plugin_id`,
      [
        manifest.id,
        manifest.version,
        record.source,
        record.status,
        record.ownerWorkspaceId ?? null,
        manifest.name,
        manifest.provider,
        manifest.category,
        jsonParam(manifest),
        record.checksum,
        record.reviewNote ?? null,
        ts(record.registeredAt),
      ],
    );
    if (rows.length === 0) throw new EngineError('CONFLICT', `${manifest.id}@${manifest.version} already exists`);
  },

  updateVersion: async (record) => {
    await sql.query(
      'UPDATE plugin_versions SET status = $3, review_note = $4 WHERE plugin_id = $1 AND version = $2 RETURNING plugin_id',
      [record.manifest.id, record.manifest.version, record.status, record.reviewNote ?? null],
    );
  },

  getInstallation: async (workspaceId, pluginId) => {
    const [row] = await sql.query('SELECT * FROM installations WHERE workspace_id = $1 AND plugin_id = $2', [workspaceId, pluginId]);
    return row ? toInstallation(row) : undefined;
  },
  listInstallations: async (workspaceId) =>
    (await sql.query('SELECT * FROM installations WHERE workspace_id = $1 ORDER BY plugin_id', [workspaceId])).map(toInstallation),
  listInstallationsOfPlugin: async (pluginId) =>
    (await sql.query('SELECT * FROM installations WHERE plugin_id = $1', [pluginId])).map(toInstallation),

  insertInstallation: async (installation) => {
    try {
      const rows = await sql.query(
        `INSERT INTO installations (workspace_id, plugin_id, version, enabled, granted_permissions, installed_at, updated_at)
         VALUES ($1, $2, $3, $4::boolean, $5::jsonb, $6::timestamptz, $7::timestamptz)
         ON CONFLICT (workspace_id, plugin_id) DO NOTHING
         RETURNING plugin_id`,
        [
          installation.workspaceId,
          installation.pluginId,
          installation.version,
          installation.enabled,
          jsonParam(installation.grantedPermissions),
          ts(installation.installedAt),
          ts(installation.updatedAt),
        ],
      );
      if (rows.length === 0) throw new EngineError('CONFLICT', `Plugin ${installation.pluginId} is already installed`);
    } catch (error) {
      if (isUniqueViolation(error)) throw new EngineError('CONFLICT', `Plugin ${installation.pluginId} is already installed`);
      throw error;
    }
  },

  updateInstallation: async (installation) => {
    await sql.query(
      `UPDATE installations SET version = $3, enabled = $4::boolean, granted_permissions = $5::jsonb, updated_at = $6::timestamptz
       WHERE workspace_id = $1 AND plugin_id = $2 RETURNING plugin_id`,
      [
        installation.workspaceId,
        installation.pluginId,
        installation.version,
        installation.enabled,
        jsonParam(installation.grantedPermissions),
        ts(installation.updatedAt),
      ],
    );
  },

  deleteInstallation: async (workspaceId, pluginId) => {
    await sql.query('DELETE FROM installations WHERE workspace_id = $1 AND plugin_id = $2 RETURNING plugin_id', [workspaceId, pluginId]);
  },
});
