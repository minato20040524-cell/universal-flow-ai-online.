import type { JsonSchema } from '../schema/json-schema.js';

export const AUTH_TYPES = ['none', 'api_key', 'bearer', 'basic', 'oauth2'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const PLUGIN_SOURCES = ['official', 'community', 'custom'] as const;
export type PluginSource = (typeof PLUGIN_SOURCES)[number];

/**
 * `http`: declarative plugin, executed by the Universal API Connector from its manifest.
 * `native`: code handler registered by the host. Only official plugins may use it.
 */
export type PluginRuntime = 'http' | 'native';

export type AuthConfig =
  | { type: 'none' }
  | { type: 'api_key'; in: 'header' | 'query'; name: string }
  | { type: 'bearer' }
  | { type: 'basic' }
  | { type: 'oauth2'; authorizationUrl: string; tokenUrl: string; scopes: string[] };

/** Fields each auth type expects in the stored credential. */
export const CREDENTIAL_FIELDS: Record<AuthType, readonly string[]> = {
  none: [],
  api_key: ['apiKey'],
  bearer: ['token'],
  basic: ['username', 'password'],
  oauth2: ['accessToken'],
};

export type RequestTemplate = {
  method: HttpMethod;
  /** Path appended to the base URL. Supports `{{input.x}}`; values are URL-encoded. */
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  /** Any JSON value; strings inside may use `{{input.x}}` and `{{credentials.x}}`. */
  body: unknown;
};

export type ErrorPolicy = {
  retryOnStatus: number[] | undefined;
  timeoutMs: number | undefined;
};

export type ActionDefinition = {
  key: string;
  name: string;
  description: string | undefined;
  request: RequestTemplate | undefined;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  /** Output field → JSON path into the response body, e.g. `{ "text": "$.choices[0].text" }`. */
  responseMapping: Record<string, string> | undefined;
  errorPolicy: ErrorPolicy;
};

export type TriggerDefinition = {
  key: string;
  name: string;
  description: string | undefined;
  type: 'webhook' | 'polling' | 'schedule';
  outputSchema: JsonSchema;
};

export type PluginUi = { icon: string | undefined; color: string | undefined };

export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  /** Semver range of Core Engine versions this plugin works with. */
  engine: string;
  provider: string;
  category: string;
  description: string | undefined;
  runtime: PluginRuntime;
  auth: AuthConfig;
  baseUrl: string | undefined;
  /** Declared capabilities, e.g. `network:api.example.com`, `network:*.example.com`, `webhook:receive`. */
  permissions: string[];
  actions: ActionDefinition[];
  triggers: TriggerDefinition[];
  ui: PluginUi;
  docs: string | undefined;
  /** Honest list of what this integration cannot do (no official API, plan limits, review required). */
  limitations: string[];
};
