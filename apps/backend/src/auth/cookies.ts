import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'uf_session';
export const CSRF_HEADER = 'x-csrf-token';

export const parseCookies = (header: string | undefined): Record<string, string> => {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
};

export type CookieOptions = { secure: boolean; maxAgeSeconds: number };

/**
 * HttpOnly keeps the token away from scripts; SameSite=Lax keeps it off
 * cross-site POSTs. The CSRF header check below is the second layer.
 */
export const sessionCookie = (token: string, { secure, maxAgeSeconds }: CookieOptions): string =>
  [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`, ...(secure ? ['Secure'] : [])].join('; ');

export const clearedSessionCookie = (secure: boolean): string => sessionCookie('', { secure, maxAgeSeconds: 0 });

/** Stateless CSRF token: an HMAC of the session id, so nothing extra is stored and it dies with the session. */
export const csrfTokenFor = (secret: Buffer, sessionId: string): string => createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('base64url');

export const tokensMatch = (expected: string, received: string | undefined): boolean => {
  if (received === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
};
