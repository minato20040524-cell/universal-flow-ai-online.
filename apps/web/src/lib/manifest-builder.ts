import type { AuthType, HttpMethod, Issue, JsonSchema, JsonType } from './types.js';

/**
 * Turns the Custom API form into a plugin manifest. The server validates the
 * manifest again; checking here lets the form point at the exact field to fix.
 */

export type KeyValueRow = { id: string; key: string; value: string };
export type FieldType = Extract<JsonType, 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'>;
export type FieldRow = { id: string; key: string; label: string; type: FieldType; required: boolean; description: string };

export type CustomApiForm = {
  name: string;
  id: string;
  version: string;
  provider: string;
  category: string;
  description: string;
  baseUrl: string;
  auth: {
    type: AuthType;
    apiKeyIn: 'header' | 'query';
    apiKeyName: string;
    authorizationUrl: string;
    tokenUrl: string;
    scopes: string;
  };
  action: {
    name: string;
    key: string;
    method: HttpMethod;
    path: string;
    headers: KeyValueRow[];
    query: KeyValueRow[];
    body: string;
  };
  inputs: FieldRow[];
  outputs: FieldRow[];
  responseMapping: KeyValueRow[];
  errors: { retryOnStatus: string; timeoutSeconds: string };
  limitations: string;
};

export const FIELD_TYPES: readonly FieldType[] = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const AUTH_TYPES: readonly AuthType[] = ['none', 'api_key', 'bearer', 'basic', 'oauth2'];
const KEY_PATTERN = /^[a-z][a-zA-Z0-9_-]{0,63}$/;
const FIELD_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const METHODS_WITHOUT_BODY: readonly HttpMethod[] = ['GET', 'DELETE'];

let rowCounter = 0;
export const newRowId = (): string => {
  rowCounter += 1;
  return `row-${rowCounter}`;
};

export const emptyRow = (): KeyValueRow => ({ id: newRowId(), key: '', value: '' });
export const emptyField = (): FieldRow => ({ id: newRowId(), key: '', label: '', type: 'string', required: false, description: '' });

export const emptyForm = (): CustomApiForm => ({
  name: '',
  id: '',
  version: '1.0.0',
  provider: '',
  category: 'custom-api',
  description: '',
  baseUrl: 'https://',
  auth: { type: 'bearer', apiKeyIn: 'header', apiKeyName: 'X-API-Key', authorizationUrl: '', tokenUrl: '', scopes: '' },
  action: { name: '', key: '', method: 'POST', path: '/', headers: [], query: [], body: '' },
  inputs: [],
  outputs: [],
  responseMapping: [],
  errors: { retryOnStatus: '429, 500, 502, 503, 504', timeoutSeconds: '30' },
  limitations: '',
});

const slug = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/**
 * `MY CUSTOM AI` in workspace `ws_3f9a…` → `custom.3f9a12bc.my-custom-ai`. Plugin ids are global,
 * so the workspace part keeps two teams that pick the same name from colliding.
 */
export const suggestPluginId = (name: string, workspaceId: string): string => {
  const workspacePart = workspaceId.replace(/^ws_/, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return slug(name) && workspacePart ? `custom.${workspacePart}.${slug(name)}` : '';
};

/** `Generate Text` → `generateText` (a valid action key). */
export const suggestActionKey = (name: string): string => {
  const words = slug(name).split('-').filter(Boolean);
  const [first = '', ...rest] = words;
  const key = [first, ...rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1))].join('');
  return /^[a-z]/.test(key) ? key : key ? `a${key}` : '';
};

/** A body template that sends every input field, for the user to edit. */
export const suggestBody = (inputs: readonly FieldRow[]): string => {
  const keys = inputs.map((field) => field.key.trim()).filter(Boolean);
  if (keys.length === 0) return '';
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, `{{input.${key}}}`])), null, 2);
};

const hostOf = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname ? parsed.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
};

const rowsToRecord = (rows: readonly KeyValueRow[], path: string, issues: Issue[]): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && !row.value.trim()) continue;
    if (!key) {
      issues.push({ path, message: `A row with the value "${row.value}" needs a name` });
      continue;
    }
    if (key in record) issues.push({ path, message: `"${key}" appears twice` });
    record[key] = row.value;
  }
  return record;
};

const fieldsToSchema = (fields: readonly FieldRow[], path: string, issues: Issue[]): JsonSchema => {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of fields) {
    const key = field.key.trim();
    if (!key) {
      issues.push({ path, message: 'Every field needs a name' });
      continue;
    }
    if (!FIELD_KEY_PATTERN.test(key)) issues.push({ path, message: `"${key}" may use letters, digits and _ only, and cannot start with a digit` });
    if (key in properties) issues.push({ path, message: `"${key}" appears twice` });
    properties[key] = {
      type: field.type,
      ...(field.label.trim() ? { title: field.label.trim() } : {}),
      ...(field.description.trim() ? { description: field.description.trim() } : {}),
    };
    if (field.required) required.push(key);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
};

const parseStatuses = (text: string, issues: Issue[]): number[] => {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const statuses = parts.map(Number);
  if (statuses.some((status) => !Number.isInteger(status) || status < 400 || status > 599)) {
    issues.push({ path: 'errors.retryOnStatus', message: 'List HTTP status codes from 400 to 599, separated by commas' });
    return [];
  }
  return statuses;
};

