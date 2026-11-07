import { ValidationError, type Issue } from '../errors.js';
import { parseJsonSchema, type JsonSchema } from '../schema/json-schema.js';
import { hostMatchesPermission, isBlockedHostname } from '../security/url-guard.js';
import { isValidRange, isValidSemver } from '../semver.js';
import { isRecord, isStringArray, isStringRecord } from '../util.js';
import {
  AUTH_TYPES,
  HTTP_METHODS,
  type ActionDefinition,
  type AuthConfig,
  type AuthType,
  type ErrorPolicy,
  type HttpMethod,
  type PluginManifest,
  type PluginRuntime,
  type RequestTemplate,
  type TriggerDefinition,
} from './types.js';

export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const KEY_PATTERN = /^[a-z][a-zA-Z0-9_-]{0,63}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const PERMISSION_PATTERN = /^(network:(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+|storage:(read|write)|webhook:receive)$/;
const TRIGGER_TYPES = ['webhook', 'polling', 'schedule'] as const;
const MAX_TIMEOUT_MS = 120_000;

type Source = Record<string, unknown>;

/** Collects issues while reading an untrusted object, so one pass reports every problem. */
const createReader = (issues: Issue[]) => {
  const requiredString = (source: Source, key: string, path: string, pattern?: RegExp): string => {
    const value = source[key];
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push({ path: `${path}.${key}`, message: 'must be a non-empty string' });
      return '';
    }
    if (pattern && !pattern.test(value)) {
      issues.push({ path: `${path}.${key}`, message: `has an invalid format (${pattern.source})` });
    }
    return value;
  };

  const optionalString = (source: Source, key: string, path: string): string | undefined => {
    const value = source[key];
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    issues.push({ path: `${path}.${key}`, message: 'must be a string' });
    return undefined;
  };

  const stringList = (source: Source, key: string, path: string): string[] => {
    const value = source[key];
    if (value === undefined) return [];
    if (isStringArray(value)) return value;
    issues.push({ path: `${path}.${key}`, message: 'must be an array of strings' });
    return [];
  };

  const stringMap = (source: Source, key: string, path: string): Record<string, string> => {
    const value = source[key];
    if (value === undefined) return {};
    if (isStringRecord(value)) return value;
    issues.push({ path: `${path}.${key}`, message: 'must be an object of string values' });
    return {};
  };

  const httpsUrl = (value: string | undefined, path: string): void => {
    if (value === undefined) return;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') issues.push({ path, message: 'must use https://' });
      else if (isBlockedHostname(url.hostname)) issues.push({ path, message: 'must not point to a private or internal host' });
    } catch {
      issues.push({ path, message: 'must be a valid URL' });
    }
  };

  return { requiredString, optionalString, stringList, stringMap, httpsUrl };
};

type Reader = ReturnType<typeof createReader>;

const isAuthType = (value: unknown): value is AuthType => AUTH_TYPES.some((type) => type === value);
const isHttpMethod = (value: unknown): value is HttpMethod => HTTP_METHODS.some((method) => method === value);

const parseAuth = (value: unknown, path: string, issues: Issue[], read: Reader): AuthConfig => {
  if (!isRecord(value) || !isAuthType(value.type)) {
    issues.push({ path: `${path}.type`, message: `must be one of ${AUTH_TYPES.join(', ')}` });
    return { type: 'none' };
  }
  switch (value.type) {
    case 'none':
    case 'bearer':
    case 'basic':
      return { type: value.type };
    case 'api_key': {
      const location = value.in ?? 'header';
      if (location !== 'header' && location !== 'query') {
        issues.push({ path: `${path}.in`, message: 'must be "header" or "query"' });
      }
      return {
        type: 'api_key',
        in: location === 'query' ? 'query' : 'header',
        name: read.requiredString(value, 'name', path),
      };
    }
    case 'oauth2': {
      const authorizationUrl = read.requiredString(value, 'authorizationUrl', path);
      const tokenUrl = read.requiredString(value, 'tokenUrl', path);
      read.httpsUrl(authorizationUrl || undefined, `${path}.authorizationUrl`);
      read.httpsUrl(tokenUrl || undefined, `${path}.tokenUrl`);
      return { type: 'oauth2', authorizationUrl, tokenUrl, scopes: read.stringList(value, 'scopes', path) };
    }
  }
};

