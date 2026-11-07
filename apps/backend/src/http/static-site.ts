import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { RouteResult } from './types.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/**
 * Files the installed app needs at fixed root paths. The service worker must
 * never be cached by the browser, or an update would not reach the phone.
 */
const ROOT_FILES: Record<string, string> = {
  'favicon.svg': 'public, max-age=86400',
  'manifest.webmanifest': 'no-cache',
  'sw.js': 'no-cache',
  'offline.html': 'no-cache',
  'offline.css': 'no-cache',
};
const ICON_CACHE = 'public, max-age=86400';

/** Only our own scripts and styles; no inline code, no framing. */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const API_PREFIXES = ['/v1/', '/hooks/', '/oauth/', '/health'];

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/**
 * Serves the built web app. Hashed files under /assets are cached for a year;
 * every other path returns index.html so the client-side router can take it.
 */
export const createStaticSite = (directory: string) => {
  const root = resolve(directory);
  const indexPath = resolve(root, 'index.html');

  const fileResult = async (path: string, cacheControl: string): Promise<RouteResult> => ({
    status: 200,
    body: await readFile(path),
    contentType: CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
    headers: { 'cache-control': cacheControl, 'content-security-policy': APP_CSP, 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' },
  });

  return async ({ path }: { path: string }): Promise<RouteResult | undefined> => {
    if (API_PREFIXES.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix))) return undefined;
    let relative: string;
    try {
      relative = decodeURIComponent(path).replace(/^\/+/, '');
    } catch {
      return undefined;
    }
    if (relative.includes('\0')) return undefined;
    const candidate = resolve(root, relative);
    const insideRoot = candidate.startsWith(`${root}${sep}`);
    if (insideRoot && relative.startsWith('assets/') && (await isFile(candidate))) return fileResult(candidate, 'public, max-age=31536000, immutable');
    const rootCache = ROOT_FILES[relative];
    if (insideRoot && rootCache && (await isFile(candidate))) return fileResult(candidate, rootCache);
    if (insideRoot && /^icons\/[\w.-]+\.(png|svg)$/.test(relative) && (await isFile(candidate))) return fileResult(candidate, ICON_CACHE);
    if (relative.startsWith('assets/') || relative.startsWith('icons/')) return undefined;
    return (await isFile(indexPath)) ? fileResult(indexPath, 'no-cache') : undefined;
  };
};
