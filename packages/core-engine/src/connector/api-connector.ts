import { ConnectorError, EngineError, ValidationError, toFailure, type Issue } from '../errors.js';
import { readJsonPath } from '../expression/path.js';
import { renderTemplate, stringifyValue, type TemplateScope } from '../expression/template.js';
import type { ActionDefinition, AuthConfig, PluginManifest, RequestTemplate } from '../manifest/types.js';
import { validateValue } from '../schema/json-schema.js';
import { redactText, redactValue } from '../security/redact.js';
import type { SecretStore, SecretValues } from '../security/secret-store.js';
import { assertSafeUrl } from '../security/url-guard.js';
import { isRecord, systemClock, type Clock } from '../util.js';
import type { HttpClient, HttpRequest, HttpResponse } from './http-client.js';
import type { OAuthRefresher } from './oauth.js';

export const DEFAULT_RETRY_STATUSES: readonly number[] = [408, 425, 429, 500, 502, 503, 504];
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REFRESH_MARGIN_MS = 60_000;
const MAX_TEST_PREVIEW_CHARS = 20_000;

export type ActionCall = {
  manifest: PluginManifest;
  actionKey: string;
  input: Record<string, unknown>;
  workspaceId: string;
  credentialId?: string | undefined;
};

export type ActionResult = {
  output: unknown;
  status: number;
  durationMs: number;
  /** Output fields that do not match the action's output schema. */
  warnings: Issue[];
};

export type TestReport = {
  ok: boolean;
  status: number | undefined;
  durationMs: number;
  request: { method: string; url: string; headers: Record<string, string> } | undefined;
  rawResponse: unknown;
  output: unknown;
  warnings: Issue[];
  error: { message: string; code: string } | undefined;
};

export type ApiConnector = {
  execute: (call: ActionCall) => Promise<ActionResult>;
  /** Test API: one real request with sample input, fully redacted for display. */
  test: (call: ActionCall) => Promise<TestReport>;
};

export type ApiConnectorOptions = {
  http: HttpClient;
  secrets: SecretStore;
  refreshOAuth?: OAuthRefresher;
  clock?: Clock;
  defaultTimeoutMs?: number;
  maxResponseBytes?: number;
};

type Prepared = { request: HttpRequest; secretValues: string[]; action: ActionDefinition };

const findAction = (manifest: PluginManifest, key: string): ActionDefinition => {
  const action = manifest.actions.find((candidate) => candidate.key === key);
  if (!action) throw new EngineError('NOT_FOUND', `Action "${key}" does not exist in ${manifest.id}`);
  return action;
};

const requireField = (values: SecretValues, field: string): string => {
  const value = values[field];
  if (!value) throw new ValidationError('Incomplete credential', [{ path: `credentials.${field}`, message: 'is required' }]);
  return value;
};

const joinUrl = (baseUrl: string, path: string): URL => new URL(`${baseUrl.replace(/\/+$/, '')}${path}`);

const applyAuth = (auth: AuthConfig, values: SecretValues, url: URL, headers: Record<string, string>): void => {
  switch (auth.type) {
    case 'none':
      return;
    case 'api_key': {
      const apiKey = requireField(values, 'apiKey');
      if (auth.in === 'query') url.searchParams.set(auth.name, apiKey);
      else headers[auth.name.toLowerCase()] = apiKey;
      return;
    }
    case 'bearer':
      headers.authorization = `Bearer ${requireField(values, 'token')}`;
      return;
    case 'basic': {
      const encoded = Buffer.from(`${requireField(values, 'username')}:${requireField(values, 'password')}`).toString('base64');
      headers.authorization = `Basic ${encoded}`;
      return;
    }
    case 'oauth2':
      headers.authorization = `Bearer ${requireField(values, 'accessToken')}`;
      return;
  }
};

const lowerCaseKeys = (record: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key.toLowerCase(), stringifyValue(value)]));

const buildHeaders = (template: RequestTemplate, scope: TemplateScope): Record<string, string> => {
  const rendered = renderTemplate(template.headers, scope);
  return { accept: 'application/json', ...(isRecord(rendered) ? lowerCaseKeys(rendered) : {}) };
};

const parseBody = (response: HttpResponse): unknown => {
  if (response.body === '') return null;
  try {
    return JSON.parse(response.body);
  } catch {
    return response.body;
  }
};

const mapResponse = (mapping: Record<string, string> | undefined, body: unknown): unknown =>
  mapping ? Object.fromEntries(Object.entries(mapping).map(([field, path]) => [field, readJsonPath(body, path)])) : body;

const previewOf = (value: unknown): unknown => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > MAX_TEST_PREVIEW_CHARS ? `${text.slice(0, MAX_TEST_PREVIEW_CHARS)}… (truncated)` : value;
};