const parseRequest = (value: unknown, path: string, issues: Issue[], read: Reader): RequestTemplate | undefined => {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return undefined;
  }
  if (!isHttpMethod(value.method)) {
    issues.push({ path: `${path}.method`, message: `must be one of ${HTTP_METHODS.join(', ')}` });
  }
  const requestPath = read.requiredString(value, 'path', path);
  if (requestPath && !requestPath.startsWith('/')) issues.push({ path: `${path}.path`, message: 'must start with "/"' });
  if (value.body !== undefined && (value.method === 'GET' || value.method === 'DELETE')) {
    issues.push({ path: `${path}.body`, message: `is not allowed for ${String(value.method)}` });
  }
  return {
    method: isHttpMethod(value.method) ? value.method : 'GET',
    path: requestPath,
    headers: read.stringMap(value, 'headers', path),
    query: read.stringMap(value, 'query', path),
    body: value.body,
  };
};

const parseErrorPolicy = (value: unknown, path: string, issues: Issue[]): ErrorPolicy => {
  if (value === undefined) return { retryOnStatus: undefined, timeoutMs: undefined };
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return { retryOnStatus: undefined, timeoutMs: undefined };
  }
  const { retryOnStatus, timeoutMs } = value;
  const validStatuses =
    Array.isArray(retryOnStatus) && retryOnStatus.every((status) => Number.isInteger(status) && status >= 400 && status < 600);
  if (retryOnStatus !== undefined && !validStatuses) {
    issues.push({ path: `${path}.retryOnStatus`, message: 'must be an array of HTTP status codes (400-599)' });
  }
  const validTimeout = typeof timeoutMs === 'number' && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS;
  if (timeoutMs !== undefined && !validTimeout) {
    issues.push({ path: `${path}.timeoutMs`, message: `must be between 1 and ${MAX_TIMEOUT_MS}` });
  }
  return {
    retryOnStatus: validStatuses && Array.isArray(retryOnStatus) ? retryOnStatus.filter((status) => typeof status === 'number') : undefined,
    timeoutMs: validTimeout && typeof timeoutMs === 'number' ? timeoutMs : undefined,
  };
};

const DEFAULT_INPUT_SCHEMA: JsonSchema = { type: 'object', properties: {} };
const DEFAULT_OUTPUT_SCHEMA: JsonSchema = { type: 'object' };

const parseSchemaOrDefault = (value: unknown, fallback: JsonSchema, path: string, issues: Issue[]): JsonSchema =>
  value === undefined ? fallback : parseJsonSchema(value, path, issues);

const parseAction = (
  value: unknown,
  path: string,
  runtime: PluginRuntime,
  issues: Issue[],
  read: Reader,
): ActionDefinition | undefined => {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return undefined;
  }
  const mapping = value.responseMapping === undefined ? undefined : read.stringMap(value, 'responseMapping', path);
  for (const [field, jsonPath] of Object.entries(mapping ?? {})) {
    if (!jsonPath.startsWith('$')) issues.push({ path: `${path}.responseMapping.${field}`, message: 'must be a JSON path starting with "$"' });
  }
  const request = value.request === undefined ? undefined : parseRequest(value.request, `${path}.request`, issues, read);
  if (runtime === 'http' && request === undefined) {
    issues.push({ path: `${path}.request`, message: 'is required for http plugins' });
  }
  return {
    key: read.requiredString(value, 'key', path, KEY_PATTERN),
    name: read.requiredString(value, 'name', path),
    description: read.optionalString(value, 'description', path),
    request,
    inputSchema: parseSchemaOrDefault(value.inputSchema, DEFAULT_INPUT_SCHEMA, `${path}.inputSchema`, issues),
    outputSchema: parseSchemaOrDefault(value.outputSchema, DEFAULT_OUTPUT_SCHEMA, `${path}.outputSchema`, issues),
    responseMapping: mapping,
    errorPolicy: parseErrorPolicy(value.errorPolicy, `${path}.errorPolicy`, issues),
  };
};

const parseTrigger = (value: unknown, path: string, issues: Issue[], read: Reader): TriggerDefinition | undefined => {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return undefined;
  }
  const type = TRIGGER_TYPES.find((candidate) => candidate === value.type);
  if (!type) issues.push({ path: `${path}.type`, message: `must be one of ${TRIGGER_TYPES.join(', ')}` });
  return {
    key: read.requiredString(value, 'key', path, KEY_PATTERN),
    name: read.requiredString(value, 'name', path),
    description: read.optionalString(value, 'description', path),
    type: type ?? 'webhook',
    outputSchema: parseSchemaOrDefault(value.outputSchema, DEFAULT_OUTPUT_SCHEMA, `${path}.outputSchema`, issues),
  };
};

