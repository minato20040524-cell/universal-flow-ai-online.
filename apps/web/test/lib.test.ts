import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ENGINE_VERSION, generateNodeDefinitions, parseManifest, satisfies } from '@universal-flow/core-engine';
import { ApiError, createApiClient } from '../src/lib/api.js';
import {
  buildManifest,
  emptyField,
  emptyForm,
  emptyRow,
  issuesFor,
  suggestActionKey,
  suggestBody,
  suggestPluginId,
  type CustomApiForm,
} from '../src/lib/manifest-builder.js';
import { describePermission, integrationLamp, marketplaceShelves } from '../src/lib/presentation.js';
import { matchPath, resolveRoute, safeReturnPath } from '../src/lib/router.js';
import type { InstalledIntegration, MarketplacePlugin } from '../src/lib/types.js';

const myCustomAi = (): CustomApiForm => {
  const form = emptyForm();
  return {
    ...form,
    name: 'MY CUSTOM AI',
    id: suggestPluginId('MY CUSTOM AI', 'ws_3f9a12bc77'),
    provider: 'Example Inc.',
    category: 'ai-llm',
    baseUrl: 'https://api.example.com/v1/',
    action: {
      ...form.action,
      name: 'Generate Text',
      key: suggestActionKey('Generate Text'),
      path: '/generate',
      headers: [{ ...emptyRow(), key: 'X-Client', value: 'universal-flow' }, emptyRow()],
      body: '{ "prompt": "{{input.prompt}}" }',
    },
    inputs: [{ ...emptyField(), key: 'prompt', label: 'Prompt', required: true }],
    outputs: [{ ...emptyField(), key: 'text' }, { ...emptyField(), key: 'tokens', type: 'integer' }],
    responseMapping: [
      { ...emptyRow(), key: 'text', value: '$.choices[0].text' },
      { ...emptyRow(), key: 'tokens', value: ' $.usage.total ' },
    ],
    limitations: 'Rate limit 60 requests per minute\n\n',
  };
};

describe('Custom API manifest builder', () => {
  it('suggests ids and keys from names', () => {
    assert.equal(suggestPluginId('MY CUSTOM AI', 'ws_3f9a12bc77'), 'custom.3f9a12bc.my-custom-ai');
    assert.equal(suggestPluginId('Café Bot ✨', 'ws_ABCD'), 'custom.abcd.cafe-bot');
    assert.equal(suggestPluginId('', 'ws_abcd'), '');
    assert.equal(suggestActionKey('Generate Text'), 'generateText');
    assert.equal(suggestActionKey('2nd pass'), 'a2ndPass');
    assert.equal(suggestBody([{ ...emptyField(), key: 'prompt' }, { ...emptyField(), key: '' }]), '{\n  "prompt": "{{input.prompt}}"\n}');
  });

  it('builds the manifest the backend expects', () => {
    const { manifest, issues } = buildManifest(myCustomAi());
    assert.deepEqual(issues, []);
    assert.deepEqual(manifest, {
      id: 'custom.3f9a12bc.my-custom-ai',
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
          key: 'generateText',
          name: 'Generate Text',
          request: { method: 'POST', path: '/generate', headers: { 'X-Client': 'universal-flow' }, query: {}, body: { prompt: '{{input.prompt}}' } },
          inputSchema: { type: 'object', properties: { prompt: { type: 'string', title: 'Prompt' } }, required: ['prompt'] },
          outputSchema: { type: 'object', properties: { text: { type: 'string' }, tokens: { type: 'integer' } } },
          responseMapping: { text: '$.choices[0].text', tokens: '$.usage.total' },
          errorPolicy: { retryOnStatus: [429, 500, 502, 503, 504], timeoutMs: 30_000 },
        },
      ],
      limitations: ['Rate limit 60 requests per minute'],
    });
  });

  it('produces manifests the backend accepts, with the nodes the form previews', () => {
    const { manifest } = buildManifest(myCustomAi());
    const parsed = parseManifest(manifest);
    assert.ok(satisfies(ENGINE_VERSION, parsed.engine));
    const [node] = generateNodeDefinitions(parsed);
    assert.deepEqual(node?.dataInputs.map((port) => port.key), ['prompt']);
    assert.deepEqual(node?.dataOutputs.map((port) => port.key), ['text', 'tokens']);
  });

  it('adds OAuth hosts to the permissions and parses scopes', () => {
    const form = myCustomAi();
    const { manifest, issues } = buildManifest({
      ...form,
      auth: { ...form.auth, type: 'oauth2', authorizationUrl: 'https://auth.example.com/authorize', tokenUrl: 'https://auth.example.com/token', scopes: 'read, write  files' },
    });
    assert.deepEqual(issues, []);
    assert.deepEqual(manifest.permissions, ['network:api.example.com', 'network:auth.example.com']);
    assert.deepEqual(manifest.auth, { type: 'oauth2', authorizationUrl: 'https://auth.example.com/authorize', tokenUrl: 'https://auth.example.com/token', scopes: ['read', 'write', 'files'] });
    assert.doesNotThrow(() => parseManifest(manifest));
  });

  it('points at every field that needs fixing', () => {
    const form = myCustomAi();
    const { issues } = buildManifest({
      ...form,
      name: ' ',
      baseUrl: 'http://api.example.com',
      action: { ...form.action, method: 'GET', path: 'generate', body: '{ broken' },
      inputs: [{ ...emptyField(), key: '1st' }, { ...emptyField(), key: '1st' }],
      responseMapping: [{ ...emptyRow(), key: 'summary', value: 'choices.0' }],
      errors: { retryOnStatus: '429, 200', timeoutSeconds: '500' },
    });
    const paths = issues.map((issue) => issue.path);
    for (const expected of ['name', 'baseUrl', 'action.path', 'action.body', 'inputs', 'responseMapping', 'errors.retryOnStatus', 'errors.timeoutSeconds']) {
      assert.ok(paths.includes(expected), `expected an issue for ${expected}: ${paths.join(', ')}`);
    }
    assert.equal(issuesFor(issues, 'action').length, 3, 'GET with body, invalid JSON, path without /');
    assert.equal(issuesFor(issues, 'errors').length, 2);
  });
});

