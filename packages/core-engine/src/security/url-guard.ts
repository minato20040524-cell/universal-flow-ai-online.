import { isIP } from 'node:net';
import { EngineError } from '../errors.js';

/**
 * Guards every outgoing request against SSRF: only HTTPS, never a private or
 * internal address, and only hosts the plugin declared in its permissions.
 */

const PRIVATE_IPV4_RANGES: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const ipv4ToNumber = (address: string): number =>
  address.split('.').reduce((total, part) => total * 256 + Number(part), 0);

const isPrivateIPv4 = (address: string): boolean => {
  const value = ipv4ToNumber(address);
  return PRIVATE_IPV4_RANGES.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = ipv4ToNumber(base);
    return value >= start && value < start + size;
  });
};

const isPrivateIPv6 = (address: string): boolean => {
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (mapped) return isPrivateIPv4(mapped);
  // WHATWG URL serializes IPv4-mapped addresses in hex, e.g. ::ffff:7f00:1 for 127.0.0.1.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped?.[1] !== undefined && hexMapped[2] !== undefined) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    return isPrivateIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
};

export const isPrivateAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);
  return false;
};

export const normalizeHostname = (hostname: string): string => hostname.replace(/^\[|\]$/g, '').toLowerCase();

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

export const isBlockedHostname = (hostname: string): boolean => {
  const host = normalizeHostname(hostname);
  return host === 'localhost' || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix)) || isPrivateAddress(host);
};

const matchHost = (host: string, pattern: string): boolean => {
  const normalizedPattern = pattern.toLowerCase();
  if (normalizedPattern.startsWith('*.')) return host.endsWith(normalizedPattern.slice(1));
  return host === normalizedPattern;
};

export const NETWORK_PERMISSION_PREFIX = 'network:';

export const hostMatchesPermission = (hostname: string, permissions: readonly string[]): boolean => {
  const host = normalizeHostname(hostname);
  return permissions.some(
    (permission) =>
      permission.startsWith(NETWORK_PERMISSION_PREFIX) &&
      matchHost(host, permission.slice(NETWORK_PERMISSION_PREFIX.length)),
  );
};

export const assertSafeUrl = (url: URL, permissions: readonly string[]): void => {
  if (url.protocol !== 'https:') {
    throw new EngineError('SECURITY', `Only https:// URLs are allowed, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new EngineError('SECURITY', 'Credentials inside the URL are not allowed');
  }
  if (isBlockedHostname(url.hostname)) {
    throw new EngineError('SECURITY', `Host ${url.hostname} is private or internal and cannot be called`);
  }
  if (!hostMatchesPermission(url.hostname, permissions)) {
    throw new EngineError('PERMISSION', `Plugin has no network permission for host ${url.hostname}`);
  }
};