const parseList = <T>(value: unknown, path: string, issues: Issue[], parseItem: (item: unknown, itemPath: string) => T | undefined): T[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'must be an array' });
    return [];
  }
  return value.flatMap((item, index) => {
    const parsed = parseItem(item, `${path}[${index}]`);
    return parsed === undefined ? [] : [parsed];
  });
};

const reportDuplicateKeys = (items: readonly { key: string }[], path: string, issues: Issue[]): void => {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key)) issues.push({ path, message: `has duplicate key "${item.key}"` });
    seen.add(item.key);
  }
};

export type ParseManifestOptions = {
  categoryExists?: (slug: string) => boolean;
};

/** Validates an untrusted manifest and returns it fully typed, or throws a ValidationError listing every issue. */
export const parseManifest = (input: unknown, options: ParseManifestOptions = {}): PluginManifest => {
  const issues: Issue[] = [];
  const read = createReader(issues);
  const path = '$';
  if (!isRecord(input)) throw new ValidationError('Invalid plugin manifest', [{ path, message: 'must be an object' }]);

  const runtime: PluginRuntime = input.runtime === 'native' ? 'native' : 'http';
  if (input.runtime !== undefined && input.runtime !== 'http' && input.runtime !== 'native') {
    issues.push({ path: '$.runtime', message: 'must be "http" or "native"' });
  }

  const id = read.requiredString(input, 'id', path, PLUGIN_ID_PATTERN);
  if (id.length > 128) issues.push({ path: '$.id', message: 'must be at most 128 characters' });
  const version = read.requiredString(input, 'version', path);
  if (version && !isValidSemver(version)) issues.push({ path: '$.version', message: 'must be a semantic version, e.g. 1.0.0' });
  const engine = read.requiredString(input, 'engine', path);
  if (engine && !isValidRange(engine)) issues.push({ path: '$.engine', message: 'must be a version range, e.g. ^1.0.0' });
  const category = read.requiredString(input, 'category', path);
  if (category && options.categoryExists && !options.categoryExists(category)) {
    issues.push({ path: '$.category', message: `unknown category "${category}"` });
  }

  const permissions = read.stringList(input, 'permissions', path);
  permissions.forEach((permission, index) => {
    if (!PERMISSION_PATTERN.test(permission)) issues.push({ path: `$.permissions[${index}]`, message: `unknown permission "${permission}"` });
  });

  const baseUrl = read.optionalString(input, 'baseUrl', path);
  read.httpsUrl(baseUrl, '$.baseUrl');
  if (runtime === 'http' && baseUrl === undefined) issues.push({ path: '$.baseUrl', message: 'is required for http plugins' });
  if (baseUrl !== undefined && URL.canParse(baseUrl) && !hostMatchesPermission(new URL(baseUrl).hostname, permissions)) {
    issues.push({ path: '$.permissions', message: `must include network:${new URL(baseUrl).hostname} for the base URL` });
  }

  const actions = parseList(input.actions, '$.actions', issues, (item, itemPath) => parseAction(item, itemPath, runtime, issues, read));
  const triggers = parseList(input.triggers, '$.triggers', issues, (item, itemPath) => parseTrigger(item, itemPath, issues, read));
  if (actions.length === 0 && triggers.length === 0) issues.push({ path: '$.actions', message: 'a plugin needs at least one action or trigger' });
  reportDuplicateKeys(actions, '$.actions', issues);
  reportDuplicateKeys(triggers, '$.triggers', issues);

  const ui = isRecord(input.ui) ? input.ui : {};
  const color = read.optionalString(ui, 'color', '$.ui');
  if (color !== undefined && !COLOR_PATTERN.test(color)) issues.push({ path: '$.ui.color', message: 'must be a hex color like #7C5CFF' });
  const docs = read.optionalString(input, 'docs', path);
  read.httpsUrl(docs, '$.docs');

  const manifest: PluginManifest = {
    id,
    name: read.requiredString(input, 'name', path),
    version,
    engine,
    provider: read.requiredString(input, 'provider', path),
    category,
    description: read.optionalString(input, 'description', path),
    runtime,
    auth: parseAuth(input.auth ?? { type: 'none' }, '$.auth', issues, read),
    baseUrl,
    permissions,
    actions,
    triggers,
    ui: { icon: read.optionalString(ui, 'icon', '$.ui'), color },
    docs,
    limitations: read.stringList(input, 'limitations', path),
  };
  if (issues.length > 0) throw new ValidationError('Invalid plugin manifest', issues);
  return manifest;
};