export const createApiConnector = (options: ApiConnectorOptions): ApiConnector => {
  const clock = options.clock ?? systemClock;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const refreshIfNeeded = async (call: ActionCall, credentialId: string, values: SecretValues): Promise<SecretValues> => {
    const { auth } = call.manifest;
    if (auth.type !== 'oauth2') return values;
    const info = await options.secrets.info(credentialId);
    const expiresSoon = info?.expiresAt !== undefined && info.expiresAt - REFRESH_MARGIN_MS <= clock.now();
    if (!expiresSoon) return values;
    const refreshToken = values.refreshToken;
    if (!options.refreshOAuth || !refreshToken) {
      throw new EngineError('PERMISSION', 'The connected account has expired; reconnect it');
    }
    const tokens = await options.refreshOAuth({
      tokenUrl: auth.tokenUrl,
      refreshToken,
      clientId: values.clientId,
      clientSecret: values.clientSecret,
      permissions: call.manifest.permissions,
    });
    const refreshed: SecretValues = { ...values, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? refreshToken };
    const expiresAt = tokens.expiresInSeconds === undefined ? undefined : clock.now() + tokens.expiresInSeconds * 1000;
    await options.secrets.replace(credentialId, refreshed, expiresAt);
    return refreshed;
  };

  const loadCredentials = async (call: ActionCall): Promise<SecretValues> => {
    if (call.manifest.auth.type === 'none') return {};
    if (!call.credentialId) {
      throw new ValidationError('Missing credential', [{ path: 'credentialId', message: `is required for ${call.manifest.auth.type} auth` }]);
    }
    // A credential only ever goes to the plugin it was connected for; otherwise one integration could exfiltrate another's tokens.
    const info = await options.secrets.info(call.credentialId);
    if (info?.workspaceId !== call.workspaceId || info.pluginId !== call.manifest.id) {
      throw new EngineError('PERMISSION', `Credential ${call.credentialId} is not connected to ${call.manifest.id}`);
    }
    const values = await options.secrets.reveal(call.credentialId, call.workspaceId);
    return refreshIfNeeded(call, call.credentialId, values);
  };

  const prepare = async (call: ActionCall): Promise<Prepared> => {
    const { manifest } = call;
    const action = findAction(manifest, call.actionKey);
    const template = action.request;
    if (manifest.runtime !== 'http' || !template || !manifest.baseUrl) {
      throw new EngineError('WORKFLOW', `${manifest.id}:${action.key} is not an HTTP action`);
    }
    const inputIssues = validateValue(action.inputSchema, call.input, '$.input');
    if (inputIssues.length > 0) throw new ValidationError('Invalid action input', inputIssues);

    const credentials = await loadCredentials(call);
    const scope: TemplateScope = { input: call.input, credentials };
    const path = renderTemplate(template.path, scope, { encode: encodeURIComponent });
    if (typeof path !== 'string' || !path.startsWith('/')) throw new EngineError('VALIDATION', 'Request path must render to a string starting with "/"');

    const url = joinUrl(manifest.baseUrl, path);
    const query = renderTemplate(template.query, scope);
    for (const [key, value] of Object.entries(isRecord(query) ? query : {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, stringifyValue(value));
    }
    const headers = buildHeaders(template, scope);
    applyAuth(manifest.auth, credentials, url, headers);
    assertSafeUrl(url, manifest.permissions);

    let body: string | undefined;
    if (template.body !== undefined && template.method !== 'GET' && template.method !== 'DELETE') {
      body = JSON.stringify(renderTemplate(template.body, scope));
      headers['content-type'] ??= 'application/json';
    }
    return {
      action,
      secretValues: Object.values(credentials),
      request: {
        method: template.method,
        url: url.toString(),
        headers,
        body,
        timeoutMs: action.errorPolicy.timeoutMs ?? defaultTimeoutMs,
        maxResponseBytes,
      },
    };
  };

  const send = async ({ request, secretValues, action }: Prepared) => {
    const startedAt = clock.now();
    let response: HttpResponse;
    try {
      response = await options.http.send(request);
    } catch (error) {
      if (error instanceof ConnectorError) {
        throw new ConnectorError(redactText(error.message, secretValues), { retryable: error.retryable, ...(error.status === undefined ? {} : { status: error.status }) });
      }
      throw error;
    }
    const durationMs = clock.now() - startedAt;
    const raw = parseBody(response);
    if (response.status >= 300 && response.status < 400) {
      throw new ConnectorError(`HTTP ${response.status}: redirects are not followed`, { status: response.status, retryable: false });
    }
    if (response.status >= 400) {
      const retryOn = action.errorPolicy.retryOnStatus ?? DEFAULT_RETRY_STATUSES;
      throw new ConnectorError(`HTTP ${response.status} from ${new URL(request.url).hostname}`, {
        status: response.status,
        retryable: retryOn.includes(response.status),
        responseBody: redactValue(raw, secretValues),
      });
    }
    const output = mapResponse(action.responseMapping, raw);
    const warnings = validateValue(action.outputSchema, output, '$.output');
    return { raw, result: { output, status: response.status, durationMs, warnings } };
  };

  return {
    execute: async (call) => (await send(await prepare(call))).result,

    test: async (call) => {
      const startedAt = clock.now();
      let prepared: Prepared | undefined;
      try {
        prepared = await prepare(call);
        const { raw, result } = await send(prepared);
        const secrets = prepared.secretValues;
        const redactedHeaders = redactValue(prepared.request.headers, secrets);
        return {
          ok: result.warnings.length === 0,
          status: result.status,
          durationMs: result.durationMs,
          request: {
            method: prepared.request.method,
            url: redactText(prepared.request.url, secrets),
            headers: isRecord(redactedHeaders) ? lowerCaseKeys(redactedHeaders) : {},
          },
          rawResponse: previewOf(redactValue(raw, secrets)),
          output: redactValue(result.output, secrets),
          warnings: result.warnings,
          error: undefined,
        };
      } catch (error) {
        const secrets = prepared?.secretValues ?? [];
        const failure = toFailure(error);
        return {
          ok: false,
          status: error instanceof ConnectorError ? error.status : undefined,
          durationMs: clock.now() - startedAt,
          request: undefined,
          rawResponse: error instanceof ConnectorError ? previewOf(error.responseBody) : undefined,
          output: undefined,
          warnings: [],
          error: { message: redactText(failure.message, secrets), code: failure.code },
        };
      }
    },
  };
};
