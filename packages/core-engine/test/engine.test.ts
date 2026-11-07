import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConnectorError,
  ValidationError,
  createApiConnector,
  createInMemoryExecutionStore,
  createNativeHandlers,
  createPluginActionRunner,
  createWorkflowEngine,
  readJsonPath,
  systemClock,
  type Clock,
  type EngineEvent,
  type NativeHandler,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from '../src/index.js';
import { WORKSPACE, createFakeClock, createFakeHttp, createRegistry, createSecrets, expectCode, json, nativeManifest } from './helpers.js';

const setup = (clock: Clock = systemClock) => {
  const registry = createRegistry();
  const native = createNativeHandlers();
  const secrets = createSecrets(clock);
  const { http } = createFakeHttp(() => json(200, {}));
  const connector = createApiConnector({ http, secrets, clock });
  const store = createInMemoryExecutionStore();
  const events: EngineEvent[] = [];
  const engine = createWorkflowEngine({
    runAction: createPluginActionRunner({ registry, connector, secrets, native }),
    store,
    clock,
    onEvent: (event) => events.push(event),
  });
  const plugin = async (id: string, category: string, action: string, handler: NativeHandler, properties: Record<string, unknown> = {}) => {
    await registry.register(nativeManifest(id, category, action, properties), { source: 'official' });
    await registry.install(WORKSPACE, id, { grantPermissions: [] });
    native.register(id, action, handler);
    return `${id}@1.0.0`;
  };
  return { engine, store, events, registry, plugin };
};

const workflowOf = (nodes: WorkflowNode[], edges: [string, string, string?][], id = 'wf_test'): Workflow => ({
  id,
  workspaceId: WORKSPACE,
  name: id,
  version: 1,
  graph: {
    nodes,
    edges: edges.map(([from, to, port], index): WorkflowEdge => ({ id: `e${index}`, from, to, ...(port ? { port } : {}) })),
  },
});

const trigger: WorkflowNode = { id: 'start', kind: 'trigger', trigger: 'manual' };
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

