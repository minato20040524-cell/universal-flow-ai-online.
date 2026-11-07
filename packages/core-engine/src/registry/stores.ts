import { EngineError } from '../errors.js';
import type { PluginManifest, PluginSource } from '../manifest/types.js';
import { DEFAULT_CATEGORIES, type Category } from './category-data.js';

/**
 * Lifecycle of one plugin version:
 * - official → active
 * - community → pending_review → active | rejected   (security review before anyone can use it)
 * - custom → testing → active                        (active once Test API has passed)
 * Any version can later be revoked, which disables it everywhere.
 */
export type VersionStatus = 'testing' | 'pending_review' | 'active' | 'rejected' | 'revoked';

export type PluginVersionRecord = {
  manifest: PluginManifest;
  source: PluginSource;
  status: VersionStatus;
  checksum: string;
  /** Custom plugins belong to one workspace and are invisible to others. */
  ownerWorkspaceId: string | undefined;
  registeredAt: number;
  reviewNote: string | undefined;
};

export type Installation = {
  workspaceId: string;
  pluginId: string;
  version: string;
  enabled: boolean;
  grantedPermissions: string[];
  installedAt: number;
  updatedAt: number;
};

/**
 * Persistence behind the plugin registry. Inserts must fail with a CONFLICT
 * EngineError when the key already exists (a unique constraint in SQL), so two
 * concurrent registrations or installs can never both win.
 */
export type PluginStore = {
  getVersion: (pluginId: string, version: string) => Promise<PluginVersionRecord | undefined>;
  listVersions: (pluginId: string) => Promise<PluginVersionRecord[]>;
  /** Whole catalog, used by search. Replace with a SQL-side search once the catalog is large. */
  listAllVersions: () => Promise<PluginVersionRecord[]>;
  insertVersion: (record: PluginVersionRecord) => Promise<void>;
  updateVersion: (record: PluginVersionRecord) => Promise<void>;
  getInstallation: (workspaceId: string, pluginId: string) => Promise<Installation | undefined>;
  listInstallations: (workspaceId: string) => Promise<Installation[]>;
  listInstallationsOfPlugin: (pluginId: string) => Promise<Installation[]>;
  insertInstallation: (installation: Installation) => Promise<void>;
  updateInstallation: (installation: Installation) => Promise<void>;
  deleteInstallation: (workspaceId: string, pluginId: string) => Promise<void>;
};

export type CategoryStore = {
  list: () => Promise<Category[]>;
  get: (slug: string) => Promise<Category | undefined>;
  insert: (category: Category) => Promise<void>;
  update: (category: Category) => Promise<void>;
  delete: (slug: string) => Promise<void>;
};

const copy = <T>(value: T): T => structuredClone(value);

export const createInMemoryPluginStore = (): PluginStore => {
  const versions = new Map<string, PluginVersionRecord>();
  const installations = new Map<string, Installation>();
  const versionKey = (pluginId: string, version: string) => `${pluginId}@${version}`;
  const installationKey = (workspaceId: string, pluginId: string) => `${workspaceId}::${pluginId}`;

  return {
    getVersion: async (pluginId, version) => {
      const record = versions.get(versionKey(pluginId, version));
      return record ? copy(record) : undefined;
    },
    listVersions: async (pluginId) => [...versions.values()].filter((record) => record.manifest.id === pluginId).map(copy),
    listAllVersions: async () => [...versions.values()].map(copy),
    insertVersion: async (record) => {
      const key = versionKey(record.manifest.id, record.manifest.version);
      if (versions.has(key)) throw new EngineError('CONFLICT', `${key} already exists`);
      versions.set(key, copy(record));
    },
    updateVersion: async (record) => {
      versions.set(versionKey(record.manifest.id, record.manifest.version), copy(record));
    },
    getInstallation: async (workspaceId, pluginId) => {
      const installation = installations.get(installationKey(workspaceId, pluginId));
      return installation ? copy(installation) : undefined;
    },
    listInstallations: async (workspaceId) => [...installations.values()].filter((item) => item.workspaceId === workspaceId).map(copy),
    listInstallationsOfPlugin: async (pluginId) => [...installations.values()].filter((item) => item.pluginId === pluginId).map(copy),
    insertInstallation: async (installation) => {
      const key = installationKey(installation.workspaceId, installation.pluginId);
      if (installations.has(key)) throw new EngineError('CONFLICT', `Plugin ${installation.pluginId} is already installed`);
      installations.set(key, copy(installation));
    },
    updateInstallation: async (installation) => {
      installations.set(installationKey(installation.workspaceId, installation.pluginId), copy(installation));
    },
    deleteInstallation: async (workspaceId, pluginId) => {
      installations.delete(installationKey(workspaceId, pluginId));
    },
  };
};

export const defaultCategoryRecords = (): Category[] =>
  DEFAULT_CATEGORIES.map((category, index) => ({ ...category, sortOrder: index, isSystem: true }));

export const createInMemoryCategoryStore = (seed: readonly Category[] = defaultCategoryRecords()): CategoryStore => {
  const categories = new Map(seed.map((category) => [category.slug, copy(category)]));
  return {
    list: async () => [...categories.values()].map(copy),
    get: async (slug) => {
      const category = categories.get(slug);
      return category ? copy(category) : undefined;
    },
    insert: async (category) => {
      if (categories.has(category.slug)) throw new EngineError('CONFLICT', `Category "${category.slug}" already exists`);
      categories.set(category.slug, copy(category));
    },
    update: async (category) => {
      categories.set(category.slug, copy(category));
    },
    delete: async (slug) => {
      categories.delete(slug);
    },
  };
};
