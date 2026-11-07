import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { EngineError, ValidationError, type ErrorCode } from '@universal-flow/core-engine';
import { CSRF_HEADER, SESSION_COOKIE, parseCookies, tokensMatch } from '../auth/cookies.js';
import { ConcurrentModificationError } from '../db/sql.js';
import { roleRank } from '../repositories/workspace-repository.js';
import { createRouter } from './router.js';
import { HttpError, type AuthContext, type HttpMethod, type RequestContext, type Route, type RouteResult } from './types.js';

const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PERMISSION: 403,
  SECURITY: 403,
  CONNECTOR: 502,
  WORKFLOW: 422,
};

export type Credentials = { bearer: string | undefined; sessionToken: string | undefined };

export type ServerOptions = {
  routes: readonly Route[];
  authenticate: (credentials: Credentials) => Promise<AuthContext | undefined>;
  corsOrigins?: readonly string[];
  /** Origins allowed to make cookie-authenticated changes (the web app's own origin). */
  trustedOrigins?: readonly string[];
  /** Read the client address from X-Forwarded-For (only behind a proxy you control). */
  trustProxy?: boolean;
  /** Serves the web app for any GET that no API route matches. */
  fallback?: (request: { path: string; method: HttpMethod }) => Promise<RouteResult | undefined>;
  log?: (entry: Record<string, unknown>) => void;
};

type ErrorBody = { error: { code: string; message: string; issues?: unknown; requestId: string } };

export const toErrorResult = (error: unknown, requestId: string): RouteResult & { body: ErrorBody } => {
  if (error instanceof HttpError) {
    return { status: error.status, headers: error.headers, body: { error: { code: error.code, message: error.message, requestId } } };
  }
  if (error instanceof ValidationError) {
    return { status: 400, body: { error: { code: error.code, message: error.message, issues: error.issues, requestId } } };
  }
  if (error instanceof EngineError) return { status: STATUS_BY_CODE[error.code], body: { error: { code: error.code, message: error.message, requestId } } };
  if (error instanceof ConcurrentModificationError) {
    return { status: 409, body: { error: { code: 'CONFLICT', message: 'The execution is being updated right now; try again', requestId } } };
  }
  // Unexpected errors are logged with the request id but never described to the caller.
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'Internal server error', requestId } } };
};

const readBody = (request: IncomingMessage, maxBytes: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', `Body is larger than ${maxBytes} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });

const headerMap = (request: IncomingMessage): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers[key] = value;
    else if (Array.isArray(value)) headers[key] = value.join(', ');
  }
  return headers;
};

const parseJson = (raw: string, contentType: string | undefined): unknown => {
  if (raw === '') return undefined;
  if (!contentType?.includes('application/json')) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON with Content-Type: application/json');
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Body is not valid JSON');
  }
};

const SAFE_METHODS: readonly HttpMethod[] = ['GET'];

type AuthorizeInput = {
  route: Route;
  method: HttpMethod;
  headers: Record<string, string>;
  authenticate: ServerOptions['authenticate'];
  trustedOrigins: ReadonlySet<string>;
};

const authorize = async ({ route, method, headers, authenticate, trustedOrigins }: AuthorizeInput): Promise<AuthContext | undefined> => {
  if (route.access.kind === 'public') return undefined;
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '')?.[1];
  const sessionToken = bearer ? undefined : parseCookies(headers.cookie)[SESSION_COOKIE];
  if (!bearer && !sessionToken) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in, or send Authorization: Bearer <api token>');
  const auth = await authenticate({ bearer, sessionToken });
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', bearer ? 'The API token is invalid or revoked' : 'Your session has ended; sign in again');
  if (auth.via === 'session' && !SAFE_METHODS.includes(method)) {
    // Cookies travel with cross-site requests; a header only our own page can read and set does not.
    const origin = headers.origin;
    if (origin && !trustedOrigins.has(origin)) throw new HttpError(403, 'FORBIDDEN_ORIGIN', `Requests from ${origin} are not allowed`);
    if (!auth.csrfToken || !tokensMatch(auth.csrfToken, headers[CSRF_HEADER])) throw new HttpError(403, 'CSRF_FAILED', 'Missing or wrong CSRF token');
  }
  if (route.access.kind === 'user' && auth.via !== 'session') throw new HttpError(403, 'FORBIDDEN', 'Only signed-in users can do this');
  if (route.access.kind === 'platform-admin' && !auth.isPlatformAdmin) throw new HttpError(403, 'FORBIDDEN', 'Platform administrators only');
  if (route.access.kind === 'workspace' && roleRank(auth.role) < roleRank(route.access.minRole)) {
    throw new HttpError(403, 'FORBIDDEN', `Requires the ${route.access.minRole} role or higher`);
  }
  return auth;
};

