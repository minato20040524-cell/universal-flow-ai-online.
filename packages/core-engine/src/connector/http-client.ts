import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ConnectorError, EngineError } from '../errors.js';
import type { HttpMethod } from '../manifest/types.js';
import { isPrivateAddress, normalizeHostname } from '../security/url-guard.js';

export type HttpRequest = {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  timeoutMs: number;
  maxResponseBytes: number;
};

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/** The only way the engine reaches the network; swap it for a fake in tests. */
export type HttpClient = { send: (request: HttpRequest) => Promise<HttpResponse> };

export type FetchHttpClientOptions = {
  resolveHost?: (hostname: string) => Promise<string[]>;
};

const defaultResolveHost = async (hostname: string): Promise<string[]> =>
  (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);

const readLimited = async (response: Response, maxBytes: number): Promise<string> => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ConnectorError(`Response is larger than ${maxBytes} bytes`, { status: response.status, retryable: false });
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

/**
 * Production client on top of fetch. It refuses hosts that resolve to private
 * addresses and never follows redirects. Note: the DNS check and the connection
 * resolve separately; for full DNS-rebinding protection, pin the checked address
 * with a custom undici dispatcher.
 */
export const createFetchHttpClient = (options: FetchHttpClientOptions = {}): HttpClient => {
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  return {
    send: async (request) => {
      const url = new URL(request.url);
      const host = normalizeHostname(url.hostname);
      const addresses = isIP(host) ? [host] : await resolveHost(host);
      if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
        throw new EngineError('SECURITY', `Host ${host} resolves to a private address`);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const response = await fetch(url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: 'manual',
          signal: controller.signal,
        });
        const body = await readLimited(response, request.maxResponseBytes);
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return { status: response.status, headers, body };
      } catch (error) {
        if (error instanceof EngineError) throw error;
        const reason = controller.signal.aborted ? `timed out after ${request.timeoutMs} ms` : error instanceof Error ? error.message : String(error);
        throw new ConnectorError(`Request to ${host} failed: ${reason}`, { retryable: true });
      } finally {
        clearTimeout(timer);
      }
    },
  };
};
