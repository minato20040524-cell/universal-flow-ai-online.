import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readJsonPath, signWebhookPayload } from '@universal-flow/core-engine';
import { createPgWorkspaceRepository } from '../src/repositories/workspace-repository.js';
import { createControlledClock, createFakeHttp, json, nativePlugin, startTestServer, type TestServer } from './support/fakes.js';

const START = Date.parse('2026-11-07T00:00:00Z');
const TOKEN_SECRET = 'sk-live-CUSTOM-AI-SECRET';
const get = (value: unknown, path: string): unknown => readJsonPath(value, path);
const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

const customAi = {
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
      request: { method: 'POST', path: '/generate', body: { prompt: '{{input.prompt}}' } },
      inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { text: { type: 'string' }, tokens: { type: 'integer' } } },
      responseMapping: { text: '$.choices[0].text', tokens: '$.usage.total' },
    },
  ],
};

const drive = {
  id: 'io.universalflow.gdrive',
  name: 'Google Drive',
  version: '1.0.0',
  engine: '^1.0.0',
  provider: 'Universal Flow',
  category: 'cloud-storage',
  auth: { type: 'oauth2', authorizationUrl: 'https://auth.example.com/authorize', tokenUrl: 'https://auth.example.com/token', scopes: ['drive.file'] },
  baseUrl: 'https://drive.example.com',
  permissions: ['network:drive.example.com', 'network:auth.example.com'],
  actions: [
    {
      key: 'upload',
      name: 'Upload File',
      request: { method: 'POST', path: '/files', body: { name: '{{input.name}}', content: '{{input.content}}' } },
      inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, content: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { fileId: { type: 'string' } } },
      responseMapping: { fileId: '$.id' },
    },
  ],
};

