import type { ApiConnector } from '../connector/api-connector.js';
import { EngineError, ValidationError } from '../errors.js';
import type { PluginRegistry } from '../registry/plugin-registry.js';
import { validateValue } from '../schema/json-schema.js';
import type { SecretStore, SecretValues } from '../security/secret-store.js';
import type { ActionRunner } from './engine.js';

export type NativeHandlerContext = {
  input: Record<string, unknown>;
  credentials: SecretValues;
  workspaceId: string;
  executionId: string;
};

export type NativeHandler = (context: NativeHandlerContext) => Promise<unknown>;

export type NativeHandlers = {
  register: (pluginId: string, actionKey: string, handler: NativeHandler) => void;
  get: (pluginId: string, actionKey: string) => NativeHandler | undefined;
};

/** Code handlers for official native plugins (trusted code shipped with the platform). */
export const createNativeHandlers = (): NativeHandlers => {
  const handlers = new Map<string, NativeHandler>();
  const key = (pluginId: string, actionKey: string) => `${pluginId}:${actionKey}`;
  return {
    register: (pluginId, actionKey, handler) => {
      handlers.set(key(pluginId, actionKey), handler);
    },
    get: (pluginId, actionKey) => handlers.get(key(pluginId, actionKey)),
  };
};

export type PluginActionRunnerOptions = {
  registry: PluginRegistry;
  connector: ApiConnector;
  secrets: SecretStore;
  native?: NativeHandlers;
};

/** Connects the workflow engine to installed plugins: pinned version, permissions, credentials, runtime. */
export const createPluginActionRunner = ({ registry, connector, secrets, native }: PluginActionRunnerOptions): ActionRunner => async (invocation) => {
  const manifest = await registry.resolveForExecution(invocation.workspaceId, invocation.plugin);
  if (manifest.runtime === 'http') {
    const result = await connector.execute({
      manifest,
      actionKey: invocation.action,
      input: invocation.input,
      workspaceId: invocation.workspaceId,
      credentialId: invocation.credentialId,
    });
    return result.output;
  }

  const action = manifest.actions.find((candidate) => candidate.key === invocation.action);
  const handler = native?.get(manifest.id, invocation.action);
  if (!action || !handler) throw new EngineError('NOT_FOUND', `No handler for ${manifest.id}:${invocation.action}`);
  const issues = validateValue(action.inputSchema, invocation.input, '$.input');
  if (issues.length > 0) throw new ValidationError('Invalid action input', issues);
  if (invocation.credentialId) {
    const info = await secrets.info(invocation.credentialId);
    if (info?.workspaceId !== invocation.workspaceId || info.pluginId !== manifest.id) {
      throw new EngineError('PERMISSION', `Credential ${invocation.credentialId} is not connected to ${manifest.id}`);
    }
  }
  const credentials = invocation.credentialId ? await secrets.reveal(invocation.credentialId, invocation.workspaceId) : {};
  return handler({ input: invocation.input, credentials, workspaceId: invocation.workspaceId, executionId: invocation.executionId });
};
