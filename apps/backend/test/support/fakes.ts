import { randomBytes } from 'node:crypto';
import { createLocalKeyProvider, type HttpClient, type HttpRequest, type HttpResponse, type NativeHandler } from '@universal-flow/core-engine';
import { createApp, type App } from '../../src/app.js';
import { migrate } from '../../src/db/migrate.js';
import { createHttpServer } from '../../src/http/server.js';
import type { OfficialPlugin } from '../../src/context.js';
import { createTestDatabase, type TestDatabase } from './psql-client.js';

export const json = (status: number, body: unknown): HttpResponse => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const createFakeHttp = (respond: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>) => {
  const requests: HttpRequest[] = [];
  const http: HttpClient = {
    send: async (request) => {
      requests.push(request);
      return respond(request);
    },
  };
  return { http, requests };
};

export const createControlledClock = (start: number) => {
  const state = { now: start };
  return {
    now: () => state.now,
    sleep: async (ms: number) => {
      state.now += ms;
    },
    advance: (ms: number) => {
      state.now += ms;
    },
  };
};

export const nativePlugin = (id: string, category: string, action: string, handler: NativeHandler): OfficialPlugin => ({
  manifest: {
    id,
    name: id.split('.').at(-1) ?? id,
    version: '1.0.0',
    engine: '^1.0.0',
    provider: 'Universal Flow',
    category,
    runtime: 'native',
    actions: [{ key: action, name: action, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }],
  },
  handlers: { [action]: handler },
});

export type ApiResponse = { status: number; body: unknown; text: string; headers: Headers };

export type TestServer = {
  app: App;
  db: TestDatabase;
  baseUrl: string;
  request: (method: string, path: string, options?: { token?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string }) => Promise<ApiResponse>;
  /** Runs worker batches until the queue has nothing due. */
  drain: () => Promise<number>;
  close: () => Promise<void>;
};

export const startTestServer = async (options: {
  allowSignup?: boolean;
  outboundHttp: HttpClient;
  officialPlugins: OfficialPlugin[];
  clock: ReturnType<typeof createControlledClock>;
  webDistDir?: string;
}): Promise<TestServer> => {
  const db = await createTestDatabase();
  await migrate(db);
  const server = { publicBaseUrl: 'https://api.universalflow.test' };
  const app = await createApp({
    sql: db,
    keyProvider: createLocalKeyProvider(randomBytes(32)),
    outboundHttp: options.outboundHttp,
    publicBaseUrl: server.publicBaseUrl,
    sessionSecret: randomBytes(32),
    clock: options.clock,
    officialPlugins: options.officialPlugins,
    workerId: 'test-worker',
    ...(options.webDistDir ? { webDistDir: options.webDistDir } : {}),
    ...(options.allowSignup === undefined ? {} : { allowSignup: options.allowSignup }),
    worker: { batchSize: 5, leaseMs: 60_000 },
  });
  const http = createHttpServer({ ...app.http, log: () => undefined });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    app,
    db,
    baseUrl,
    request: async (method, path, { token, body, headers = {}, rawBody } = {}) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined || rawBody !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed, text, headers: response.headers };
    },
    drain: async () => {
      let total = 0;
      for (let round = 0; round < 50; round += 1) {
        const ran = await app.worker.tick();
        total += ran;
        if (ran === 0) return total;
      }
      throw new Error('Queue did not drain in 50 rounds');
    },
    close: async () => {
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await db.drop();
    },
  };
};
