import type { Role } from '../repositories/workspace-repository.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type AuthContext = {
  /** API token (scripts, integrations) or browser session (web app). */
  via: 'token' | 'session';
  workspaceId: string;
  role: Role;
  /** Token id, or session id for browser sessions. */
  tokenId: string;
  isPlatformAdmin: boolean;
  /** Recorded in the audit log. */
  actor: string;
  userId: string | undefined;
  /** Expected x-csrf-token for unsafe requests made with a session cookie. */
  csrfToken: string | undefined;
};

export type RequestContext = {
  requestId: string;
  method: HttpMethod;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string>;
  rawBody: string;
  body: unknown;
  auth: AuthContext | undefined;
  clientIp: string;
};

export type RouteResult = {
  status: number;
  body?: unknown;
  /** Defaults to application/json. */
  contentType?: string;
  headers?: Record<string, string>;
};

export type RouteAccess =
  | { kind: 'public' }
  | { kind: 'workspace'; minRole: Role }
  /** Signed-in browser users only (account and session actions). */
  | { kind: 'user' }
  | { kind: 'platform-admin' };

export type Route = {
  method: HttpMethod;
  /** Path pattern with `:name` segments, e.g. /v1/workflows/:id/run */
  pattern: string;
  access: RouteAccess;
  /** Raw body limit; JSON routes default to 1 MB. */
  maxBodyBytes?: number;
  /** Webhooks read the raw body themselves (signatures); everything else must send JSON. */
  rawBodyOnly?: boolean;
  handler: (context: RequestContext) => Promise<RouteResult>;
};

/** Reads `auth` on a route whose access guarantees it is present. */
export const requireAuth = (context: RequestContext): AuthContext => {
  if (!context.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
  return context.auth;
};

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;

  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
