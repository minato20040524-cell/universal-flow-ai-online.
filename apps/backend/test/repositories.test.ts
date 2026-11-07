import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  ENGINE_VERSION,
  createCategoryRegistry,
  createLocalKeyProvider,
  createPluginRegistry,
  createSecretStore,
  createWorkflowEngine,
  type Workflow,
} from '@universal-flow/core-engine';
import { migrate } from '../src/db/migrate.js';
import { ConcurrentModificationError } from '../src/db/sql.js';
import { createPgJobQueue } from '../src/queue/job-queue.js';
import { createPgExecutionStore } from '../src/repositories/execution-store.js';
import { createPgCategoryStore, createPgPluginStore } from '../src/repositories/registry-stores.js';
import { createPgSecretRepository } from '../src/repositories/secret-repository.js';
import { createPgTriggerRepository } from '../src/repositories/trigger-repository.js';
import { createPgWorkflowRepository } from '../src/repositories/workflow-repository.js';
import { createPgWorkspaceRepository } from '../src/repositories/workspace-repository.js';
import { createTestDatabase, type TestDatabase } from './support/psql-client.js';

const START = Date.parse('2026-11-07T00:00:00Z');
const createClock = () => {
  const state = { now: START };
  return { now: () => state.now, sleep: async (ms: number) => void (state.now += ms), advance: (ms: number) => void (state.now += ms) };
};

const customManifest = (version = '1.0.0', permissions = ['network:api.example.com']) => ({
  id: 'com.example.my-custom-ai',
  name: 'MY CUSTOM AI',
  version,
  engine: '^1.0.0',
  provider: 'Example Inc.',
  category: 'ai-llm',
  auth: { type: 'bearer' },
  baseUrl: 'https://api.example.com/v1',
  permissions,
  actions: [{ key: 'generate', name: 'Generate', request: { method: 'POST', path: '/generate', body: { prompt: '{{input.prompt}}' } } }],
});

