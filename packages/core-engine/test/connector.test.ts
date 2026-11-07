import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConnectorError, REDACTED, createApiConnector, parseManifest, type OAuthRefresher } from '../src/index.js';
import { WORKSPACE, createFakeClock, createFakeHttp, createSecrets, customAiManifest, expectCode, json } from './helpers.js';

const TOKEN = 'sk-live-SECRET123';

const setup = async (respond: Parameters<typeof createFakeHttp>[0], manifestOverrides: Record<string, unknown> = {}) => {
  const fake = createFakeClock();
  const secrets = createSecrets(fake.clock);
  const { http, requests } = createFakeHttp(respond);
  const manifest = parseManifest(customAiManifest(manifestOverrides));
  const values: Record<string, string> =
    manifest.auth.type === 'api_key' ? { apiKey: TOKEN } : manifest.auth.type === 'basic' ? { username: 'u', password: TOKEN } : { token: TOKEN };
  const credential = await secrets.put({ workspaceId: WORKSPACE, pluginId: manifest.id, authType: manifest.auth.type, values });
  const connector = createApiConnector({ http, secrets, clock: fake.clock });
  const call = (input: Record<string, unknown>) => ({ manifest, actionKey: 'generate', input, workspaceId: WORKSPACE, credentialId: credential.id });
  return { connector, requests, call, secrets, credential, fake, manifest };
};

const okResponse = () => json(200, { choices: [{ text: 'Halo dunia' }], usage: { total: 5 } });

describe('Universal API Connector', () => {
  it('builds the request from the manifest and maps the response', async () => {
    const { connector, requests, call } = await setup(okResponse);
    const result = await connector.execute(call({ prompt: 'Sapa', model: 'large', lang: 'id' }));
    assert.deepEqual(result.output, { text: 'Halo dunia', tokens: 5 });
    assert.deepEqual(result.warnings, []);
    const request = requests[0];
    assert.ok(request);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, 'https://api.example.com/v1/models/large/generate?lang=id');
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body ?? '{}'), { prompt: 'Sapa' });
  });

  it('validates input before any request is sent', async () => {
    const { connector, requests, call } = await setup(okResponse);
    await assert.rejects(connector.execute(call({ model: 'huge' })), expectCode('VALIDATION'));
    assert.equal(requests.length, 0);
  });

  it('marks server errors retryable, client errors not, and redacts echoed secrets', async () => {
    const statuses = [503, 400];
    const { connector, call } = await setup(() => json(statuses.shift() ?? 500, { error: `invalid token ${TOKEN}` }));
    await assert.rejects(connector.execute(call({ prompt: 'x', model: 'small' })), (error: unknown) => error instanceof ConnectorError && error.retryable && error.status === 503);
    await assert.rejects(connector.execute(call({ prompt: 'x', model: 'small' })), (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.retryable, false);
      assert.deepEqual(error.responseBody, { error: `invalid token ${REDACTED}` });
      return true;
    });
  });

  it('does not follow redirects', async () => {
    const { connector, call } = await setup(() => ({ status: 302, headers: { location: 'https://evil.com' }, body: '' }));
    await assert.rejects(connector.execute(call({ prompt: 'x', model: 'small' })), /redirects are not followed/);
  });

  it('supports API keys in the query string', async () => {
    const { connector, requests, call } = await setup(okResponse, { auth: { type: 'api_key', in: 'query', name: 'key' } });
    await connector.execute(call({ prompt: 'x', model: 'small' }));
    assert.equal(new URL(requests[0]?.url ?? '').searchParams.get('key'), TOKEN);
  });

  it('requires a credential when the plugin needs auth', async () => {
    const { connector, call } = await setup(okResponse);
    await assert.rejects(connector.execute({ ...call({ prompt: 'x', model: 'small' }), credentialId: undefined }), /Missing credential/);
  });

  it('never sends a credential to a plugin it was not connected for', async () => {
    const { connector, requests, call, secrets } = await setup(okResponse);
    const foreign = await secrets.put({ workspaceId: WORKSPACE, pluginId: 'io.universalflow.gdrive', authType: 'bearer', values: { token: 'drive-token' } });
    await assert.rejects(connector.execute({ ...call({ prompt: 'x', model: 'small' }), credentialId: foreign.id }), expectCode('PERMISSION'));
    assert.equal(requests.length, 0);
  });

  it('Test API returns a redacted report', async () => {
    const { connector, call } = await setup(() => json(200, { choices: [{ text: `echo ${TOKEN}` }], usage: { total: 3 } }));
    const report = await connector.test(call({ prompt: 'x', model: 'small' }));
    assert.equal(report.ok, true);
    assert.equal(report.status, 200);
    assert.equal(report.request?.headers.authorization, REDACTED);
    assert.deepEqual(report.output, { text: `echo ${REDACTED}`, tokens: 3 });
    assert.ok(!JSON.stringify(report).includes(TOKEN));
  });

  it('Test API fails when the mapping does not match the output schema', async () => {
    const { connector, call } = await setup(() => json(200, { choices: [{ text: 'ok' }], usage: { total: 'five' } }));
    const report = await connector.test(call({ prompt: 'x', model: 'small' }));
    assert.equal(report.ok, false);
    assert.equal(report.warnings[0]?.path, '$.output.tokens');
  });

  it('Test API reports failures instead of throwing', async () => {
    const { connector, call } = await setup(() => json(401, { error: 'unauthorized' }));
    const report = await connector.test(call({ prompt: 'x', model: 'small' }));
    assert.equal(report.ok, false);
    assert.equal(report.status, 401);
    assert.equal(report.error?.code, 'CONNECTOR');
  });

  it('refreshes an expiring OAuth token on the backend', async () => {
    const fake = createFakeClock();
    const secrets = createSecrets(fake.clock);
    const { http, requests } = createFakeHttp(okResponse);
    const manifest = parseManifest(
      customAiManifest({
        auth: { type: 'oauth2', authorizationUrl: 'https://auth.example.com/authorize', tokenUrl: 'https://auth.example.com/token', scopes: ['write'] },
        permissions: ['network:api.example.com', 'network:auth.example.com'],
      }),
    );
    const credential = await secrets.put({
      workspaceId: WORKSPACE,
      pluginId: manifest.id,
      authType: 'oauth2',
      values: { accessToken: 'old-access', refreshToken: 'refresh-1' },
      expiresAt: fake.clock.now() + 10_000,
    });
    const refreshCalls: string[] = [];
    const refreshOAuth: OAuthRefresher = async (request) => {
      refreshCalls.push(request.refreshToken);
      return { accessToken: 'new-access', refreshToken: 'refresh-2', expiresInSeconds: 3600, scope: undefined };
    };
    const connector = createApiConnector({ http, secrets, clock: fake.clock, refreshOAuth });
    await connector.execute({ manifest, actionKey: 'generate', input: { prompt: 'x', model: 'small' }, workspaceId: WORKSPACE, credentialId: credential.id });
    assert.deepEqual(refreshCalls, ['refresh-1']);
    assert.equal(requests[0]?.headers.authorization, 'Bearer new-access');
    assert.deepEqual(await secrets.reveal(credential.id, WORKSPACE), { accessToken: 'new-access', refreshToken: 'refresh-2' });
    assert.equal((await secrets.info(credential.id))?.expiresAt, fake.clock.now() + 3_600_000);
  });
});