describe('workflow engine: the specification example', () => {
  const build = async () => {
    const env = setup();
    const active = { now: 0, max: 0 };
    const publish: NativeHandler = async ({ input }) => {
      active.now += 1;
      active.max = Math.max(active.max, active.now);
      await systemClock.sleep(20);
      active.now -= 1;
      return { postedUrl: `${text(input.videoUrl)}#posted` };
    };
    const ids = {
      claude: await env.plugin('io.universalflow.claude', 'ai-llm', 'chat', async ({ input }) => ({ text: `claude(${text(input.prompt)})` })),
      chatgpt: await env.plugin('io.universalflow.openai', 'ai-llm', 'chat', async ({ input }) => ({ text: `gpt(${text(input.prompt)})` })),
      drive: await env.plugin('io.universalflow.gdrive', 'cloud-storage', 'upload', async () => ({ fileId: 'file_42' })),
      video: await env.plugin('io.universalflow.video', 'ai-video', 'render', async ({ input }) => ({ url: `https://cdn.example.com/${text(input.fileId)}.mp4` })),
      sheets: await env.plugin('io.universalflow.sheets', 'office-documents', 'append', async ({ input }) => ({ appended: input.row })),
      youtube: await env.plugin('io.universalflow.youtube', 'social-media', 'publish', publish),
      facebook: await env.plugin('io.universalflow.facebook', 'social-media', 'publish', publish),
      instagram: await env.plugin('io.universalflow.instagram', 'social-media', 'publish', publish),
    };
    const action = (id: string, plugin: string, actionKey: string, input: Record<string, unknown>): WorkflowNode => ({ id, kind: 'action', plugin, action: actionKey, input });
    const publishInput = { videoUrl: '{{nodes.video.output.url}}' };
    const workflow = workflowOf(
      [
        { id: 'telegram', kind: 'trigger', trigger: 'webhook' },
        action('claude', ids.claude, 'chat', { prompt: '{{trigger.message.text}}' }),
        action('chatgpt', ids.chatgpt, 'chat', { prompt: 'Improve: {{nodes.claude.output.text}}' }),
        action('drive', ids.drive, 'upload', { name: 'script.txt', content: '{{nodes.chatgpt.output.text}}' }),
        action('video', ids.video, 'render', { script: '{{nodes.chatgpt.output.text}}', fileId: '{{nodes.drive.output.fileId}}' }),
        action('sheets', ids.sheets, 'append', { row: ['{{nodes.video.output.url}}', '{{trigger.message.from}}'] }),
        { id: 'approval', kind: 'approval', message: 'Publish {{nodes.video.output.url}}?' },
        action('youtube', ids.youtube, 'publish', publishInput),
        action('facebook', ids.facebook, 'publish', publishInput),
        action('instagram', ids.instagram, 'publish', publishInput),
      ],
      [
        ['telegram', 'claude'],
        ['claude', 'chatgpt'],
        ['chatgpt', 'drive'],
        ['drive', 'video'],
        ['video', 'sheets'],
        ['sheets', 'approval'],
        ['approval', 'youtube', 'approved'],
        ['approval', 'facebook', 'approved'],
        ['approval', 'instagram', 'approved'],
      ],
      'wf_content_pipeline',
    );
    return { ...env, workflow, active };
  };

  it('pauses for approval, then publishes to three platforms in parallel', async () => {
    const { engine, store, workflow, active, events } = await build();
    const waiting = await engine.start(workflow, { payload: { message: { text: 'Ide video kopi', from: 'hinata' } } });
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.nodes.approval?.waitingFor, 'approval');
    assert.deepEqual(waiting.nodes.approval?.output, { message: 'Publish https://cdn.example.com/file_42.mp4?' }, 'the approver reads the rendered message');
    assert.equal(waiting.nodes.youtube?.status, 'pending');
    assert.deepEqual(waiting.nodes.sheets?.output, { appended: ['https://cdn.example.com/file_42.mp4', 'hinata'] });

    const finished = await engine.resolveApproval(workflow, waiting.id, 'approval', { approved: true, by: 'hinata' });
    assert.equal(finished.status, 'succeeded');
    for (const platform of ['youtube', 'facebook', 'instagram']) {
      assert.deepEqual(finished.nodes[platform]?.output, { postedUrl: 'https://cdn.example.com/file_42.mp4#posted' });
    }
    assert.equal(active.max, 3, 'the three publish nodes overlap');

    const steps = await store.steps(waiting.id);
    const videoStep = steps.find((step) => step.nodeId === 'video');
    assert.deepEqual(videoStep?.input, { script: 'gpt(Improve: claude(Ide video kopi))', fileId: 'file_42' });
    assert.ok(events.some((event) => event.type === 'execution.finished' && event.status === 'succeeded'));
  });

  it('skips the publishing branch when the user rejects', async () => {
    const { engine, workflow } = await build();
    const waiting = await engine.start(workflow, { payload: { message: { text: 'x', from: 'y' } } });
    const finished = await engine.resolveApproval(workflow, waiting.id, 'approval', { approved: false, comment: 'not yet' });
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.nodes.approval?.port, 'rejected');
    for (const platform of ['youtube', 'facebook', 'instagram']) assert.equal(finished.nodes[platform]?.status, 'skipped');
    await assert.rejects(engine.resolveApproval(workflow, waiting.id, 'approval', { approved: true }), expectCode('CONFLICT'));
  });
});

