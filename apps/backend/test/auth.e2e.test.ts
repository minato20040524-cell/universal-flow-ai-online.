import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readJsonPath } from '@universal-flow/core-engine';
import { createPgWorkspaceRepository } from '../src/repositories/workspace-repository.js';
import { createControlledClock, createFakeHttp, json, startTestServer, type TestServer } from './support/fakes.js';

const START = Date.parse('2026-11-07T00:00:00Z');
const get = (value: unknown, path: string): unknown => readJsonPath(value, path);
const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));
const PASSWORD = 'correct horse battery';

describe('web sign-in, sessions and the web app', () => {
  const clock = createControlledClock(START);
  let server: TestServer;
  let webDir = '';
  let cookie = '';
  let csrf = '';

  const withSession = (extra: Record<string, string> = {}) => ({ cookie, ...extra });

  before(async () => {
    webDir = await mkdtemp(join(tmpdir(), 'uf-web-'));
    await mkdir(join(webDir, 'assets'));
    await writeFile(join(webDir, 'index.html'), '<!doctype html><title>UNIVERSAL FLOW AI</title><div id="root"></div>');
    await writeFile(join(webDir, 'assets', 'app-1a2b.js'), 'console.log("app")');
    await mkdir(join(webDir, 'icons'));
    await writeFile(join(webDir, 'icons', 'icon-192.png'), 'png');
    await writeFile(join(webDir, 'manifest.webmanifest'), '{"name":"UNIVERSAL FLOW AI"}');
    await writeFile(join(webDir, 'sw.js'), 'self.addEventListener("fetch", () => undefined)');
    server = await startTestServer({ outboundHttp: createFakeHttp(() => json(404, {})).http, officialPlugins: [], clock, webDistDir: webDir });
  });

  after(async () => {
    await server.close();
  });

  it('signs up into a new workspace with a hardened session cookie', async () => {
    assert.deepEqual((await server.request('GET', '/v1/auth/session')).body, { authenticated: false, signup: 'first' });
    const weak = await server.request('POST', '/v1/auth/signup', { body: { email: 'hinata@example.com', name: 'Hinata', password: 'short', workspaceName: 'Studio' } });
    assert.equal(weak.status, 400);
    assert.equal(get(weak.body, '$.error.issues[0].path'), 'password');

    const signup = await server.request('POST', '/v1/auth/signup', { body: { email: 'Hinata@Example.com', name: 'Hinata', password: PASSWORD, workspaceName: 'Studio' } });
    assert.equal(signup.status, 201, signup.text);
    const setCookie = signup.headers.getSetCookie().join('\n');
    assert.match(setCookie, /^uf_session=ufs_[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    assert.ok(!signup.text.includes('ufs_'), 'the session token never appears in the body');
    cookie = setCookie.split(';')[0] ?? '';
    csrf = text(get(signup.body, '$.csrfToken'));
    assert.equal(get(signup.body, '$.user.email'), 'hinata@example.com');
    assert.equal(get(signup.body, '$.role'), 'owner');
    assert.equal(get(signup.body, '$.user.isPlatformAdmin'), true, 'the first account administers the platform');
    assert.deepEqual((await server.request('GET', '/v1/auth/session')).body, { authenticated: false, signup: 'open' });

    const again = await server.request('POST', '/v1/auth/signup', { body: { email: 'hinata@example.com', name: 'X', password: PASSWORD, workspaceName: 'Y' } });
    assert.equal(again.status, 409);
  });

  it('uses the cookie for reads and demands the CSRF header for changes', async () => {
    assert.equal((await server.request('GET', '/v1/integrations', { headers: withSession() })).status, 200);
    const noCsrf = await server.request('POST', '/v1/auth/workspaces', { headers: withSession(), body: { name: 'Second' } });
    assert.equal(noCsrf.status, 403);
    assert.equal(get(noCsrf.body, '$.error.code'), 'CSRF_FAILED');
    const evilOrigin = await server.request('POST', '/v1/auth/workspaces', { headers: withSession({ 'x-csrf-token': csrf, origin: 'https://evil.example' }), body: { name: 'Second' } });
    assert.equal(get(evilOrigin.body, '$.error.code'), 'FORBIDDEN_ORIGIN');

    const created = await server.request('POST', '/v1/auth/workspaces', {
      headers: withSession({ 'x-csrf-token': csrf, origin: 'https://api.universalflow.test' }),
      body: { name: 'Second' },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(get(created.body, '$.workspace.name'), 'Second');
    assert.equal((get(created.body, '$.workspaces') as unknown[]).length, 2);

    const firstId = text(get(created.body, '$.workspaces[0].id'));
    const switched = await server.request('POST', '/v1/auth/workspace', { headers: withSession({ 'x-csrf-token': csrf }), body: { workspaceId: firstId } });
    assert.equal(get(switched.body, '$.workspace.name'), 'Studio');
    const foreign = await server.request('POST', '/v1/auth/workspace', { headers: withSession({ 'x-csrf-token': csrf }), body: { workspaceId: 'ws_not_mine' } });
    assert.equal(foreign.status, 404);
  });

  it('keeps API tokens working and out of user-only actions', async () => {
    const workspaces = createPgWorkspaceRepository(server.db);
    const workspace = await workspaces.createWorkspace('Machines', START);
    const { token } = await workspaces.createToken({ workspaceId: workspace.id, name: 'ci', role: 'owner', now: START });
    assert.equal((await server.request('GET', '/v1/integrations', { token })).status, 200);
    assert.equal((await server.request('POST', '/v1/auth/logout', { token, body: {} })).status, 403);
  });

  it('logs out and ends the session', async () => {
    const out = await server.request('POST', '/v1/auth/logout', { headers: withSession({ 'x-csrf-token': csrf }), body: {} });
    assert.equal(out.status, 204);
    assert.match(out.headers.getSetCookie().join(''), /uf_session=; .*Max-Age=0/);
    assert.equal((await server.request('GET', '/v1/integrations', { headers: withSession() })).status, 401);
  });

  it('signs in, gives one answer for every failure and locks after five', async () => {
    const unknown = await server.request('POST', '/v1/auth/login', { body: { email: 'nobody@example.com', password: PASSWORD } });
    const wrong = await server.request('POST', '/v1/auth/login', { body: { email: 'hinata@example.com', password: 'wrong password!' } });
    assert.equal(unknown.status, 401);
    assert.equal(get(unknown.body, '$.error.message'), get(wrong.body, '$.error.message'));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await server.request('POST', '/v1/auth/login', { body: { email: 'hinata@example.com', password: 'wrong password!' } });
    }
    const locked = await server.request('POST', '/v1/auth/login', { body: { email: 'hinata@example.com', password: PASSWORD } });
    assert.equal(locked.status, 429, 'even the right password waits out the lock');
    assert.ok(Number(locked.headers.get('retry-after')) > 0);

    clock.advance(16 * 60_000);
    const ok = await server.request('POST', '/v1/auth/login', { body: { email: 'HINATA@example.com', password: PASSWORD } });
    assert.equal(ok.status, 200, ok.text);
    const fresh = ok.headers.getSetCookie()[0]?.split(';')[0] ?? '';
    const session = await server.request('GET', '/v1/auth/session', { headers: { cookie: fresh } });
    assert.equal(get(session.body, '$.authenticated'), true);
    assert.equal(get(session.body, '$.user.name'), 'Hinata');
  });

  it('serves the web app with a strict content security policy', async () => {
    const home = await server.request('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type') ?? '', /text\/html/);
    assert.match(home.headers.get('content-security-policy') ?? '', /script-src 'self'.*frame-ancestors 'none'/);
    assert.equal(home.headers.get('cache-control'), 'no-cache');
    assert.match((await server.request('GET', '/integrations/com.example.x')).text, /UNIVERSAL FLOW AI/, 'client-side routes get index.html');
    const asset = await server.request('GET', '/assets/app-1a2b.js');
    assert.equal(asset.text, 'console.log("app")');
    assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
    assert.equal((await server.request('GET', '/assets/missing.js')).status, 404);
    const traversal = await server.request('GET', '/assets/%2e%2e/%2e%2e/etc/passwd');
    assert.match(traversal.text, /UNIVERSAL FLOW AI/, 'dot segments resolve inside the site; files outside it are never read');
    assert.ok(!traversal.text.includes('root:'));
    const api404 = await server.request('GET', '/v1/nothing-here');
    assert.equal(api404.status, 404);
    assert.match(api404.headers.get('content-type') ?? '', /application\/json/);
  });

  it('serves what an installed app needs: manifest, service worker and icons', async () => {
    const manifest = await server.request('GET', '/manifest.webmanifest');
    assert.match(manifest.headers.get('content-type') ?? '', /application\/manifest\+json/);
    const worker = await server.request('GET', '/sw.js');
    assert.match(worker.headers.get('content-type') ?? '', /text\/javascript/);
    assert.equal(worker.headers.get('cache-control'), 'no-cache', 'an updated worker reaches installed apps at once');
    assert.match(worker.headers.get('content-security-policy') ?? '', /worker-src 'self'/);
    const icon = await server.request('GET', '/icons/icon-192.png');
    assert.match(icon.headers.get('content-type') ?? '', /image\/png/);
    assert.equal((await server.request('GET', '/icons/missing.png')).status, 404);
  });
});

describe('sign-up on a public server', () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer({ outboundHttp: createFakeHttp(() => json(404, {})).http, officialPlugins: [], clock: createControlledClock(START), allowSignup: false });
  });

  after(async () => {
    await server.close();
  });

  it('lets only the first account in, as administrator, then closes', async () => {
    assert.deepEqual((await server.request('GET', '/v1/auth/session')).body, { authenticated: false, signup: 'first' });
    const owner = await server.request('POST', '/v1/auth/signup', { body: { email: 'owner@example.com', name: 'Owner', password: PASSWORD, workspaceName: 'Studio' } });
    assert.equal(owner.status, 201, owner.text);
    assert.equal(get(owner.body, '$.user.isPlatformAdmin'), true);
    assert.deepEqual((await server.request('GET', '/v1/auth/session')).body, { authenticated: false, signup: 'closed' });
    const stranger = await server.request('POST', '/v1/auth/signup', { body: { email: 'stranger@example.com', name: 'S', password: PASSWORD, workspaceName: 'X' } });
    assert.equal(stranger.status, 403);
    assert.equal(get(stranger.body, '$.error.code'), 'SIGNUP_CLOSED');
  });
});
