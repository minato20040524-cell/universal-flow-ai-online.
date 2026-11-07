import { createHash, randomBytes } from 'node:crypto';
import { ConnectorError } from '../errors.js';
import { assertSafeUrl } from '../security/url-guard.js';
import { isRecord } from '../util.js';
import type { HttpClient } from './http-client.js';

/** OAuth 2.0 Authorization Code + PKCE (RFC 6749, RFC 7636), run only on the backend. */

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string | undefined;
  expiresInSeconds: number | undefined;
  scope: string | undefined;
};

export type AuthorizationRequestInput = {
  authorizationUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
};

export type AuthorizationRequest = {
  url: string;
  /** Store server-side with the verifier; compare on callback. */
  state: string;
  codeVerifier: string;
};

export const createAuthorizationRequest = ({ authorizationUrl, clientId, redirectUri, scopes }: AuthorizationRequestInput): AuthorizationRequest => {
  const state = randomBytes(24).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const url = new URL(authorizationUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state, codeVerifier };
};

type TokenRequest = {
  http: HttpClient;
  tokenUrl: string;
  permissions: readonly string[];
  form: Record<string, string | undefined>;
  timeoutMs: number;
};

const requestTokens = async ({ http, tokenUrl, permissions, form, timeoutMs }: TokenRequest): Promise<OAuthTokens> => {
  const url = new URL(tokenUrl);
  assertSafeUrl(url, permissions);
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) if (value) body.set(key, value);

  const response = await http.send({
    method: 'POST',
    url: url.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    timeoutMs,
    maxResponseBytes: 1_000_000,
  });
  if (response.status >= 400) {
    throw new ConnectorError(`Token endpoint returned HTTP ${response.status}; reconnect the account`, {
      status: response.status,
      retryable: response.status >= 500,
    });
  }
  let data: unknown;
  try {
    data = JSON.parse(response.body);
  } catch {
    data = undefined;
  }
  if (!isRecord(data) || typeof data.access_token !== 'string') {
    throw new ConnectorError('Token endpoint returned no access_token', { status: response.status, retryable: false });
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    expiresInSeconds: typeof data.expires_in === 'number' ? data.expires_in : undefined,
    scope: typeof data.scope === 'string' ? data.scope : undefined,
  };
};

export type CodeExchangeRequest = {
  tokenUrl: string;
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string | undefined;
  codeVerifier: string;
  permissions: readonly string[];
};

export const exchangeAuthorizationCode = (http: HttpClient, request: CodeExchangeRequest, timeoutMs = 15_000): Promise<OAuthTokens> =>
  requestTokens({
    http,
    tokenUrl: request.tokenUrl,
    permissions: request.permissions,
    timeoutMs,
    form: {
      grant_type: 'authorization_code',
      code: request.code,
      redirect_uri: request.redirectUri,
      client_id: request.clientId,
      client_secret: request.clientSecret,
      code_verifier: request.codeVerifier,
    },
  });

export type OAuthRefreshRequest = {
  tokenUrl: string;
  refreshToken: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  permissions: readonly string[];
};

export type OAuthRefresher = (request: OAuthRefreshRequest) => Promise<OAuthTokens>;

export const createOAuthRefresher = (http: HttpClient, timeoutMs = 15_000): OAuthRefresher => (request) =>
  requestTokens({
    http,
    tokenUrl: request.tokenUrl,
    permissions: request.permissions,
    timeoutMs,
    form: {
      grant_type: 'refresh_token',
      refresh_token: request.refreshToken,
      client_id: request.clientId,
      client_secret: request.clientSecret,
    },
  });