describe('workflow engine: control flow', () => {
  it('joins branches after a condition', async () => {
    const { engine } = setup();
    const workflow = workflowOf(
      [
        trigger,
        { id: 'check', kind: 'condition', when: { op: 'gt', left: '{{trigger.amount}}', right: 100 } },
        { id: 'big', kind: 'transform', output: { label: 'big' } },
        { id: 'small', kind: 'transform', output: { label: 'small' } },
        { id: 'merge', kind: 'transform', output: { big: '{{nodes.big.output.label}}', small: '{{nodes.small.output.label}}' } },
      ],
      [
        ['start', 'check'],
        ['check', 'big', 'true'],
        ['check', 'small', 'false'],
        ['big', 'merge'],
        ['small', 'merge'],
      ],
    );
    const result = await engine.start(workflow, { payload: { amount: 150 } });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.nodes.small?.status, 'skipped');
    assert.equal(result.nodes.merge?.status, 'succeeded');
    assert.deepEqual(result.nodes.merge?.output, { big: 'big', small: undefined });
  });

  it('retries retryable failures with exponential backoff', async () => {
    const fake = createFakeClock();
    const { engine, store, plugin } = setup(fake.clock);
    let calls = 0;
    const flaky = await plugin('io.universalflow.flaky', 'automation', 'run', async () => {
      calls += 1;
      if (calls < 3) throw new ConnectorError('HTTP 503', { status: 503, retryable: true });
      return { ok: true };
    });
    const workflow = workflowOf(
      [trigger, { id: 'flaky', kind: 'action', plugin: flaky, action: 'run', input: {}, retry: { maxAttempts: 3, backoffMs: 100 } }],
      [['start', 'flaky']],
    );
    const result = await engine.start(workflow);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.nodes.flaky?.attempts, 3);
    assert.deepEqual(fake.sleeps, [100, 200]);
    const attempts = (await store.steps(result.id)).filter((step) => step.nodeId === 'flaky').map((step) => [step.attempt, step.status]);
    assert.deepEqual(attempts, [
      [1, 'failed'],
      [2, 'failed'],
      [3, 'succeeded'],
    ]);
  });

  it('never retries validation errors and follows the error port', async () => {
    const { engine, plugin } = setup(createFakeClock().clock);
    let calls = 0;
    const strict = await plugin('io.universalflow.strict', 'automation', 'run', async () => {
      calls += 1;
      throw new ValidationError('Bad input', [{ path: '$.input.x', message: 'is required' }]);
    });
    const workflow = workflowOf(
      [
        trigger,
        { id: 'bad', kind: 'action', plugin: strict, action: 'run', input: {}, retry: { maxAttempts: 5, backoffMs: 10 } },
        { id: 'fallback', kind: 'transform', output: { reason: '{{nodes.bad.output.error.message}}' } },
        { id: 'next', kind: 'transform', output: {} },
      ],
      [
        ['start', 'bad'],
        ['bad', 'fallback', 'error'],
        ['bad', 'next'],
      ],
    );
    const result = await engine.start(workflow);
    assert.equal(calls, 1);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.nodes.bad?.status, 'failed');
    assert.equal(result.nodes.next?.status, 'skipped');
    assert.match(text(readJsonPath(result.nodes.fallback?.output, '$.reason')), /\$\.input\.x is required/);
  });

  it('fails the execution when an error has no route', async () => {
    const { engine, plugin } = setup();
    const boom = await plugin('io.universalflow.boom', 'automation', 'run', async () => {
      throw new Error('boom');
    });
    const workflow = workflowOf(
      [trigger, { id: 'bad', kind: 'action', plugin: boom, action: 'run', input: {} }, { id: 'after', kind: 'transform', output: {} }],
      [
        ['start', 'bad'],
        ['bad', 'after'],
      ],
    );
    const result = await engine.start(workflow);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.error, { nodeId: 'bad', message: 'boom', code: 'UNKNOWN' });
    assert.equal(result.nodes.after?.status, 'pending');
  });

  it('can continue on error', async () => {
    const { engine, plugin } = setup();
    const boom = await plugin('io.universalflow.boom', 'automation', 'run', async () => {
      throw new Error('boom');
    });
    const workflow = workflowOf(
      [trigger, { id: 'bad', kind: 'action', plugin: boom, action: 'run', input: {}, continueOnError: true }, { id: 'after', kind: 'transform', output: {} }],
      [
        ['start', 'bad'],
        ['bad', 'after'],
      ],
    );
    const result = await engine.start(workflow);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.nodes.after?.status, 'succeeded');
  });

  it('loops over items with outer data in scope', async () => {
    const { engine, store, plugin } = setup();
    const double = await plugin(
      'io.universalflow.math',
      'developer-tools',
      'multiply',
      async ({ input }) => ({ value: Number(input.value) * Number(input.factor) }),
      { value: { type: 'number' }, factor: { type: 'number' } },
    );
    const workflow = workflowOf(
      [
        trigger,
        { id: 'prep', kind: 'transform', output: { factor: 10 } },
        {
          id: 'each',
          kind: 'loop',
          items: '{{trigger.numbers}}',
          concurrency: 2,
          body: { nodes: [{ id: 'mul', kind: 'action', plugin: double, action: 'multiply', input: { value: '{{item}}', factor: '{{nodes.prep.output.factor}}' } }], edges: [] },
        },
        { id: 'summary', kind: 'transform', output: { count: '{{nodes.each.output.count}}', first: '{{nodes.each.output.results[0].mul.value}}' } },
      ],
      [
        ['start', 'prep'],
        ['prep', 'each'],
        ['each', 'summary'],
      ],
    );
    const result = await engine.start(workflow, { payload: { numbers: [1, 2, 3] } });
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.nodes.each?.output, { count: 3, results: [{ mul: { value: 10 } }, { mul: { value: 20 } }, { mul: { value: 30 } }] });
    assert.deepEqual(result.nodes.summary?.output, { count: 3, first: 10 });
    const loopSteps = (await store.steps(result.id)).map((step) => step.nodeId).filter((nodeId) => nodeId.startsWith('each['));
    assert.deepEqual(loopSteps.sort(), ['each[0].mul', 'each[1].mul', 'each[2].mul']);
  });

  it('runs short delays inline and pauses long ones until they are due', async () => {
    const fake = createFakeClock();
    const { engine } = setup(fake.clock);
    const workflow = workflowOf(
      [
        trigger,
        { id: 'short', kind: 'delay', ms: 500 },
        { id: 'long', kind: 'delay', ms: 3_600_000 },
        { id: 'after', kind: 'transform', output: { done: true } },
      ],
      [
        ['start', 'short'],
        ['short', 'long'],
        ['long', 'after'],
      ],
    );
    const load = async () => workflow;
    const waiting = await engine.start(workflow);
    assert.deepEqual(fake.sleeps, [500]);
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.nodes.long?.waitingFor, 'delay');
    assert.deepEqual(await engine.resumeDueDelays(load), []);
    fake.advance(3_600_000);
    const [resumed] = await engine.resumeDueDelays(load);
    assert.equal(resumed?.status, 'succeeded');
    assert.deepEqual(resumed?.nodes.after?.output, { done: true });
  });

  it('starts from the chosen trigger only', async () => {
    const { engine } = setup();
    const workflow = workflowOf(
      [
        { id: 'manual', kind: 'trigger', trigger: 'manual' },
        { id: 'hook', kind: 'trigger', trigger: 'webhook' },
        { id: 'fromManual', kind: 'transform', output: {} },
        { id: 'fromHook', kind: 'transform', output: { body: '{{trigger.body}}' } },
      ],
      [
        ['manual', 'fromManual'],
        ['hook', 'fromHook'],
      ],
    );
    const result = await engine.start(workflow, { triggerNodeId: 'hook', payload: { body: 'hi' } });
    assert.equal(result.nodes.fromManual?.status, 'skipped');
    assert.deepEqual(result.nodes.fromHook?.output, { body: 'hi' });
  });

  it('cancels a waiting execution', async () => {
    const { engine } = setup();
    const workflow = workflowOf(
      [trigger, { id: 'approval', kind: 'approval', message: 'ok?' }, { id: 'after', kind: 'transform', output: {} }],
      [
        ['start', 'approval'],
        ['approval', 'after', 'approved'],
      ],
    );
    const waiting = await engine.start(workflow);
    const cancelled = await engine.cancel(waiting.id);
    assert.equal(cancelled.status, 'cancelled');
    await assert.rejects(engine.resolveApproval(workflow, waiting.id, 'approval', { approved: true }), expectCode('CONFLICT'));
  });

  it('stops nodes whose plugin was disabled', async () => {
    const { engine, registry, plugin } = setup();
    const ref = await plugin('io.universalflow.mail', 'email', 'send', async () => ({ sent: true }));
    await registry.setEnabled(WORKSPACE, 'io.universalflow.mail', false);
    const workflow = workflowOf([trigger, { id: 'mail', kind: 'action', plugin: ref, action: 'send', input: {} }], [['start', 'mail']]);
    const result = await engine.start(workflow);
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PERMISSION');
  });
});

describe('workflow validation', () => {
  it('rejects cycles, wrong ports and unconnected nodes', async () => {
    const { engine } = setup();
    const cyclic = workflowOf(
      [trigger, { id: 'a', kind: 'transform', output: {} }, { id: 'b', kind: 'transform', output: {} }],
      [
        ['start', 'a'],
        ['a', 'b'],
        ['b', 'a'],
      ],
    );
    await assert.rejects(engine.start(cyclic), /cycle/);
    const wrongPort = workflowOf(
      [trigger, { id: 'check', kind: 'condition', when: { op: 'exists', left: '{{trigger.x}}' } }, { id: 'a', kind: 'transform', output: {} }],
      [
        ['start', 'check'],
        ['check', 'a', 'out'],
      ],
    );
    await assert.rejects(engine.start(wrongPort), /no "out" port/);
    const orphan = workflowOf([trigger, { id: 'lonely', kind: 'transform', output: {} }], []);
    await assert.rejects(engine.start(orphan), /not connected to any trigger/);
  });
});
