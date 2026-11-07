import { EngineError, ValidationError } from '../errors.js';
import { parseManifest } from '../manifest/parse-manifest.js';
import type { PluginManifest, PluginSource } from '../manifest/types.js';
import { compareSemver, satisfies } from '../semver.js';
import { sha256, stableStringify, systemClock, unique, type Clock } from '../util.js';
import type { CategoryRegistry } from './category-registry.js';
import { createInMemoryPluginStore, type Installation, type PluginStore, type PluginVersionRecord, type VersionStatus } from './stores.js';

export type { Installation, PluginVersionRecord, VersionStatus } from './stores.js';

export type PluginSummary = {
  id: string;
  name: string;
  provider: string;
  category: string;
  description: string | undefined;
  source: PluginSource;
  version: string;
  status: VersionStatus;
  icon: string | undefined;
  limitations: string[];
  registeredAt: number;
  /** Data ports of the first action (or trigger), for drawing the module's jacks. */
  ports: { inputs: number; outputs: number };
};

export type PluginSearch = {
  text?: string;
  category?: string;
  provider?: string;
  source?: PluginSource;
  /** The workspace searching; required to see its own custom plugins. */
  workspaceId?: string;
};

export type PermissionDiff = { added: string[]; removed: string[] };
export type UpdatePreview = { from: string; to: string; permissions: PermissionDiff };
export type RegisterOptions = { source: PluginSource; ownerWorkspaceId?: string };

export type PluginRegistry = {
  register: (manifest: unknown, options: RegisterOptions) => Promise<PluginVersionRecord>;
  markTested: (pluginId: string, version: string) => Promise<PluginVersionRecord>;
  approve: (pluginId: string, version: string, note?: string) => Promise<PluginVersionRecord>;
  reject: (pluginId: string, version: string, note: string) => Promise<PluginVersionRecord>;
  revoke: (pluginId: string, note: string) => Promise<void>;
  getVersion: (pluginId: string, version: string) => Promise<PluginVersionRecord | undefined>;
  listVersions: (pluginId: string) => Promise<PluginVersionRecord[]>;
  search: (query?: PluginSearch) => Promise<PluginSummary[]>;
  install: (workspaceId: string, pluginId: string, options: { version?: string; grantPermissions: string[] }) => Promise<Installation>;
  previewUpdate: (workspaceId: string, pluginId: string, toVersion?: string) => Promise<UpdatePreview>;
  update: (workspaceId: string, pluginId: string, options: { toVersion?: string; grantPermissions?: string[] }) => Promise<Installation>;
  setEnabled: (workspaceId: string, pluginId: string, enabled: boolean) => Promise<Installation>;
  uninstall: (workspaceId: string, pluginId: string, options?: { force?: boolean }) => Promise<void>;
  getInstallation: (workspaceId: string, pluginId: string) => Promise<Installation | undefined>;
  listInstallations: (workspaceId: string) => Promise<Installation[]>;
  /** The manifest a workflow node may run with, or an error explaining why it may not. */
  resolveForExecution: (workspaceId: string, pluginRef: string) => Promise<PluginManifest>;
};

export type PluginRegistryOptions = {
  categories: CategoryRegistry;
  engineVersion: string;
  store?: PluginStore;
  clock?: Clock;
  /** Lets uninstall refuse while active workflows still use the plugin. */
  isPluginInUse?: (workspaceId: string, pluginId: string) => Promise<boolean> | boolean;
};

export type PluginRef = { pluginId: string; version: string };

export const parsePluginRef = (ref: string): PluginRef | undefined => {
  const separator = ref.lastIndexOf('@');
  if (separator <= 0 || separator === ref.length - 1) return undefined;
  return { pluginId: ref.slice(0, separator), version: ref.slice(separator + 1) };
};

export const formatPluginRef = ({ pluginId, version }: PluginRef): string => `${pluginId}@${version}`;

const INITIAL_STATUS: Record<PluginSource, VersionStatus> = {
  official: 'active',
  community: 'pending_review',
  custom: 'testing',
};

const diffPermissions = (from: readonly string[], to: readonly string[]): PermissionDiff => ({
  added: to.filter((permission) => !from.includes(permission)),
  removed: from.filter((permission) => !to.includes(permission)),
});