export const createRequestHandler = (options: ServerOptions) => {
  const router = createRouter(options.routes);
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const corsOrigins = new Set(options.corsOrigins ?? []);
  const trustedOrigins = new Set([...(options.trustedOrigins ?? []), ...corsOrigins]);

  const send = (response: ServerResponse, result: RouteResult, extraHeaders: Record<string, string>, headOnly = false) => {
    const contentType = result.contentType ?? 'application/json; charset=utf-8';
    const payload =
      result.body === undefined ? '' : Buffer.isBuffer(result.body) ? result.body : contentType.startsWith('application/json') ? JSON.stringify(result.body) : String(result.body);
    response.writeHead(result.status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
      ...result.headers,
    });
    response.end(headOnly ? undefined : payload);
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const headers = headerMap(request);
    const origin = headers.origin;
    const corsHeaders: Record<string, string> =
      origin && corsOrigins.has(origin)
        ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': METHODS.join(', ') }
        : {};
    const baseHeaders = { 'x-request-id': requestId, ...corsHeaders };
    const url = new URL(request.url ?? '/', 'http://localhost');
    let result: RouteResult;

    try {
      if (request.method === 'OPTIONS') {
        result = { status: 204 };
      } else {
        // HEAD is answered like GET, without the body.
        const method = request.method === 'HEAD' ? 'GET' : METHODS.find((candidate) => candidate === request.method);
        if (!method) throw new HttpError(405, 'METHOD_NOT_ALLOWED', `Method ${request.method ?? ''} is not supported`);
        const match = router.match(method, url.pathname);
        const served = match.kind === 'not-found' && method === 'GET' ? await options.fallback?.({ path: url.pathname, method }) : undefined;
        if (served) {
          send(response, served, baseHeaders, request.method === 'HEAD');
          log({ level: 'info', requestId, method, path: url.pathname, status: served.status, ms: Date.now() - startedAt });
          return;
        }
        if (match.kind === 'not-found') throw new HttpError(404, 'NOT_FOUND', `No route for ${url.pathname}`);
        if (match.kind === 'method-not-allowed') {
          throw new HttpError(405, 'METHOD_NOT_ALLOWED', `Use ${match.allowed.join(', ')} for ${url.pathname}`);
        }
        const auth = await authorize({ route: match.route, method, headers, authenticate: options.authenticate, trustedOrigins });
        const rawBody = method === 'GET' ? '' : await readBody(request, match.route.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
        const context: RequestContext = {
          requestId,
          method,
          path: url.pathname,
          params: match.params,
          query: url.searchParams,
          headers,
          rawBody,
          // Webhooks get the raw body for signature checks and parse it themselves.
          body: match.route.rawBodyOnly ? undefined : parseJson(rawBody, headers['content-type']),
          auth,
          clientIp: (options.trustProxy ? headers['x-forwarded-for']?.split(',')[0]?.trim() : undefined) ?? request.socket.remoteAddress ?? 'unknown',
        };
        result = await match.route.handler(context);
      }
    } catch (error) {
      result = toErrorResult(error, requestId);
      if (result.status >= 500) log({ level: 'error', requestId, message: error instanceof Error ? error.stack ?? error.message : String(error) });
    }

    send(response, result, baseHeaders, request.method === 'HEAD');
    log({ level: 'info', requestId, method: request.method, path: url.pathname, status: result.status, ms: Date.now() - startedAt });
  };
};

export const createHttpServer = (options: ServerOptions): Server => {
  const handler = createRequestHandler(options);
  return createServer((request, response) => {
    void handler(request, response);
  });
};
