import { randomBytes } from 'node:crypto';
import {
  ENGINE_VERSION,
  createCategoryRegistry,
  createInMemorySecretRepository,
  createLocalKeyProvider,
  createPluginRegistry,
  createSecretStore,
  type Clock,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '../src/index.js';

export const WORKSPACE = 'ws_main';
export const OTHER_WORKSPACE = 'ws_other';

export const createFakeClock = (start = 1_700_000_000_000) => {
  const state = { now: start };
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => state.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      state.now += ms;
    },
  };
  return {
    clock,
    sleeps,
    advance: (ms: number) => {
      state.now += ms;
    },
  };
};

export const json = (status: number, body: unknown): HttpResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

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

export const createSecrets = (clock?: Clock) =>
  createSecretStore({
    keyProvider: createLocalKeyProvider(randomBytes(32)),
    repository: createInMemorySecretRepository(),
    ...(clock ? { clock } : {}),
  });

export const createRegistry = (options: { clock?: Clock; isPluginInUse?: (workspaceId: string, pluginId: string) => boolean } = {}) =>
  createPluginRegistry({ categories: createCategoryRegistry(), engineVersion: ENGINE_VERSION, ...options });

/** The "MY CUSTOM AI" example from the specification, as a user would build it with the Custom API form. */
export const customAiManifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'com.example.my-custom-ai',
  name: 'MY CUSTOM AI',
  version: '1.0.0',
  engine: '^1.0.0',
  provider: 'Example Inc.',
  category: 'ai-llm',
  auth: { type: 'bearer' },
  baseUrl: 'https://api.example.com/v1',
  permissions: ['network:api.example.com'],
  actions: [
    {
      key: 'generate',
      name: 'Generate Text',
      request: {
        method: 'POST',
        path: '/models/{{input.model}}/generate',
        query: { lang: '{{input.lang}}' },
        body: { prompt: '{{input.prompt}}', maxTokens: '{{input.maxTokens}}' },
      },
      inputSchema: {
        type: 'object',
        required: ['prompt', 'model'],
        properties: {
          prompt: { type: 'string', title: 'Prompt', maxLength: 4000 },
          model: { type: 'string', enum: ['small', 'large'] },
          lang: { type: 'string' },
          maxTokens: { type: 'integer', default: 256 },
        },
      },
      outputSchema: { type: 'object', properties: { text: { type: 'string' }, tokens: { type: 'integer' } } },
      responseMapping: { text: '$.choices[0].text', tokens: '$.usage.total' },
    },
  ],
  limitations: ['Rate limit 60 requests per minute'],
  ...overrides,
});

export const nativeManifest = (id: string, category: string, actionKey: string, properties: Record<string, unknown> = {}) => ({
  id,
  name: id.split('.').at(-1) ?? id,
  version: '1.0.0',
  engine: '^1.0.0',
  provider: 'Universal Flow',
  category,
  runtime: 'native',
  actions: [{ key: actionKey, name: actionKey, inputSchema: { type: 'object', properties }, outputSchema: { type: 'object' } }],
});

export const expectCode = (code: string) => (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;
