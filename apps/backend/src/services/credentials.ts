import {
  CREDENTIAL_FIELDS,
  EngineError,
  ValidationError,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  type CredentialInfo,
  type PluginManifest,
} from '@universal-flow/core-engine';
import type { AppContext } from '../context.js';
import type { AuthContext } from '../http/types.js';
import { OAUTH_CALLBACK_PATH, OAUTH_STATE_TTL_MS, WEBHOOK_SECRET_PLUGIN_ID } from './constants.js';

export const createCredentialService = (ctx: AppContext) => {
  const audit = (auth: AuthContext, action: string, target: string, details: Record<string, unknown> = {}) =>
    ctx.workspaces.audit({ workspaceId: auth.workspaceId, actor: auth.actor, action, target, details }, ctx.clock.now());

  const installedManifest = async (auth: AuthContext, pluginId: string): Promise<{ manifest: PluginManifest; version: string }> => {
    const installation = await ctx.plugins.getInstallation(auth.workspaceId, pluginId);
    if (!installation) throw new EngineError('NOT_FOUND', `Plugin ${pluginId} is not installed`);
    const record = await ctx.plugins.getVersion(pluginId, installation.version);
    if (!record) throw new EngineError('NOT_FOUND', `Plugin ${pluginId}@${installation.version} is not registered`);
    return { manifest: record.manifest, version: installation.version };
  };

  const ownedCredential = async (auth: AuthContext, id: string): Promise<CredentialInfo> => {
    const info = await ctx.secrets.info(id);
    if (!info || info.workspaceId !== auth.workspaceId || info.pluginId === WEBHOOK_SECRET_PLUGIN_ID) {
      throw new EngineError('NOT_FOUND', `Credential ${id} does not exist`);
    }
    return info;
  };

  const redirectUri = () => `${ctx.publicBaseUrl}${OAUTH_CALLBACK_PATH}`;

  return {
    list: async (auth: AuthContext) => (await ctx.secrets.list(auth.workspaceId)).filter((info) => info.pluginId !== WEBHOOK_SECRET_PLUGIN_ID),

    /** Connect Account for API key, bearer and basic auth. */
    create: async (auth: AuthContext, input: { pluginId: string; values: Record<string, string>; expiresAt?: number }) => {
      const { manifest } = await installedManifest(auth, input.pluginId);
      const authType = manifest.auth.type;
      if (authType === 'none') throw new EngineError('VALIDATION', `${manifest.name} does not need an account connection`);
      if (authType === 'oauth2') throw new EngineError('VALIDATION', `${manifest.name} uses OAuth 2.0; start the flow at /v1/oauth/${manifest.id}/start`);
      const missing = CREDENTIAL_FIELDS[authType].filter((field) => !input.values[field]);
      if (missing.length > 0) {
        throw new ValidationError('Incomplete credential', missing.map((field) => ({ path: `values.${field}`, message: 'is required' })));
      }
      const info = await ctx.secrets.put({
        workspaceId: auth.workspaceId,
        pluginId: manifest.id,
        authType,
        values: input.values,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      });
      await audit(auth, 'credential.create', info.id, { pluginId: manifest.id, fields: info.fieldNames });
      return info;
    },

    remove: async (auth: AuthContext, id: string) => {
      await ownedCredential(auth, id);
      await ctx.secrets.remove(id);
      await audit(auth, 'credential.delete', id);
    },

    /** Step 1 of OAuth: the client secret goes straight into the vault, the user is sent to the provider. */
    startOAuth: async (auth: AuthContext, pluginId: string, input: { clientId: string; clientSecret?: string }) => {
      const { manifest, version } = await installedManifest(auth, pluginId);
      if (manifest.auth.type !== 'oauth2') throw new EngineError('VALIDATION', `${manifest.name} does not use OAuth 2.0`);
      const request = createAuthorizationRequest({
        authorizationUrl: manifest.auth.authorizationUrl,
        clientId: input.clientId,
        redirectUri: redirectUri(),
        scopes: manifest.auth.scopes,
      });
      const pending = await ctx.secrets.put({
        workspaceId: auth.workspaceId,
        pluginId,
        authType: 'oauth2',
        values: { clientId: input.clientId, ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}), codeVerifier: request.codeVerifier },
      });
      // Not connected until the callback stores real tokens.
      await ctx.secrets.markError(pending.id);
      await ctx.triggers.insertOAuthState(
        { state: request.state, workspaceId: auth.workspaceId, pluginId, pluginVersion: version, credentialId: pending.id, redirectUri: redirectUri(), expiresAt: ctx.clock.now() + OAUTH_STATE_TTL_MS },
        ctx.clock.now(),
      );
      await audit(auth, 'credential.oauth.start', pending.id, { pluginId });
      return { authorizationUrl: request.url, credentialId: pending.id };
    },

    /** Step 2 of OAuth: the provider redirects here with a one-time code. */
    completeOAuth: async (state: string, code: string) => {
      const pending = await ctx.triggers.consumeOAuthState(state, ctx.clock.now());
      if (!pending) throw new EngineError('VALIDATION', 'This sign-in link has expired or was already used; start again');
      const record = await ctx.plugins.getVersion(pending.pluginId, pending.pluginVersion);
      if (!record || record.manifest.auth.type !== 'oauth2') throw new EngineError('NOT_FOUND', `Plugin ${pending.pluginId} no longer uses OAuth 2.0`);
      const values = await ctx.secrets.reveal(pending.credentialId, pending.workspaceId);
      const { clientId, clientSecret, codeVerifier } = values;
      if (!clientId || !codeVerifier) throw new EngineError('SECURITY', 'The pending OAuth credential is incomplete');
      const tokens = await exchangeAuthorizationCode(ctx.outboundHttp, {
        tokenUrl: record.manifest.auth.tokenUrl,
        code,
        redirectUri: pending.redirectUri,
        clientId,
        clientSecret,
        codeVerifier,
        permissions: record.manifest.permissions,
      });
      const expiresAt = tokens.expiresInSeconds === undefined ? undefined : ctx.clock.now() + tokens.expiresInSeconds * 1000;
      const info = await ctx.secrets.replace(
        pending.credentialId,
        { accessToken: tokens.accessToken, clientId, ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}), ...(clientSecret ? { clientSecret } : {}) },
        expiresAt,
      );
      await ctx.workspaces.audit({ workspaceId: pending.workspaceId, actor: 'oauth-callback', action: 'credential.oauth.complete', target: info.id, details: { pluginId: pending.pluginId } }, ctx.clock.now());
      return info;
    },
  };
};

export type CredentialService = ReturnType<typeof createCredentialService>;