describe('backend API end to end (PostgreSQL + HTTP + worker)', () => {
  const clock = createControlledClock(START);
  const published: string[] = [];
  const outbound = createFakeHttp(async (request) => {
    const url = new URL(request.url);
    const body: unknown = request.body && request.headers['content-type'] === 'application/json' ? JSON.parse(request.body) : undefined;
    if (url.hostname === 'api.example.com') {
      if (request.headers.authorization !== `Bearer ${TOKEN_SECRET}`) return json(401, { error: 'bad token' });
      return json(200, { choices: [{ text: `ai(${text(get(body, '$.prompt'))})` }], usage: { total: 7 } });
    }
    if (url.hostname === 'auth.example.com') return json(200, { access_token: 'drive-access-1', refresh_token: 'drive-refresh-1', expires_in: 3600 });
    if (url.hostname === 'drive.example.com') {
      if (request.headers.authorization !== 'Bearer drive-access-1') return json(401, {});
      return json(201, { id: 'file_99', name: get(body, '$.name') });
    }
    return json(404, {});
  });
  const publish = (platform: string) =>
    nativePlugin(`io.universalflow.${platform}`, 'social-media', 'publish', async ({ input }) => {
      published.push(platform);
      return { postUrl: `https://${platform}.example.com/p/${text(input.fileId)}` };
    });

  let server: TestServer;
  let owner = '';
  let viewer = '';
  let admin = '';
  let outsider = '';
  let workflowId = '';
  let executionId = '';
  let webhookUrl = '';
  let webhookSecret = '';

  before(async () => {
    server = await startTestServer({
      outboundHttp: outbound.http,
      clock,
      officialPlugins: [
        { manifest: drive },
        nativePlugin('io.universalflow.claude', 'ai-llm', 'chat', async ({ input }) => ({ text: `claude(${text(input.prompt)})` })),
        nativePlugin('io.universalflow.sheets', 'office-documents', 'append', async ({ input }) => ({ appended: input.row })),
        publish('youtube'),
        publish('facebook'),
        publish('instagram'),
      ],
    });
    const workspaces = createPgWorkspaceRepository(server.db);
    const main = await workspaces.createWorkspace('Main', START);
    owner = (await workspaces.createToken({ workspaceId: main.id, name: 'owner', role: 'owner', now: START })).token;
    viewer = (await workspaces.createToken({ workspaceId: main.id, name: 'viewer', role: 'viewer', now: START })).token;
    const platform = await workspaces.createWorkspace('Platform', START);
    admin = (await workspaces.createToken({ workspaceId: platform.id, name: 'admin', role: 'owner', isPlatformAdmin: true, now: START })).token;
    const other = await workspaces.createWorkspace('Other', START);
    outsider = (await workspaces.createToken({ workspaceId: other.id, name: 'other', role: 'owner', now: START })).token;
  });

  after(async () => {
    await server.close();
  });

  it('serves health and rejects bad requests clearly', async () => {
    const health = await server.request('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(get(health.body, '$.status'), 'ok');
    assert.equal((await server.request('GET', '/v1/integrations')).status, 401);
    assert.equal((await server.request('GET', '/v1/integrations', { token: 'uf_wrong' })).status, 401);
    assert.equal((await server.request('GET', '/v1/nowhere', { token: owner })).status, 404);
    assert.equal((await server.request('PATCH', '/v1/workflows', { token: owner, body: {} })).status, 405);
    const badJson = await server.request('POST', '/v1/workflows', { token: owner, rawBody: '{nope' });
    assert.equal(badJson.status, 400);
    assert.equal(get(badJson.body, '$.error.code'), 'INVALID_JSON');
    assert.ok(badJson.headers.get('x-request-id'));
  });

  it('lists the marketplace and enforces roles', async () => {
    const market = await server.request('GET', '/v1/marketplace?category=social-media', { token: viewer });
    assert.deepEqual(
      (get(market.body, '$.plugins') as unknown[]).map((plugin) => get(plugin, '$.id')).sort(),
      ['io.universalflow.facebook', 'io.universalflow.instagram', 'io.universalflow.youtube'],
    );
    assert.equal((await server.request('POST', '/v1/integrations/io.universalflow.claude/install', { token: viewer, body: {} })).status, 403);
    for (const pluginId of ['claude', 'sheets', 'youtube', 'facebook', 'instagram']) {
      const installed = await server.request('POST', `/v1/integrations/io.universalflow.${pluginId}/install`, { token: owner, body: { grantPermissions: [] } });
      assert.equal(installed.status, 201, installed.text);
    }
    const denied = await server.request('POST', '/v1/integrations/io.universalflow.gdrive/install', { token: owner, body: { grantPermissions: ['network:drive.example.com'] } });
    assert.equal(denied.status, 403);
    assert.match(text(get(denied.body, '$.error.message')), /network:auth\.example\.com/);
    const installed = await server.request('POST', '/v1/integrations/io.universalflow.gdrive/install', { token: owner, body: { grantPermissions: drive.permissions } });
    assert.equal(installed.status, 201);
  });

  it('adds MY CUSTOM AI, stores its key in the vault and activates it through Test API', async () => {
    const created = await server.request('POST', '/v1/integrations/custom', { token: owner, body: { manifest: customAi } });
    assert.equal(created.status, 201, created.text);
    assert.equal(get(created.body, '$.status'), 'testing');
    assert.equal(get(created.body, '$.nodes[0].type'), 'com.example.my-custom-ai@1.0.0:generate');
    assert.equal((await server.request('GET', '/v1/marketplace?text=custom', { token: outsider })).text.includes('my-custom-ai'), false);

    const credential = await server.request('POST', '/v1/credentials', { token: owner, body: { pluginId: customAi.id, values: { token: TOKEN_SECRET } } });
    assert.equal(credential.status, 201, credential.text);
    assert.ok(!credential.text.includes(TOKEN_SECRET));
    const credentialId = text(get(credential.body, '$.id'));
    const [row] = await server.db.query('SELECT ciphertext FROM credentials WHERE id = $1', [credentialId]);
    assert.ok(row && !JSON.stringify(row).includes(TOKEN_SECRET), 'only ciphertext is stored');

    const failing = await server.request('POST', `/v1/integrations/${customAi.id}/test`, { token: owner, body: { action: 'generate', input: {}, credentialId } });
    assert.equal(get(failing.body, '$.report.ok'), false);
    assert.equal(get(failing.body, '$.activated'), false);

    const passing = await server.request('POST', `/v1/integrations/${customAi.id}/test`, { token: owner, body: { action: 'generate', input: { prompt: 'halo' }, credentialId } });
    assert.equal(passing.status, 200, passing.text);
    assert.equal(get(passing.body, '$.report.ok'), true);
    assert.deepEqual(get(passing.body, '$.report.output'), { text: 'ai(halo)', tokens: 7 });
    assert.equal(get(passing.body, '$.report.request.headers.authorization'), '[REDACTED]');
    assert.equal(get(passing.body, '$.activated'), true);
    assert.ok(!passing.text.includes(TOKEN_SECRET));

    const detail = await server.request('GET', `/v1/integrations/${customAi.id}`, { token: viewer });
    assert.equal(get(detail.body, '$.integration.status'), 'active');
    assert.deepEqual(get(detail.body, '$.permissions.declared'), ['network:api.example.com']);
    const palette = await server.request('GET', '/v1/nodes', { token: viewer });
    const types = (get(palette.body, '$.nodes') as unknown[]).map((node) => get(node, '$.type'));
    assert.ok(types.includes('com.example.my-custom-ai@1.0.0:generate'));
    assert.ok(types.includes('builtin:approval'));
  });

  it('connects Google Drive with OAuth 2.0 + PKCE', async () => {
    const started = await server.request('POST', '/v1/oauth/io.universalflow.gdrive/start', { token: owner, body: { clientId: 'client-1', clientSecret: 'client-secret' } });
    assert.equal(started.status, 201, started.text);
    const authorizationUrl = new URL(text(get(started.body, '$.authorizationUrl')));
    assert.equal(authorizationUrl.searchParams.get('redirect_uri'), 'https://api.universalflow.test/oauth/callback');
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    const state = authorizationUrl.searchParams.get('state') ?? '';
    const pendingId = text(get(started.body, '$.credentialId'));

    const callback = await server.request('GET', `/oauth/callback?state=${encodeURIComponent(state)}&code=auth-code-1`);
    assert.equal(callback.status, 200, callback.text);
    assert.match(callback.text, /Account connected/);
    const tokenRequest = outbound.requests.find((request) => request.url === 'https://auth.example.com/token');
    const form = new URLSearchParams(tokenRequest?.body ?? '');
    assert.ok(form.get('code_verifier'));
    assert.equal(form.get('client_secret'), 'client-secret');
    assert.equal(form.get('code'), 'auth-code-1');

    const replay = await server.request('GET', `/oauth/callback?state=${encodeURIComponent(state)}&code=auth-code-1`);
    assert.equal(replay.status, 400, 'a state works once');
    const credentials = await server.request('GET', '/v1/credentials', { token: owner });
    const connected = (get(credentials.body, '$.credentials') as unknown[]).find((item) => get(item, '$.id') === pendingId);
    assert.equal(get(connected, '$.status'), 'connected');
    assert.deepEqual(get(connected, '$.fieldNames'), ['accessToken', 'clientId', 'clientSecret', 'refreshToken']);
  });

  it('builds the specification workflow, activates it and receives a signed webhook', async () => {
    const credentials = await server.request('GET', '/v1/credentials', { token: owner });
    const list = get(credentials.body, '$.credentials') as unknown[];
    const credentialFor = (pluginId: string) => text(get(list.find((item) => get(item, '$.pluginId') === pluginId), '$.id'));
    const action = (id: string, plugin: string, actionKey: string, input: Record<string, unknown>, credentialId?: string) => ({
      id,
      kind: 'action',
      plugin,
      action: actionKey,
      input,
      ...(credentialId ? { credentialId } : {}),
    });
    const graph = {
      nodes: [
        { id: 'telegram', kind: 'trigger', trigger: 'webhook' },
        action('claude', 'io.universalflow.claude@1.0.0', 'chat', { prompt: '{{trigger.body.message.text}}' }),
        action('customAi', 'com.example.my-custom-ai@1.0.0', 'generate', { prompt: 'Improve: {{nodes.claude.output.text}}' }, credentialFor(customAi.id)),
        action('drive', 'io.universalflow.gdrive@1.0.0', 'upload', { name: 'script.txt', content: '{{nodes.customAi.output.text}}' }, credentialFor(drive.id)),
        action('sheets', 'io.universalflow.sheets@1.0.0', 'append', { row: ['{{nodes.drive.output.fileId}}', '{{trigger.body.message.from}}'] }),
        { id: 'approval', kind: 'approval', message: 'Publish the video about {{trigger.body.message.text}}?' },
        action('youtube', 'io.universalflow.youtube@1.0.0', 'publish', { fileId: '{{nodes.drive.output.fileId}}' }),
        action('facebook', 'io.universalflow.facebook@1.0.0', 'publish', { fileId: '{{nodes.drive.output.fileId}}' }),
        action('instagram', 'io.universalflow.instagram@1.0.0', 'publish', { fileId: '{{nodes.drive.output.fileId}}' }),
      ],
      edges: [
        { id: 'e1', from: 'telegram', to: 'claude' },
        { id: 'e2', from: 'claude', to: 'customAi' },
        { id: 'e3', from: 'customAi', to: 'drive' },
        { id: 'e4', from: 'drive', to: 'sheets' },
        { id: 'e5', from: 'sheets', to: 'approval' },
        { id: 'e6', from: 'approval', port: 'approved', to: 'youtube' },
        { id: 'e7', from: 'approval', port: 'approved', to: 'facebook' },
        { id: 'e8', from: 'approval', port: 'approved', to: 'instagram' },
      ],
    };
    const invalid = await server.request('POST', '/v1/workflows', { token: owner, body: { name: 'Broken', graph: { nodes: [{ id: 'a', kind: 'condition', when: 'x' }], edges: [] } } });
    assert.equal(invalid.status, 400);
    assert.ok(Array.isArray(get(invalid.body, '$.error.issues')));

    // A node may not borrow another integration's credential (that would hand Drive tokens to MY CUSTOM AI).
    const borrowing = { nodes: [graph.nodes[0], action('steal', 'com.example.my-custom-ai@1.0.0', 'generate', { prompt: 'x' }, credentialFor(drive.id))], edges: [{ id: 'e1', from: 'telegram', to: 'steal' }] };
    const sneaky = await server.request('POST', '/v1/workflows', { token: owner, body: { name: 'Sneaky', graph: borrowing } });
    const sneakyRun = await server.request('POST', `/v1/workflows/${text(get(sneaky.body, '$.id'))}/run`, { token: owner, body: {} });
    assert.equal(sneakyRun.status, 400);
    assert.match(sneakyRun.text, /belongs to io\.universalflow\.gdrive/);

    const created = await server.request('POST', '/v1/workflows', { token: owner, body: { name: 'Content pipeline', graph } });
    assert.equal(created.status, 201, created.text);
    workflowId = text(get(created.body, '$.id'));
    assert.equal((await server.request('GET', `/v1/workflows/${workflowId}`, { token: outsider })).status, 404);

    const activated = await server.request('POST', `/v1/workflows/${workflowId}/activate`, { token: owner, body: {} });
    assert.equal(activated.status, 200, activated.text);
    webhookUrl = text(get(activated.body, '$.webhooks[0].url'));
    assert.match(webhookUrl, /^https:\/\/api\.universalflow\.test\/hooks\/hook_/);
    const hooks = await server.request('GET', `/v1/workflows/${workflowId}/webhooks`, { token: owner });
    webhookSecret = text(get(hooks.body, '$.webhooks[0].secret'));
    assert.equal((await server.request('GET', `/v1/workflows/${workflowId}/webhooks`, { token: viewer })).status, 403);
    const live = await server.request('GET', `/v1/workflows/${workflowId}/triggers`, { token: viewer });
    assert.equal(live.status, 200, live.text);
    assert.equal(get(live.body, '$.webhooks[0].url'), webhookUrl, 'viewers see where to send requests');
    assert.ok(!live.text.includes(webhookSecret), 'but never the signing secret');

    const path = new URL(webhookUrl).pathname;
    const payload = JSON.stringify({ message: { text: 'Ide video kopi', from: 'hinata' } });
    const unsigned = await server.request('POST', path, { rawBody: payload });
    assert.equal(unsigned.status, 401);
    const signature = signWebhookPayload(webhookSecret, clock.now(), payload);
    const accepted = await server.request('POST', path, { rawBody: payload, headers: { 'x-uf-timestamp': String(clock.now()), 'x-uf-signature': signature } });
    assert.equal(accepted.status, 202, accepted.text);
    executionId = text(get(accepted.body, '$.executionId'));
    const queued = await server.request('GET', `/v1/executions/${executionId}`, { token: viewer });
    assert.equal(get(queued.body, '$.execution.status'), 'queued');
  });

  it('runs on the worker, pauses for approval and publishes after it', async () => {
    await server.drain();
    const waiting = await server.request('GET', `/v1/executions/${executionId}`, { token: viewer });
    assert.equal(get(waiting.body, '$.execution.status'), 'waiting', waiting.text);
    assert.equal(get(waiting.body, '$.execution.nodes.approval.output.message'), 'Publish the video about Ide video kopi?');
    assert.deepEqual(get(waiting.body, '$.execution.nodes.sheets.output'), { appended: ['file_99', 'hinata'] });
    assert.equal(get(waiting.body, '$.execution.nodes.customAi.output.text'), 'ai(Improve: claude(Ide video kopi))');
    assert.ok(!waiting.text.includes(TOKEN_SECRET));
    assert.deepEqual(published, []);

    assert.equal((await server.request('POST', `/v1/executions/${executionId}/approvals/approval`, { token: viewer, body: { approved: true } })).status, 403);
    const approved = await server.request('POST', `/v1/executions/${executionId}/approvals/approval`, { token: owner, body: { approved: true, comment: 'Siap tayang' } });
    assert.equal(approved.status, 202, approved.text);
    const twice = await server.request('POST', `/v1/executions/${executionId}/approvals/approval`, { token: owner, body: { approved: false } });
    assert.equal(twice.status, 409);

    await server.drain();
    const finished = await server.request('GET', `/v1/executions/${executionId}`, { token: viewer });
    assert.equal(get(finished.body, '$.execution.status'), 'succeeded', finished.text);
    assert.deepEqual([...published].sort(), ['facebook', 'instagram', 'youtube']);
    assert.equal(get(finished.body, '$.execution.nodes.youtube.output.postUrl'), 'https://youtube.example.com/p/file_99');
    const steps = get(finished.body, '$.steps') as unknown[];
    assert.deepEqual(
      steps.map((step) => get(step, '$.nodeId')),
      ['telegram', 'claude', 'customAi', 'drive', 'sheets', 'approval', 'approval', ...steps.slice(7).map((step) => get(step, '$.nodeId'))],
    );
    assert.equal(steps.length, 10);
    const history = await server.request('GET', `/v1/executions?workflowId=${workflowId}&status=succeeded`, { token: viewer });
    assert.equal((get(history.body, '$.executions') as unknown[]).length, 1);
  });

  it('refuses to uninstall a plugin an active workflow needs', async () => {
    const blocked = await server.request('DELETE', `/v1/integrations/${customAi.id}`, { token: owner });
    assert.equal(blocked.status, 409);
    assert.match(text(get(blocked.body, '$.error.message')), /used by active workflows/);
  });

  it('accepts token-authenticated webhooks for services that cannot sign', async () => {
    const path = new URL(webhookUrl).pathname;
    const wrong = await server.request('POST', path, { rawBody: '{}', headers: { 'x-uf-webhook-token': 'nope' } });
    assert.equal(wrong.status, 401);
    const ok = await server.request('POST', path, { rawBody: '{"message":{"text":"lagi","from":"bot"}}', headers: { 'x-uf-webhook-token': webhookSecret } });
    assert.equal(ok.status, 202);
    assert.match(webhookSecret, /^[A-Za-z0-9_-]{1,256}$/, 'the secret is a valid Telegram secret_token');
    const telegram = await server.request('POST', path, { rawBody: '{"message":{"text":"dari bot","from":"telegram"}}', headers: { 'x-telegram-bot-api-secret-token': webhookSecret } });
    assert.equal(telegram.status, 202, 'a Telegram bot webhook is accepted with its own header');
    await server.request('POST', `/v1/workflows/${workflowId}/deactivate`, { token: owner, body: {} });
    const closed = await server.request('POST', path, { rawBody: '{}', headers: { 'x-uf-webhook-token': webhookSecret } });
    assert.equal(closed.status, 404, 'an inactive workflow does not accept webhooks');
    assert.deepEqual(get((await server.request('GET', `/v1/workflows/${workflowId}/triggers`, { token: owner })).body, '$.webhooks'), []);
    await server.drain();
  });

  it('runs cron schedules exactly once per occurrence and resumes long delays', async () => {
    const graph = {
      nodes: [
        { id: 'every5', kind: 'trigger', trigger: 'schedule', schedule: '*/5 * * * *', timezone: 'Asia/Makassar' },
        { id: 'wait', kind: 'delay', ms: 3_600_000 },
        { id: 'report', kind: 'transform', output: { at: '{{trigger.scheduledFor}}' } },
      ],
      edges: [
        { id: 'e1', from: 'every5', to: 'wait' },
        { id: 'e2', from: 'wait', to: 'report' },
      ],
    };
    const created = await server.request('POST', '/v1/workflows', { token: owner, body: { name: 'Hourly report', graph } });
    const id = text(get(created.body, '$.id'));
    const activated = await server.request('POST', `/v1/workflows/${id}/activate`, { token: owner, body: {} });
    assert.equal(get(activated.body, '$.schedules[0].nextRunAt'), START + 5 * 60_000);

    assert.equal(await server.app.scheduler.tick(), 0, 'not due yet');
    clock.advance(5 * 60_000);
    const [first, second] = await Promise.all([server.app.scheduler.tick(), server.app.scheduler.tick()]);
    assert.equal(first + second, 1, 'two schedulers, one run');
    await server.drain();

    const runs = await server.request('GET', `/v1/executions?workflowId=${id}`, { token: viewer });
    const [run] = get(runs.body, '$.executions') as unknown[];
    assert.equal(get(run, '$.status'), 'waiting');
    assert.equal(get(run, '$.nodes.wait.waitingFor'), 'delay');

    clock.advance(3_600_000);
    await server.drain();
    const done = await server.request('GET', `/v1/executions/${text(get(run, '$.id'))}`, { token: viewer });
    assert.equal(get(done.body, '$.execution.status'), 'succeeded', done.text);
    assert.equal(get(done.body, '$.execution.nodes.report.output.at'), new Date(START + 5 * 60_000).toISOString());
  });

  it('runs manually, keeps workspaces apart and records an audit trail', async () => {
    const run = await server.request('POST', `/v1/workflows/${workflowId}/run`, { token: owner, body: { payload: { body: { message: { text: 'manual', from: 'me' } } } } });
    assert.equal(run.status, 202, run.text);
    await server.drain();
    const execution = await server.request('GET', `/v1/executions/${text(get(run.body, '$.executionId'))}`, { token: owner });
    assert.equal(get(execution.body, '$.execution.status'), 'waiting');
    assert.equal((await server.request('GET', `/v1/executions/${text(get(run.body, '$.executionId'))}`, { token: outsider })).status, 404);
    const cancelled = await server.request('POST', `/v1/executions/${text(get(run.body, '$.executionId'))}/cancel`, { token: owner, body: {} });
    assert.equal(get(cancelled.body, '$.status'), 'cancelled');

    const stale = await server.request('PUT', `/v1/workflows/${workflowId}`, { token: owner, body: { graph: { nodes: [{ id: 't', kind: 'trigger', trigger: 'manual' }], edges: [] }, expectedVersion: 0 } });
    assert.equal(stale.status, 400);
    const conflict = await server.request('PUT', `/v1/workflows/${workflowId}`, { token: owner, body: { graph: { nodes: [{ id: 't', kind: 'trigger', trigger: 'manual' }], edges: [] }, expectedVersion: 7 } });
    assert.equal(conflict.status, 409);

    const audit = await server.request('GET', '/v1/audit?limit=200', { token: owner });
    const actions = new Set((get(audit.body, '$.entries') as unknown[]).map((entry) => get(entry, '$.action')));
    for (const expected of ['integration.custom.register', 'credential.create', 'integration.test', 'credential.oauth.complete', 'workflow.activate', 'execution.approve', 'execution.cancel']) {
      assert.ok(actions.has(expected), `audit has ${expected}`);
    }
  });

  it('lets platform admins review community plugins', async () => {
    const submitted = await server.request('POST', '/v1/marketplace/submissions', { token: outsider, body: { manifest: { ...customAi, id: 'org.community.summarizer', name: 'Summarizer' } } });
    assert.equal(get(submitted.body, '$.status'), 'pending_review');
    assert.equal((await server.request('POST', '/v1/admin/plugins/org.community.summarizer/versions/1.0.0/approve', { token: owner, body: {} })).status, 403);
    const approved = await server.request('POST', '/v1/admin/plugins/org.community.summarizer/versions/1.0.0/approve', { token: admin, body: { note: 'scanned' } });
    assert.equal(get(approved.body, '$.status'), 'active');
    const market = await server.request('GET', '/v1/marketplace?source=community', { token: viewer });
    assert.deepEqual((get(market.body, '$.plugins') as unknown[]).map((plugin) => get(plugin, '$.id')), ['org.community.summarizer']);
  });
});