const missingPermissions = (required: readonly string[], granted: readonly string[]): string[] =>
  required.filter((permission) => !granted.includes(permission));

const newestFirst = (records: PluginVersionRecord[]): PluginVersionRecord[] =>
  records.sort((a, b) => compareSemver(b.manifest.version, a.manifest.version));

const isVisibleTo = (record: PluginVersionRecord, workspaceId: string | undefined): boolean =>
  record.source !== 'custom' || record.ownerWorkspaceId === workspaceId;

const isInstallableBy = (record: PluginVersionRecord, workspaceId: string): boolean =>
  isVisibleTo(record, workspaceId) &&
  (record.status === 'active' || (record.status === 'testing' && record.ownerWorkspaceId === workspaceId));

const portCounts = (manifest: PluginVersionRecord['manifest']): PluginSummary['ports'] => {
  const action = manifest.actions.at(0);
  const count = (properties: Record<string, unknown> | undefined) => Object.keys(properties ?? {}).length;
  if (action) return { inputs: count(action.inputSchema.properties), outputs: Math.max(1, count(action.outputSchema.properties)) };
  const trigger = manifest.triggers.at(0);
  return { inputs: 0, outputs: trigger ? Math.max(1, count(trigger.outputSchema.properties)) : 0 };
};

const toSummary = (record: PluginVersionRecord): PluginSummary => ({
  id: record.manifest.id,
  name: record.manifest.name,
  provider: record.manifest.provider,
  category: record.manifest.category,
  description: record.manifest.description,
  source: record.source,
  version: record.manifest.version,
  status: record.status,
  icon: record.manifest.ui.icon,
  limitations: [...record.manifest.limitations],
  registeredAt: record.registeredAt,
  ports: portCounts(record.manifest),
});

