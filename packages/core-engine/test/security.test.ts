import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  REDACTED,
  assertSafeUrl,
  createFetchHttpClient,
  createInMemorySecretRepository,
  createLocalKeyProvider,
  createSecretStore,
  createWebhookSecret,
  redactValue,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../src/index.js';
import { OTHER_WORKSPACE, WORKSPACE, createFakeClock, expectCode } from './helpers.js';

describe('secret store', () => {
  const setup = () => {
    const repository = createInMemorySecretRepository();
    const fake = createFakeClock();
    const store = createSecretStore({ keyProvider: createLocalKeyProvider(randomBytes(32)), repository, clock: fake.clock });
    return { repository, store, fake };
  };

  it('stores only ciphertext and returns values to the owning workspace', async () => {
    const { repository, store } = setup();
    const info = await store.put({ workspaceId: WORKSPACE, pluginId: 'p', authType: 'bearer', values: { token: 'sk-live-TOPSECRET' } });
    assert.deepEqual(info.fieldNames, ['token']);
    assert.ok(!JSON.stringify(info).includes('TOPSECRET'));
    const raw = await repository.find(info.id);
    assert.ok(raw && !JSON.stringify(raw).includes('TOPSECRET'));
    assert.deepEqual(await store.reveal(info.id, WORKSPACE), { token: 'sk-live-TOPSECRET' });
    await assert.rejects(store.reveal(info.id, OTHER_WORKSPACE), expectCode('PERMISSION'));
  });

  it('detects tampering and rows moved to another owner', async () => {
    const { repository, store } = setup();
    const info = await store.put({ workspaceId: WORKSPACE, pluginId: 'p', authType: 'bearer', values: { token: 'abcdef' } });
    const raw = await repository.find(info.id);
    assert.ok(raw);
    const flipped = Buffer.from(raw.ciphertext, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    await repository.save({ ...raw, ciphertext: flipped.toString('base64') });
    await assert.rejects(store.reveal(info.id, WORKSPACE), expectCode('SECURITY'));
    await repository.save({ ...raw, workspaceId: OTHER_WORKSPACE });
    await assert.rejects(store.reveal(info.id, OTHER_WORKSPACE), expectCode('SECURITY'));
  });

  it('reports expiry and errors as connection status', async () => {
    const { store, fake } = setup();
    const info = await store.put({ workspaceId: WORKSPACE, pluginId: 'p', authType: 'oauth2', values: { accessToken: 'a1' }, expiresAt: fake.clock.now() + 1000 });
    assert.equal(info.status, 'connected');
    fake.advance(2000);
    assert.equal((await store.info(info.id))?.status, 'expired');
    await store.markError(info.id);
    assert.equal((await store.info(info.id))?.status, 'error');
  });
});

describe('redaction', () => {
  it('hides sensitive keys and known secret strings anywhere', () => {
    const result = redactValue(
      { headers: { Authorization: 'Bearer x', accept: 'json' }, body: { echo: 'your key is sk-123456' }, list: ['sk-123456'], maxTokens: 5 },
      ['sk-123456'],
    );
    assert.deepEqual(result, {
      headers: { Authorization: REDACTED, accept: 'json' },
      body: { echo: `your key is ${REDACTED}` },
      list: [REDACTED],
      maxTokens: 5,
    });
  });
});

describe('url guard', () => {
  const permissions = ['network:api.example.com', 'network:*.cdn.example.com'];

  it('allows declared https hosts only', () => {
    assert.doesNotThrow(() => assertSafeUrl(new URL('https://api.example.com/v1'), permissions));
    assert.doesNotThrow(() => assertSafeUrl(new URL('https://eu.cdn.example.com/a'), permissions));
    assert.throws(() => assertSafeUrl(new URL('https://evil.com/'), permissions), expectCode('PERMISSION'));
    assert.throws(() => assertSafeUrl(new URL('http://api.example.com/'), permissions), expectCode('SECURITY'));
    assert.throws(() => assertSafeUrl(new URL('https://user:pass@api.example.com/'), permissions), expectCode('SECURITY'));
  });

  it('blocks private, loopback, metadata and internal addresses', () => {
    for (const url of ['https://10.0.0.5', 'https://169.254.169.254/latest', 'https://localhost:3000', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://metadata.google.internal/', 'https://192.168.1.1']) {
      assert.throws(() => assertSafeUrl(new URL(url), ['network:*.internal']), expectCode('SECURITY'), url);
    }
  });

  it('refuses hosts whose DNS points to a private address', async () => {
    const client = createFetchHttpClient({ resolveHost: async () => ['10.1.2.3'] });
    await assert.rejects(
      client.send({ method: 'GET', url: 'https://sneaky.example.com/', headers: {}, body: undefined, timeoutMs: 1000, maxResponseBytes: 1000 }),
      expectCode('SECURITY'),
    );
  });
});

describe('webhook signatures', () => {
  it('accepts fresh, untampered requests only', () => {
    const secret = createWebhookSecret();
    const now = 1_700_000_000_000;
    const body = JSON.stringify({ message: { text: 'Halo' } });
    const signature = signWebhookPayload(secret, now, body);
    assert.ok(verifyWebhookSignature({ secret, body, timestampMs: now, signature, nowMs: now + 1000 }));
    assert.ok(!verifyWebhookSignature({ secret, body: `${body} `, timestampMs: now, signature, nowMs: now }));
    assert.ok(!verifyWebhookSignature({ secret, body, timestampMs: now, signature, nowMs: now + 10 * 60_000 }));
    assert.ok(!verifyWebhookSignature({ secret: createWebhookSecret(), body, timestampMs: now, signature, nowMs: now }));
  });
});