export type BuildResult = { manifest: Record<string, unknown>; issues: Issue[] };

export const buildManifest = (form: CustomApiForm): BuildResult => {
  const issues: Issue[] = [];
  const need = (value: string, path: string, message: string) => {
    if (!value.trim()) issues.push({ path, message });
  };
  need(form.name, 'name', 'Give the application a name');
  need(form.provider, 'provider', 'Say who provides this API');
  need(form.action.name, 'action.name', 'Name what this request does');
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(form.id)) issues.push({ path: 'id', message: 'Use lowercase letters, digits, dots and dashes, e.g. custom.my-api' });
  if (!/^\d+\.\d+\.\d+$/.test(form.version)) issues.push({ path: 'version', message: 'Use a version like 1.0.0' });
  if (!KEY_PATTERN.test(form.action.key)) issues.push({ path: 'action.key', message: 'Start with a lowercase letter; letters, digits, _ and - only' });

  const baseHost = hostOf(form.baseUrl);
  if (!baseHost) issues.push({ path: 'baseUrl', message: 'Enter a full https:// address, e.g. https://api.example.com/v1' });
  if (!form.action.path.startsWith('/')) issues.push({ path: 'action.path', message: 'The endpoint starts with /, e.g. /v1/generate' });

  const auth = (() => {
    switch (form.auth.type) {
      case 'none':
      case 'bearer':
      case 'basic':
        return { type: form.auth.type };
      case 'api_key':
        need(form.auth.apiKeyName, 'auth.apiKeyName', 'Name the header or query parameter that carries the key');
        return { type: 'api_key', in: form.auth.apiKeyIn, name: form.auth.apiKeyName.trim() };
      case 'oauth2':
        if (!hostOf(form.auth.authorizationUrl)) issues.push({ path: 'auth.authorizationUrl', message: 'Enter the https:// authorization URL' });
        if (!hostOf(form.auth.tokenUrl)) issues.push({ path: 'auth.tokenUrl', message: 'Enter the https:// token URL' });
        return {
          type: 'oauth2',
          authorizationUrl: form.auth.authorizationUrl.trim(),
          tokenUrl: form.auth.tokenUrl.trim(),
          scopes: form.auth.scopes.split(/[\s,]+/).filter(Boolean),
        };
    }
  })();

  let body: unknown;
  if (form.action.body.trim()) {
    if (METHODS_WITHOUT_BODY.includes(form.action.method)) issues.push({ path: 'action.body', message: `${form.action.method} requests have no body; move these values to query parameters` });
    try {
      body = JSON.parse(form.action.body);
    } catch {
      issues.push({ path: 'action.body', message: 'The body must be valid JSON' });
    }
  }

  const outputSchema = fieldsToSchema(form.outputs, 'outputs', issues);
  const mapping = rowsToRecord(form.responseMapping, 'responseMapping', issues);
  for (const [field, path] of Object.entries(mapping)) {
    if (!path.trim().startsWith('$')) issues.push({ path: 'responseMapping', message: `The path for "${field}" starts with $, e.g. $.data.text` });
    if (!(field in (outputSchema.properties ?? {}))) issues.push({ path: 'responseMapping', message: `"${field}" is not one of the outputs` });
  }

  const timeout = Number(form.errors.timeoutSeconds);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120) issues.push({ path: 'errors.timeoutSeconds', message: 'Choose a timeout from 1 to 120 seconds' });
  const retryOnStatus = parseStatuses(form.errors.retryOnStatus, issues);

  // The plugin may only call the hosts it names; OAuth endpoints count too.
  const hosts = [baseHost, ...(form.auth.type === 'oauth2' ? [hostOf(form.auth.authorizationUrl), hostOf(form.auth.tokenUrl)] : [])].filter(
    (host): host is string => host !== undefined,
  );

  const manifest = {
    id: form.id,
    name: form.name.trim(),
    version: form.version,
    engine: '^1.0.0',
    provider: form.provider.trim(),
    category: form.category,
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    auth,
    baseUrl: form.baseUrl.trim().replace(/\/+$/, ''),
    permissions: [...new Set(hosts)].map((host) => `network:${host}`),
    actions: [
      {
        key: form.action.key,
        name: form.action.name.trim(),
        request: {
          method: form.action.method,
          path: form.action.path.trim(),
          headers: rowsToRecord(form.action.headers, 'action.headers', issues),
          query: rowsToRecord(form.action.query, 'action.query', issues),
          ...(body === undefined ? {} : { body }),
        },
        inputSchema: fieldsToSchema(form.inputs, 'inputs', issues),
        outputSchema,
        ...(Object.keys(mapping).length > 0 ? { responseMapping: Object.fromEntries(Object.entries(mapping).map(([key, value]) => [key, value.trim()])) } : {}),
        errorPolicy: { ...(retryOnStatus.length > 0 ? { retryOnStatus } : {}), ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: Math.round(timeout * 1000) } : {}) },
      },
    ],
    limitations: form.limitations
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  };
  return { manifest, issues };
};

/** Issues for one form section, matched by path prefix. */
export const issuesFor = (issues: readonly Issue[], ...prefixes: string[]): Issue[] =>
  issues.filter((issue) => prefixes.some((prefix) => issue.path === prefix || issue.path.startsWith(`${prefix}.`)));