describe('PostgreSQL repositories', () => {
  let db: TestDatabase;
  let workspaceId = '';
  let otherWorkspaceId = '';

  before(async () => {
    db = await createTestDatabase();
    assert.deepEqual(await migrate(db), ['001_initial.sql', '002_users_sessions.sql']);
    assert.deepEqual(await migrate(db), [], 'migrations run once');
    const workspaces = createPgWorkspaceRepository(db);
    workspaceId = (await workspaces.createWorkspace('Main', START)).id;
    otherWorkspaceId = (await workspaces.createWorkspace('Other', START)).id;
  });

  after(async () => {
    await db.drop();
  });

  it('seeds categories and runs the plugin registry on SQL storage', async () => {
    const categories = createCategoryRegistry({ store: createPgCategoryStore(db) });
    await categories.ensureDefaults();
    await categories.ensureDefaults();
    assert.equal((await categories.list()).length, 30);

    const clock = createClock();
    const registry = createPluginRegistry({ categories, engineVersion: ENGINE_VERSION, store: createPgPluginStore(db), clock });
    const record = await registry.register(customManifest(), { source: 'custom', ownerWorkspaceId: workspaceId });
    assert.equal(record.status, 'testing');
    assert.equal((await registry.getInstallation(workspaceId, record.manifest.id))?.version, '1.0.0');
    await registry.markTested(record.manifest.id, '1.0.0');
    assert.equal((await registry.resolveForExecution(workspaceId, 'com.example.my-custom-ai@1.0.0')).baseUrl, 'https://api.example.com/v1');
    assert.equal((await registry.search({ workspaceId: otherWorkspaceId })).length, 0);

    await registry.register(customManifest('1.1.0', ['network:api.example.com', 'network:cdn.example.com']), { source: 'custom', ownerWorkspaceId: workspaceId });
    await registry.markTested(record.manifest.id, '1.1.0');
    const preview = await registry.previewUpdate(workspaceId, record.manifest.id);
    assert.deepEqual(preview.permissions.added, ['network:cdn.example.com']);
    await registry.update(workspaceId, record.manifest.id, { grantPermissions: ['network:cdn.example.com'] });
    assert.deepEqual((await registry.getInstallation(workspaceId, record.manifest.id))?.grantedPermissions, ['network:api.example.com', 'network:cdn.example.com']);
    await assert.rejects(registry.install(workspaceId, record.manifest.id, { grantPermissions: [] }), /already installed/);
  });

  it('keeps credentials encrypted at rest', async () => {
    const secrets = createSecretStore({ keyProvider: createLocalKeyProvider(randomBytes(32)), repository: createPgSecretRepository(db) });
    const info = await secrets.put({ workspaceId, pluginId: 'p', authType: 'bearer', values: { token: "sk-'quoted'\\back\nline" } });
    const [row] = await db.query('SELECT ciphertext, field_names FROM credentials WHERE id = $1', [info.id]);
    assert.ok(row && !JSON.stringify(row).includes('quoted'));
    assert.deepEqual(await secrets.reveal(info.id, workspaceId), { token: "sk-'quoted'\\back\nline" });
    await secrets.replace(info.id, { token: 'rotated' }, START + 1000);
    assert.deepEqual(await secrets.reveal(info.id, workspaceId), { token: 'rotated' });
    assert.equal((await secrets.info(info.id))?.expiresAt, START + 1000);
  });

  it('versions workflows and refuses stale saves', async () => {
    const workflows = createPgWorkflowRepository(db);
    const graph = {
      nodes: [
        { id: 'start', kind: 'trigger' as const, trigger: 'manual' as const },
        { id: 'gen', kind: 'action' as const, plugin: 'com.example.my-custom-ai@1.0.0', action: 'generate', input: {} },
      ],
      edges: [{ id: 'e1', from: 'start', to: 'gen' }],
    };
    const created = await workflows.create({ id: 'wf_repo', workspaceId, name: 'Repo test', graph, settings: {}, pluginIds: ['com.example.my-custom-ai'], now: START });
    assert.equal(created.currentVersion, 1);
    const saved = await workflows.addVersion({ id: 'wf_repo', workspaceId, expectedVersion: 1, name: 'Renamed', graph, settings: { concurrency: 2 }, pluginIds: ['com.example.my-custom-ai'], now: START });
    assert.equal(saved.currentVersion, 2);
    await assert.rejects(
      workflows.addVersion({ id: 'wf_repo', workspaceId, expectedVersion: 1, name: 'Stale', graph, settings: {}, pluginIds: [], now: START }),
      /changed by someone else/,
    );
    assert.equal(await workflows.isPluginUsedByActiveWorkflow(workspaceId, 'com.example.my-custom-ai'), false);
    await workflows.setActive(workspaceId, 'wf_repo', 2, START);
    assert.equal(await workflows.isPluginUsedByActiveWorkflow(workspaceId, 'com.example.my-custom-ai'), true);
    assert.deepEqual((await workflows.loadForExecution('wf_repo', 2))?.settings, { concurrency: 2 });
    assert.equal(await workflows.get(otherWorkspaceId, 'wf_repo'), undefined);
  });

  it('runs the engine on SQL execution storage and detects concurrent writers', async () => {
    const workflows = createPgWorkflowRepository(db);
    const graph = {
      nodes: [
        { id: 'start', kind: 'trigger' as const, trigger: 'manual' as const },
        { id: 'ok', kind: 'approval' as const, message: 'go?' },
        { id: 'done', kind: 'transform' as const, output: { said: '{{trigger.text}}' } },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'ok' },
        { id: 'e2', from: 'ok', to: 'done', port: 'approved' },
      ],
    };
    await workflows.create({ id: 'wf_exec', workspaceId, name: 'Exec', graph, settings: {}, pluginIds: [], now: START });
    const workflow: Workflow = { id: 'wf_exec', workspaceId, name: 'Exec', version: 1, graph };
    const store = createPgExecutionStore(db);
    const engine = createWorkflowEngine({ runAction: async () => ({}), store, clock: createClock() });

    const waiting = await engine.start(workflow, { payload: { text: "it's \"quoted\"" } });
    assert.equal(waiting.status, 'waiting');
    const done = await engine.resolveApproval(workflow, waiting.id, 'ok', { approved: true, by: 'tester' });
    assert.equal(done.status, 'succeeded');
    assert.deepEqual(done.nodes.done?.output, { said: "it's \"quoted\"" });
    assert.deepEqual((await store.steps(waiting.id)).map((step) => step.nodeId), ['start', 'ok', 'ok', 'done']);

    const second = await engine.start(workflow);
    const writerA = createPgExecutionStore(db);
    const writerB = createPgExecutionStore(db);
    const copyA = await writerA.get(second.id);
    const copyB = await writerB.get(second.id);
    assert.ok(copyA && copyB);
    await writerB.save({ ...copyB, status: 'cancelled' });
    await assert.rejects(writerA.save({ ...copyA, status: 'failed' }), ConcurrentModificationError);
  });

  it('queues jobs with dedupe, exclusive claims, concurrency keys and leases', async () => {
    const clock = createClock();
    const queue = createPgJobQueue(db, clock.now);
    const first = await queue.enqueue({ type: 'demo', payload: { n: 1 }, dedupeKey: 'once' });
    const again = await queue.enqueue({ type: 'demo', payload: { n: 2 }, dedupeKey: 'once' });
    assert.equal(again.created, false);
    assert.equal(again.job.id, first.job.id);
    await queue.enqueue({ type: 'demo', payload: { n: 3 }, concurrencyKey: 'exec_1' });
    await queue.enqueue({ type: 'demo', payload: { n: 4 }, concurrencyKey: 'exec_1' });
    await queue.enqueue({ type: 'demo', payload: { n: 5 }, runAt: START + 60_000 });

    const [claimA, claimB] = await Promise.all([queue.claim('worker-a', { limit: 10, leaseMs: 30_000 }), queue.claim('worker-b', { limit: 10, leaseMs: 30_000 })]);
    const claimedIds = [...claimA, ...claimB].map((job) => job.id);
    assert.equal(new Set(claimedIds).size, claimedIds.length, 'no job is claimed twice');
    assert.equal(claimedIds.length, 2, 'the deduped job and one job of exec_1; the delayed one is not due');

    const keyed = [...claimA, ...claimB].find((job) => job.concurrencyKey === 'exec_1');
    assert.ok(keyed);
    assert.equal((await queue.claim('worker-c', { limit: 10, leaseMs: 30_000 })).length, 0, 'second exec_1 job waits');
    const owner = claimA.some((job) => job.id === keyed.id) ? 'worker-a' : 'worker-b';
    await queue.complete(keyed.id, owner);
    const [next] = await queue.claim('worker-c', { limit: 10, leaseMs: 30_000 });
    assert.deepEqual(next?.payload, { n: 4 });
    assert.ok(next);

    await queue.fail(next.id, 'worker-c', 'boom', START + 5_000);
    assert.equal((await queue.get(next.id))?.status, 'queued');
    clock.advance(61_000);
    const reclaimed = await queue.claim('worker-d', { limit: 10, leaseMs: 1_000 });
    const payloads = reclaimed.map((job) => JSON.stringify(job.payload)).sort();
    // n:1 was claimed at the start with a 30 s lease that has now expired; n:4 is due for retry; n:5 is now due.
    assert.deepEqual(payloads, ['{"n":1}', '{"n":4}', '{"n":5}']);
    const dedupedOwner = claimA.some((job) => job.id === first.job.id) ? 'worker-a' : 'worker-b';
    await queue.complete(first.job.id, dedupedOwner);
    assert.equal((await queue.get(first.job.id))?.status, 'running', 'the old owner lost its lease and cannot complete the job');
    await queue.fail(first.job.id, 'worker-d', 'fatal', undefined);
    assert.equal((await queue.get(first.job.id))?.status, 'dead');
    assert.deepEqual(await queue.counts(), { queued: 0, running: 2, succeeded: 1, dead: 1 });
  });

  it('claims due schedules once and consumes OAuth states once', async () => {
    const triggers = createPgTriggerRepository(db);
    const schedule = { workflowId: 'wf_repo', triggerNodeId: 'start', workspaceId, workflowVersion: 2, cron: '*/5 * * * *', timezone: 'UTC', nextRunAt: START };
    await triggers.replaceSchedules('wf_repo', [schedule]);
    await triggers.replaceSchedules('wf_repo', [{ ...schedule, cron: '0 * * * *' }]);
    assert.deepEqual((await triggers.listSchedules('wf_repo')).map((item) => item.cron), ['0 * * * *']);

    const [claimA, claimB] = await Promise.all([triggers.claimDueSchedules(START, 30_000, 10), triggers.claimDueSchedules(START, 30_000, 10)]);
    assert.equal(claimA.length + claimB.length, 1);
    const claimed = claimA.at(0) ?? claimB.at(0);
    assert.ok(claimed);
    assert.equal(await triggers.advanceSchedule(claimed, START + 3_600_000), true);
    assert.equal(await triggers.advanceSchedule(claimed, START + 3_600_000), false, 'a second scheduler cannot advance it again');
    await triggers.replaceSchedules('wf_repo', []);
    assert.deepEqual(await triggers.listSchedules('wf_repo'), []);

    const secrets = createSecretStore({ keyProvider: createLocalKeyProvider(randomBytes(32)), repository: createPgSecretRepository(db) });
    const credential = await secrets.put({ workspaceId, pluginId: 'p', authType: 'oauth2', values: { clientId: 'c' } });
    await triggers.insertOAuthState({ state: 'st-1', workspaceId, pluginId: 'p', pluginVersion: '1.0.0', credentialId: credential.id, redirectUri: 'https://app/cb', expiresAt: START + 600_000 }, START);
    assert.equal((await triggers.consumeOAuthState('st-1', START))?.credentialId, credential.id);
    assert.equal(await triggers.consumeOAuthState('st-1', START), undefined);
  });
});