export const createPluginRegistry = (options: PluginRegistryOptions): PluginRegistry => {
  const clock = options.clock ?? systemClock;
  const store = options.store ?? createInMemoryPluginStore();

  const versionsOf = async (pluginId: string) => newestFirst(await store.listVersions(pluginId));

  const findVersion = async (pluginId: string, version: string): Promise<PluginVersionRecord> => {
    const record = await store.getVersion(pluginId, version);
    if (!record) throw new EngineError('NOT_FOUND', `Plugin ${pluginId}@${version} is not registered`);
    return record;
  };

  const findInstallation = async (workspaceId: string, pluginId: string): Promise<Installation> => {
    const installation = await store.getInstallation(workspaceId, pluginId);
    if (!installation) throw new EngineError('NOT_FOUND', `Plugin ${pluginId} is not installed in workspace ${workspaceId}`);
    return installation;
  };

  const transition = async (pluginId: string, version: string, from: readonly VersionStatus[], to: VersionStatus, note?: string) => {
    const record = await findVersion(pluginId, version);
    if (!from.includes(record.status)) {
      throw new EngineError('CONFLICT', `Plugin ${pluginId}@${version} is ${record.status}; expected ${from.join(' or ')}`);
    }
    const updated: PluginVersionRecord = { ...record, status: to, reviewNote: note ?? record.reviewNote };
    await store.updateVersion(updated);
    return updated;
  };

  const latestInstallable = async (pluginId: string, workspaceId: string): Promise<PluginVersionRecord> => {
    const record = (await versionsOf(pluginId)).find((candidate) => isInstallableBy(candidate, workspaceId));
    if (!record) throw new EngineError('NOT_FOUND', `No installable version of ${pluginId} is available`);
    return record;
  };

  const install: PluginRegistry['install'] = async (workspaceId, pluginId, { version, grantPermissions }) => {
    const record = version ? await findVersion(pluginId, version) : await latestInstallable(pluginId, workspaceId);
    if (!isVisibleTo(record, workspaceId)) throw new EngineError('NOT_FOUND', `Plugin ${pluginId}@${record.manifest.version} is not registered`);
    if (!isInstallableBy(record, workspaceId)) {
      throw new EngineError('PERMISSION', `Plugin ${pluginId}@${record.manifest.version} is ${record.status} and cannot be installed`);
    }
    if (await store.getInstallation(workspaceId, pluginId)) {
      throw new EngineError('CONFLICT', `Plugin ${pluginId} is already installed; use update instead`);
    }
    const missing = missingPermissions(record.manifest.permissions, grantPermissions);
    if (missing.length > 0) throw new EngineError('PERMISSION', `Permissions not granted: ${missing.join(', ')}`);
    const now = clock.now();
    const installation: Installation = {
      workspaceId,
      pluginId,
      version: record.manifest.version,
      enabled: true,
      grantedPermissions: [...record.manifest.permissions],
      installedAt: now,
      updatedAt: now,
    };
    await store.insertInstallation(installation);
    return installation;
  };

  const previewUpdate: PluginRegistry['previewUpdate'] = async (workspaceId, pluginId, toVersion) => {
    const installation = await findInstallation(workspaceId, pluginId);
    const target = toVersion ? await findVersion(pluginId, toVersion) : await latestInstallable(pluginId, workspaceId);
    if (!isInstallableBy(target, workspaceId)) {
      throw new EngineError('PERMISSION', `Plugin ${pluginId}@${target.manifest.version} is ${target.status}`);
    }
    if (compareSemver(target.manifest.version, installation.version) <= 0) {
      throw new EngineError('CONFLICT', `${pluginId}@${target.manifest.version} is not newer than ${installation.version}`);
    }
    return {
      from: installation.version,
      to: target.manifest.version,
      permissions: diffPermissions(installation.grantedPermissions, target.manifest.permissions),
    };
  };

  return {
    register: async (input, { source, ownerWorkspaceId }) => {
      const categories = new Set((await options.categories.list()).map((category) => category.slug));
      const manifest = parseManifest(input, { categoryExists: (slug) => categories.has(slug) });
      if (!satisfies(options.engineVersion, manifest.engine)) {
        throw new ValidationError('Incompatible plugin', [
          { path: '$.engine', message: `requires engine ${manifest.engine}, running ${options.engineVersion}` },
        ]);
      }
      if (manifest.runtime === 'native' && source !== 'official') {
        throw new EngineError('SECURITY', 'Only official plugins may use the native runtime');
      }
      if (source === 'custom' && !ownerWorkspaceId) {
        throw new ValidationError('Invalid registration', [{ path: 'ownerWorkspaceId', message: 'is required for custom plugins' }]);
      }
      const owner = source === 'custom' ? ownerWorkspaceId : undefined;
      const existingVersions = await versionsOf(manifest.id);
      const newest = existingVersions.at(0);
      if (newest && (newest.source !== source || newest.ownerWorkspaceId !== owner)) {
        throw new EngineError('CONFLICT', `Plugin id ${manifest.id} already belongs to another publisher`);
      }
      const checksum = sha256(stableStringify(manifest));
      const sameVersion = existingVersions.find((record) => record.manifest.version === manifest.version);
      if (sameVersion) {
        if (sameVersion.checksum === checksum) return sameVersion;
        throw new EngineError('CONFLICT', `${manifest.id}@${manifest.version} is already registered with different content; bump the version`);
      }
      const record: PluginVersionRecord = {
        manifest,
        source,
        status: INITIAL_STATUS[source],
        checksum,
        ownerWorkspaceId: owner,
        registeredAt: clock.now(),
        reviewNote: undefined,
      };
      await store.insertVersion(record);
      // The workspace that builds a custom integration has implicitly granted what it declared.
      if (owner && !(await store.getInstallation(owner, manifest.id))) {
        await install(owner, manifest.id, { version: manifest.version, grantPermissions: manifest.permissions });
      }
      return record;
    },

    markTested: (pluginId, version) => transition(pluginId, version, ['testing'], 'active'),
    approve: (pluginId, version, note) => transition(pluginId, version, ['pending_review'], 'active', note),
    reject: (pluginId, version, note) => transition(pluginId, version, ['pending_review', 'testing'], 'rejected', note),

    revoke: async (pluginId, note) => {
      const records = await versionsOf(pluginId);
      if (records.length === 0) throw new EngineError('NOT_FOUND', `Plugin ${pluginId} is not registered`);
      for (const record of records) await store.updateVersion({ ...record, status: 'revoked', reviewNote: note });
      for (const installation of await store.listInstallationsOfPlugin(pluginId)) {
        await store.updateInstallation({ ...installation, enabled: false, updatedAt: clock.now() });
      }
    },

    getVersion: (pluginId, version) => store.getVersion(pluginId, version),
    listVersions: versionsOf,

    search: async (query = {}) => {
      const text = query.text?.trim().toLowerCase();
      const byPlugin = new Map<string, PluginVersionRecord[]>();
      for (const record of await store.listAllVersions()) {
        const list = byPlugin.get(record.manifest.id) ?? [];
        list.push(record);
        byPlugin.set(record.manifest.id, list);
      }
      const summaries: PluginSummary[] = [];
      for (const records of byPlugin.values()) {
        const shown = newestFirst(records).find(
          (record) => isVisibleTo(record, query.workspaceId) && (record.status === 'active' || record.source === 'custom'),
        );
        if (!shown || shown.status === 'revoked' || shown.status === 'rejected') continue;
        const { manifest } = shown;
        if (query.category && manifest.category !== query.category) continue;
        if (query.source && shown.source !== query.source) continue;
        if (query.provider && manifest.provider.toLowerCase() !== query.provider.toLowerCase()) continue;
        const haystack = [manifest.id, manifest.name, manifest.provider, manifest.description ?? ''].join(' ').toLowerCase();
        if (text && !haystack.includes(text)) continue;
        summaries.push(toSummary(shown));
      }
      return summaries.sort((a, b) => a.name.localeCompare(b.name));
    },

    install,
    previewUpdate,

    update: async (workspaceId, pluginId, { toVersion, grantPermissions = [] }) => {
      const preview = await previewUpdate(workspaceId, pluginId, toVersion);
      const missing = missingPermissions(preview.permissions.added, grantPermissions);
      if (missing.length > 0) throw new EngineError('PERMISSION', `New permissions not granted: ${missing.join(', ')}`);
      const installation = await findInstallation(workspaceId, pluginId);
      const target = await findVersion(pluginId, preview.to);
      // Older pinned versions keep running, so permissions only ever accumulate here.
      const updated: Installation = {
        ...installation,
        version: preview.to,
        grantedPermissions: unique([...installation.grantedPermissions, ...target.manifest.permissions]),
        updatedAt: clock.now(),
      };
      await store.updateInstallation(updated);
      return updated;
    },

    setEnabled: async (workspaceId, pluginId, enabled) => {
      const installation = await findInstallation(workspaceId, pluginId);
      if (enabled) {
        const current = await findVersion(pluginId, installation.version);
        if (current.status === 'revoked') throw new EngineError('PERMISSION', `Plugin ${pluginId} was revoked and cannot be enabled`);
      }
      const updated: Installation = { ...installation, enabled, updatedAt: clock.now() };
      await store.updateInstallation(updated);
      return updated;
    },

    uninstall: async (workspaceId, pluginId, { force = false } = {}) => {
      await findInstallation(workspaceId, pluginId);
      if (!force && (await options.isPluginInUse?.(workspaceId, pluginId))) {
        throw new EngineError('CONFLICT', `Plugin ${pluginId} is used by active workflows; disable them first or force the uninstall`);
      }
      await store.deleteInstallation(workspaceId, pluginId);
    },

    getInstallation: (workspaceId, pluginId) => store.getInstallation(workspaceId, pluginId),
    listInstallations: (workspaceId) => store.listInstallations(workspaceId),

    resolveForExecution: async (workspaceId, pluginRef) => {
      const ref = parsePluginRef(pluginRef);
      if (!ref) throw new ValidationError('Invalid plugin reference', [{ path: 'plugin', message: `"${pluginRef}" must look like id@version` }]);
      const installation = await findInstallation(workspaceId, ref.pluginId);
      if (!installation.enabled) throw new EngineError('PERMISSION', `Plugin ${ref.pluginId} is disabled in this workspace`);
      const record = await findVersion(ref.pluginId, ref.version);
      if (!isVisibleTo(record, workspaceId)) throw new EngineError('NOT_FOUND', `Plugin ${pluginRef} is not registered`);
      if (record.status !== 'active') throw new EngineError('PERMISSION', `Plugin ${pluginRef} is ${record.status} and cannot run yet`);
      const missing = missingPermissions(record.manifest.permissions, installation.grantedPermissions);
      if (missing.length > 0) throw new EngineError('PERMISSION', `Permissions not granted for ${pluginRef}: ${missing.join(', ')}`);
      return record.manifest;
    },
  };
};
