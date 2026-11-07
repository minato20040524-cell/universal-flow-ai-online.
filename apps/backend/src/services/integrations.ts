import {
  EngineError,
  builtinNodeDefinitions,
  compareSemver,
  generateNodeDefinitions,
  parseManifest,
  type Installation,
  type NodeDefinition,
  type PluginSearch,
  type PluginVersionRecord,
  type TestReport,
} from '@universal-flow/core-engine';
import type { AppContext } from '../context.js';
import type { AuthContext } from '../http/types.js';
import { WEBHOOK_SECRET_PLUGIN_ID } from './constants.js';

export type InstalledIntegration = {
  pluginId: string;
  name: string;
  provider: string;
  category: string;
  icon: string | undefined;
  source: string;
  version: string;
  status: string;
  enabled: boolean;
  grantedPermissions: string[];
  limitations: string[];
  updateAvailable: string | undefined;
};

const isUsableBy = (record: PluginVersionRecord, workspaceId: string) =>
  (record.source !== 'custom' || record.ownerWorkspaceId === workspaceId) &&
  (record.status === 'active' || (record.status === 'testing' && record.ownerWorkspaceId === workspaceId));

export const createIntegrationService = (ctx: AppContext) => {
  const audit = (auth: AuthContext, action: string, target: string, details: Record<string, unknown> = {}) =>
    ctx.workspaces.audit({ workspaceId: auth.workspaceId, actor: auth.actor, action, target, details }, ctx.clock.now());

  const visibleVersion = async (auth: AuthContext, pluginId: string, version: string): Promise<PluginVersionRecord> => {
    const record = await ctx.plugins.getVersion(pluginId, version);
    if (!record || (record.source === 'custom' && record.ownerWorkspaceId !== auth.workspaceId)) {
      throw new EngineError('NOT_FOUND', `Plugin ${pluginId}@${version} is not registered`);
    }
    return record;
  };

  const installationOrThrow = async (auth: AuthContext, pluginId: string): Promise<Installation> => {
    const installation = await ctx.plugins.getInstallation(auth.workspaceId, pluginId);
    if (!installation) throw new EngineError('NOT_FOUND', `Plugin ${pluginId} is not installed`);
    return installation;
  };

  const describe = async (auth: AuthContext, installation: Installation): Promise<InstalledIntegration> => {
    const versions = await ctx.plugins.listVersions(installation.pluginId);
    const installed = versions.find((record) => record.manifest.version === installation.version);
    if (!installed) throw new EngineError('NOT_FOUND', `Plugin ${installation.pluginId}@${installation.version} is not registered`);
    const newest = versions.find((record) => isUsableBy(record, auth.workspaceId));
    const { manifest } = installed;
    return {
      pluginId: manifest.id,
      name: manifest.name,
      provider: manifest.provider,
      category: manifest.category,
      icon: manifest.ui.icon,
      source: installed.source,
      version: manifest.version,
      status: installed.status,
      enabled: installation.enabled,
      grantedPermissions: installation.grantedPermissions,
      limitations: manifest.limitations,
      updateAvailable: newest && compareSemver(newest.manifest.version, installation.version) > 0 ? newest.manifest.version : undefined,
    };
  };

  const nodesFor = (record: PluginVersionRecord): NodeDefinition[] => generateNodeDefinitions(record.manifest);

  return {
    list: async (auth: AuthContext) => Promise.all((await ctx.plugins.listInstallations(auth.workspaceId)).map((installation) => describe(auth, installation))),

    get: async (auth: AuthContext, pluginId: string) => {
      const installation = await installationOrThrow(auth, pluginId);
      const record = await visibleVersion(auth, pluginId, installation.version);
      const credentials = (await ctx.secrets.list(auth.workspaceId)).filter((credential) => credential.pluginId === pluginId);
      return {
        integration: await describe(auth, installation),
        manifest: record.manifest,
        permissions: { declared: record.manifest.permissions, granted: installation.grantedPermissions },
        nodes: nodesFor(record),
        credentials,
      };
    },

    /** Search results plus what the marketplace sorts by: install counts and whether this workspace has it. */
    marketplace: async (auth: AuthContext, query: Omit<PluginSearch, 'workspaceId'>) => {
      const [plugins, counts, installed] = await Promise.all([
        ctx.plugins.search({ ...query, workspaceId: auth.workspaceId }),
        ctx.sql.query('SELECT plugin_id, count(*)::int AS installs FROM installations GROUP BY plugin_id'),
        ctx.plugins.listInstallations(auth.workspaceId),
      ]);
      const installsById = new Map(counts.map((row) => [String(row.plugin_id), Number(row.installs)]));
      const installedIds = new Set(installed.map((installation) => installation.pluginId));
      return plugins
        .filter((plugin) => plugin.id !== WEBHOOK_SECRET_PLUGIN_ID)
        .map((plugin) => ({ ...plugin, installs: installsById.get(plugin.id) ?? 0, installed: installedIds.has(plugin.id) }));
    },

    pluginDetails: async (auth: AuthContext, pluginId: string) => {
      const versions = (await ctx.plugins.listVersions(pluginId)).filter((record) => isUsableBy(record, auth.workspaceId));
      const latest = versions.at(0);
      if (!latest) throw new EngineError('NOT_FOUND', `Plugin ${pluginId} is not available`);
      return {
        manifest: latest.manifest,
        source: latest.source,
        versions: versions.map((record) => ({ version: record.manifest.version, status: record.status, registeredAt: record.registeredAt })),
        nodes: nodesFor(latest),
      };
    },

    registerCustom: async (auth: AuthContext, manifest: unknown) => {
      const record = await ctx.plugins.register(manifest, { source: 'custom', ownerWorkspaceId: auth.workspaceId });
      await audit(auth, 'integration.custom.register', `${record.manifest.id}@${record.manifest.version}`);
      return { plugin: record.manifest, status: record.status, nodes: nodesFor(record) };
    },

    submitCommunity: async (auth: AuthContext, manifest: unknown) => {
      const record = await ctx.plugins.register(manifest, { source: 'community' });
      await audit(auth, 'marketplace.submit', `${record.manifest.id}@${record.manifest.version}`);
      return { plugin: record.manifest, status: record.status };
    },

    registerOfficial: async (auth: AuthContext, manifest: unknown) => {
      // Native plugins ship with code and are registered at boot, never through the API.
      if (parseManifest(manifest, {}).runtime === 'native') throw new EngineError('SECURITY', 'Native plugins can only be registered by the platform at startup');
      const record = await ctx.plugins.register(manifest, { source: 'official' });
      await audit(auth, 'marketplace.official.register', `${record.manifest.id}@${record.manifest.version}`);
      return { plugin: record.manifest, status: record.status };
    },

    review: async (auth: AuthContext, pluginId: string, version: string, decision: 'approve' | 'reject', note: string | undefined) => {
      const record =
        decision === 'approve' ? await ctx.plugins.approve(pluginId, version, note) : await ctx.plugins.reject(pluginId, version, note ?? 'Rejected');
      await audit(auth, `marketplace.${decision}`, `${pluginId}@${version}`, { note });
      return { pluginId, version, status: record.status };
    },

    revoke: async (auth: AuthContext, pluginId: string, note: string) => {
      await ctx.plugins.revoke(pluginId, note);
      await audit(auth, 'marketplace.revoke', pluginId, { note });
    },

    install: async (auth: AuthContext, pluginId: string, options: { version?: string; grantPermissions: string[] }) => {
      const installation = await ctx.plugins.install(auth.workspaceId, pluginId, options);
      await audit(auth, 'integration.install', `${pluginId}@${installation.version}`, { permissions: installation.grantedPermissions });
      return describe(auth, installation);
    },

    previewUpdate: (auth: AuthContext, pluginId: string, version: string | undefined) => ctx.plugins.previewUpdate(auth.workspaceId, pluginId, version),

    update: async (auth: AuthContext, pluginId: string, options: { toVersion?: string; grantPermissions?: string[] }) => {
      const installation = await ctx.plugins.update(auth.workspaceId, pluginId, options);
      await audit(auth, 'integration.update', `${pluginId}@${installation.version}`);
      return describe(auth, installation);
    },

    setEnabled: async (auth: AuthContext, pluginId: string, enabled: boolean) => {
      const installation = await ctx.plugins.setEnabled(auth.workspaceId, pluginId, enabled);
      await audit(auth, enabled ? 'integration.enable' : 'integration.disable', pluginId);
      return describe(auth, installation);
    },

    uninstall: async (auth: AuthContext, pluginId: string, force: boolean) => {
      await ctx.plugins.uninstall(auth.workspaceId, pluginId, { force });
      await audit(auth, 'integration.uninstall', pluginId, { force });
    },

    /** Test API. A custom integration becomes runnable the first time its test passes. */
    test: async (
      auth: AuthContext,
      pluginId: string,
      request: { version?: string; action: string; input: Record<string, unknown>; credentialId?: string },
    ): Promise<{ report: TestReport; activated: boolean }> => {
      const installation = await installationOrThrow(auth, pluginId);
      const record = await visibleVersion(auth, pluginId, request.version ?? installation.version);
      if (record.manifest.runtime !== 'http') throw new EngineError('WORKFLOW', 'Test API checks HTTP integrations; native plugins are tested by their maintainers');
      if (request.credentialId) {
        const credential = await ctx.secrets.info(request.credentialId);
        if (credential?.workspaceId !== auth.workspaceId || credential.pluginId !== pluginId) {
          throw new EngineError('NOT_FOUND', `Credential ${request.credentialId} does not belong to ${pluginId}`);
        }
      }
      const report = await ctx.connector.test({
        manifest: record.manifest,
        actionKey: request.action,
        input: request.input,
        workspaceId: auth.workspaceId,
        credentialId: request.credentialId,
      });
      const activated = report.ok && record.status === 'testing' && record.ownerWorkspaceId === auth.workspaceId;
      if (activated) await ctx.plugins.markTested(pluginId, record.manifest.version);
      await audit(auth, 'integration.test', `${pluginId}@${record.manifest.version}`, { ok: report.ok, status: report.status, activated });
      return { report, activated };
    },

    /** Everything Spatial Studio can place: control nodes plus every enabled integration. */
    palette: async (auth: AuthContext) => {
      const nodes: NodeDefinition[] = builtinNodeDefinitions();
      for (const installation of await ctx.plugins.listInstallations(auth.workspaceId)) {
        if (!installation.enabled || installation.pluginId === WEBHOOK_SECRET_PLUGIN_ID) continue;
        const record = await ctx.plugins.getVersion(installation.pluginId, installation.version);
        if (record && isUsableBy(record, auth.workspaceId)) nodes.push(...nodesFor(record));
      }
      return nodes;
    },
  };
};

export type IntegrationService = ReturnType<typeof createIntegrationService>;
