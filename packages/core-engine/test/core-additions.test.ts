import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  createAuthorizationRequest,
  createInMemoryExecutionStore,
  createWorkflowEngine,
  exchangeAuthorizationCode,
  nextCronRun,
  parseCron,
  parseWorkflowGraph,
  pendingResumes,
  validateGraph,
  type Workflow,
} from '../src/index.js';
import { WORKSPACE, createFakeClock, createFakeHttp, expectCode, json } from './helpers.js';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe('cron', () => {
  it('finds the next matching minute', () => {
    assert.equal(iso(nextCronRun('*/15 * * * *', at('2026-11-06T10:07:30Z'))), '2026-11-06T10:15:00.000Z');
    assert.equal(iso(nextCronRun('*/15 * * * *', at('2026-11-06T10:15:00Z'))), '2026-11-06T10:30:00.000Z');
    assert.equal(iso(nextCronRun('30 2 1 * *', at('2026-11-06T10:00:00Z'))), '2026-12-01T02:30:00.000Z');
  });

  it('evaluates in the workflow time zone', () => {
    // Saturday 01:54 in Makassar (UTC+8) → the next weekday 09:00 is Monday.
    assert.equal(iso(nextCronRun('0 9 * * mon-fri', at('2026-11-06T17:54:00Z'), 'Asia/Makassar')), '2026-11-09T01:00:00.000Z');
    assert.equal(iso(nextCronRun('0 9 * * *', at('2026-11-06T17:54:00Z'), 'America/New_York')), '2026-11-07T14:00:00.000Z');
  });

  it('matches either day field when both are restricted', () => {
    // 2026-11-13 is a Friday; Friday 2026-11-06 has passed, so the 13th wins either way.
    assert.equal(iso(nextCronRun('0 0 13 * fri', at('2026-11-06T12:00:00Z'))), '2026-11-13T00:00:00.000Z');
    assert.equal(iso(nextCronRun('0 0 1 * sun', at('2026-11-06T12:00:00Z'))), '2026-11-08T00:00:00.000Z');
  });

  it('rejects invalid expressions', () => {
    assert.throws(() => parseCron('61 * * * *'), /minute value "61"/);
    assert.throws(() => parseCron('* * *'), /5 fields/);
    assert.throws(() => parseCron('5-1 * * * *'), /reversed/);
    assert.throws(() => nextCronRun('0 0 30 feb *', at('2026-01-01T00:00:00Z')), /never matches/);
    assert.throws(() => nextCronRun('* * * * *', 0, 'Mars/Olympus'), /IANA/);
    assert.ok(parseCron('0 0 * jan,dec 7').daysOfWeek.has(0));
  });
});

describe('workflow parsing', () => {
  it('reads untrusted JSON into a typed graph and drops unknown fields', () => {
    const graph = parseWorkflowGraph({
      nodes: [
        { id: 'start', kind: 'trigger', trigger: 'schedule', schedule: '0 9 * * *', timezone: 'Asia/Makassar', evil: '<script>' },
        { id: 'send', kind: 'action', plugin: 'a.b@1.0.0', action: 'go', input: { x: '{{trigger.x}}' }, retry: { maxAttempts: 3, backoffMs: 500 }, position: { x: 1, y: 2, z: 3 } },
      ],
      edges: [{ id: 'e1', from: 'start', to: 'send' }],
    });
    assert.deepEqual(graph.nodes[0], { id: 'start', kind: 'trigger', trigger: 'schedule', schedule: '0 9 * * *', timezone: 'Asia/Makassar' });
    assert.deepEqual(validateGraph(graph, { isBody: false }), []);
  });

  it('reports structural problems with paths', () => {
    assert.throws(
      () => parseWorkflowGraph({ nodes: [{ id: 'x', kind: 'teleport' }, { kind: 'action' }], edges: [{ from: 1 }] }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /\$\.graph\.nodes\[0\]\.kind/);
        assert.match(error.message, /\$\.graph\.nodes\[1\]\.id/);
        assert.match(error.message, /\$\.graph\.edges\[0\]\.from/);
        return true;
      },
    );
  });

  it('validates cron and time zone of schedule triggers', () => {
    const graph = parseWorkflowGraph({ nodes: [{ id: 's', kind: 'trigger', trigger: 'schedule', schedule: 'every day', timezone: 'Nowhere/City' }], edges: [] });
    const paths = validateGraph(graph, { isBody: false }).map((issue) => issue.path);
    assert.ok(paths.includes('$.graph.nodes[0].schedule'));
    assert.ok(paths.includes('$.graph.nodes[0].timezone'));
  });
});

describe('OAuth authorization code + PKCE', () => {
  it('builds the authorization URL and exchanges the code', async () => {
    const request = createAuthorizationRequest({
      authorizationUrl: 'https://auth.example.com/authorize?prompt=consent',
      clientId: 'client-1',
      redirectUri: 'https://app.example.com/oauth/callback',
      scopes: ['read', 'write'],
    });
    const url = new URL(request.url);
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.equal(url.searchParams.get('scope'), 'read write');
    assert.equal(url.searchParams.get('state'), request.state);
    assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(request.codeVerifier).digest('base64url'));

    const { http, requests } = createFakeHttp(() => json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }));
    const tokens = await exchangeAuthorizationCode(http, {
      tokenUrl: 'https://auth.example.com/token',
      code: 'code-123',
      redirectUri: 'https://app.example.com/oauth/callback',
      clientId: 'client-1',
      clientSecret: 'shh',
      codeVerifier: request.codeVerifier,
      permissions: ['network:auth.example.com'],
    });
    assert.deepEqual(tokens, { accessToken: 'at-1', refreshToken: 'rt-1', expiresInSeconds: 3600, scope: undefined });
    const form = new URLSearchParams(requests[0]?.body ?? '');
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('code_verifier'), request.codeVerifier);
  });
});

describe('engine resume helpers', () => {
  it('accepts a caller-chosen execution id and resumes one delay when due', async () => {
    const fake = createFakeClock();
    const engine = createWorkflowEngine({ runAction: async () => ({}), store: createInMemoryExecutionStore(), clock: fake.clock });
    const workflow: Workflow = {
      id: 'wf',
      workspaceId: WORKSPACE,
      name: 'wf',
      version: 1,
      graph: {
        nodes: [
          { id: 'start', kind: 'trigger', trigger: 'manual' },
          { id: 'wait', kind: 'delay', ms: 60_000 },
          { id: 'after', kind: 'transform', output: { ok: true } },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'wait' },
          { id: 'e2', from: 'wait', to: 'after' },
        ],
      },
    };
    const waiting = await engine.start(workflow, { executionId: 'exec_fixed' });
    assert.equal(waiting.id, 'exec_fixed');
    assert.deepEqual(pendingResumes(waiting), [{ nodeId: 'wait', resumeAt: fake.clock.now() + 60_000 }]);
    await assert.rejects(engine.start(workflow, { executionId: 'exec_fixed' }), expectCode('CONFLICT'));

    const early = await engine.resumeDelay(workflow, 'exec_fixed', 'wait');
    assert.equal(early.status, 'waiting');
    fake.advance(60_000);
    const finished = await engine.resumeDelay(workflow, 'exec_fixed', 'wait');
    assert.equal(finished.status, 'succeeded');
    assert.equal((await engine.resumeDelay(workflow, 'exec_fixed', 'wait')).status, 'succeeded');
  });
});