describe('presentation rules', () => {
  const integration: InstalledIntegration = {
    pluginId: 'p',
    name: 'P',
    provider: 'X',
    category: 'ai-llm',
    icon: undefined,
    source: 'custom',
    version: '1.0.0',
    status: 'active',
    enabled: true,
    grantedPermissions: [],
    limitations: [],
    updateAvailable: undefined,
  };
  const credential = (status: 'connected' | 'expired' | 'error') => ({ id: 'c', pluginId: 'p', authType: 'bearer' as const, status, fieldNames: [], createdAt: 0, expiresAt: undefined });

  it('shows the most urgent problem first', () => {
    assert.equal(integrationLamp({ ...integration, enabled: false, status: 'testing' }, [], true).label, 'Disabled');
    assert.equal(integrationLamp({ ...integration, status: 'testing' }, [], true).tone, 'attention');
    assert.equal(integrationLamp(integration, [], true).label, 'Connect an account');
    assert.equal(integrationLamp(integration, [credential('expired')], true).label, 'Account expired');
    assert.equal(integrationLamp(integration, [credential('error'), credential('connected')], true).tone, 'ready');
    assert.equal(integrationLamp(integration, [], false).tone, 'ready');
  });

  it('explains permissions in plain words', () => {
    assert.equal(describePermission('network:api.example.com'), 'Send requests to api.example.com');
    assert.equal(describePermission('network:*.example.com'), 'Send requests to any address under example.com');
  });

  it('groups the marketplace into shelves', () => {
    const now = Date.parse('2026-11-07T00:00:00Z');
    const plugin = (id: string, overrides: Partial<MarketplacePlugin>): MarketplacePlugin => ({
      id,
      name: id,
      provider: 'X',
      category: 'messaging',
      description: undefined,
      source: 'official',
      version: '1.0.0',
      status: 'active',
      icon: undefined,
      limitations: [],
      registeredAt: now - 90 * 86_400_000,
      ports: { inputs: 1, outputs: 1 },
      installs: 0,
      installed: false,
      ...overrides,
    });
    const shelves = marketplaceShelves(
      [plugin('telegram', { installs: 3 }), plugin('claude', { category: 'ai-llm', installs: 9 }), plugin('summarizer', { source: 'community', registeredAt: now - 86_400_000 })],
      now,
    );
    assert.deepEqual(shelves.map((shelf) => shelf.id), ['featured', 'popular', 'new', 'ai', 'community']);
    assert.deepEqual(shelves[1]?.plugins.map((item) => item.id), ['claude', 'telegram']);
    assert.deepEqual(shelves[2]?.plugins.map((item) => item.id), ['summarizer']);
  });
});

describe('router', () => {
  it('matches patterns and keeps return paths on this site', () => {
    assert.deepEqual(matchPath('/integrations/:pluginId', '/integrations/custom.my-api'), { pluginId: 'custom.my-api' });
    assert.equal(matchPath('/integrations/:pluginId', '/integrations'), undefined);
    const routes = [
      { name: 'new', pattern: '/integrations/new' },
      { name: 'detail', pattern: '/integrations/:pluginId' },
    ] as const;
    assert.equal(resolveRoute(routes, '/integrations/new')?.name, 'new');
    assert.equal(safeReturnPath('//evil.example'), '/integrations');
    assert.equal(safeReturnPath('/marketplace?q=ai'), '/marketplace?q=ai');
  });
});

describe('API client', () => {
  it('sends the CSRF header on changes only and surfaces server issues', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const responses = [
      new Response(JSON.stringify({ integrations: [] }), { status: 200 }),
      new Response(JSON.stringify({ error: { code: 'VALIDATION', message: 'Invalid plugin manifest', issues: [{ path: '$.id', message: 'bad' }] } }), { status: 400 }),
    ];
    const api = createApiClient({
      csrfToken: () => 'csrf-1',
      fetch: async (url, init) => {
        calls.push({ url, init });
        const response = responses.shift();
        if (!response) throw new Error('no response');
        return response;
      },
    });
    assert.deepEqual(await api.integrations(), []);
    await assert.rejects(api.createCustom({}), (error: unknown) => error instanceof ApiError && error.status === 400 && error.issues[0]?.path === '$.id');
    const [read, write] = calls;
    assert.equal(new Headers(read?.init.headers).get('x-csrf-token'), null);
    assert.equal(new Headers(write?.init.headers).get('x-csrf-token'), 'csrf-1');
    assert.equal(write?.url, '/v1/integrations/custom');
  });
});
