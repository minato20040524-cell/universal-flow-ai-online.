import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FLOW_OUTPUT_PORTS as ENGINE_PORTS,
  builtinNodeDefinitions,
  generateNodeDefinitions,
  parseManifest,
  validateGraph,
  type WorkflowGraph as EngineGraph,
} from '@universal-flow/core-engine';
import { createApiClient } from '../src/lib/api.js';
import { DEFAULT_CAMERA, FIT_MAX_ZOOM, fitCamera, panTo, project, unproject, zoomAt } from '../src/lib/studio/camera.js';
import { dataLinksOf, dataSourcesFor, insertToken, linkInput, parseReference, referencesIn, soleReference, unlinkInput } from '../src/lib/studio/data.js';
import { describeCron, describeDelay, nodeSummary, splitDelay } from '../src/lib/studio/describe.js';
import { createDraftStore } from '../src/lib/studio/draft.js';
import { approvalMessage, pendingApprovals, pollDelayFor, runViewsFor, stepsOf } from '../src/lib/studio/execution.js';
import {
  FLOW_OUTPUT_PORTS,
  connect,
  createNode,
  graphAt,
  portsOf,
  removeNodes,
  resolveDefinition,
  suggestNodeId,
  updateGraphAt,
  upstreamOf,
  wouldCreateCycle,
} from '../src/lib/studio/graph.js';
import { createHistory, record, redo, seal, undo } from '../src/lib/studio/history.js';
import { checkWorkflow, hasErrors, issuesFromServer, locate } from '../src/lib/studio/issues.js';
import { GEOMETRY, UNIT_PX, autoLayout, boardHeightUnits, freeSpot, layoutBoard, positionOf } from '../src/lib/studio/layout.js';
import { contentPipelineTemplate, samplePayload } from '../src/lib/studio/templates.js';
import type { ExecutionDetail, NodeDefinition, WorkflowGraph, WorkflowNode } from '../src/lib/types.js';

/* ---------- A palette built by the real node generator ---------- */

const native = (id: string, name: string, category: string, key: string, inputs: Record<string, string>, outputs: Record<string, string>, required: string[] = []) =>
  parseManifest({
    id,
    name,
    version: '1.0.0',
    engine: '^1.0.0',
    provider: 'Universal Flow',
    category,
    runtime: 'native',
    actions: [
      {
        key,
        name: key,
        inputSchema: { type: 'object', required, properties: Object.fromEntries(Object.entries(inputs).map(([field, type]) => [field, { type }])) },
        outputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(outputs).map(([field, type]) => [field, { type }])) },
      },
    ],
  });

const MANIFESTS = [
  native('io.universalflow.claude', 'Claude', 'ai-llm', 'chat', { prompt: 'string', system: 'string' }, { text: 'string', tokens: 'integer' }, ['prompt']),
  native('io.universalflow.openai', 'ChatGPT', 'ai-llm', 'chat', { prompt: 'string' }, { text: 'string' }, ['prompt']),
  native('io.universalflow.gdrive', 'Google Drive', 'cloud-storage', 'upload', { name: 'string', content: 'string' }, { fileId: 'string' }),
  native('io.universalflow.video', 'Video Generator', 'ai-video', 'render', { script: 'string', style: 'string' }, { url: 'string', seconds: 'number' }),
  native('io.universalflow.sheets', 'Google Sheets', 'office-documents', 'appendRow', { spreadsheetId: 'string', row: 'array' }, { updatedRange: 'string' }, ['spreadsheetId', 'row']),
  native('io.universalflow.youtube', 'YouTube', 'social-media', 'publish', { videoUrl: 'string', title: 'string' }, { postUrl: 'string' }),
  native('io.universalflow.instagram', 'Instagram', 'social-media', 'publish', { videoUrl: 'string', caption: 'string' }, { postUrl: 'string' }),
  native('io.universalflow.telegram', 'Telegram', 'messaging', 'sendMessage', { chatId: 'string', text: 'string' }, { messageId: 'string' }, ['chatId', 'text']),
];

/** The engine's definitions are structurally the web app's NodeDefinition (the API sends them as JSON). */
const toWeb = (definitions: unknown): NodeDefinition[] => JSON.parse(JSON.stringify(definitions));
const palette = toWeb([...builtinNodeDefinitions(), ...MANIFESTS.flatMap((manifest) => generateNodeDefinitions(manifest))]);
const definition = (type: string): NodeDefinition => {
  const found = palette.find((candidate) => candidate.type === type);
  assert.ok(found, `palette has ${type}`);
  return found;
};
const at = (x: number, z = 0) => ({ x, y: 0, z });
const toEngine = (graph: WorkflowGraph): EngineGraph => JSON.parse(JSON.stringify(graph));

const chain = (): WorkflowGraph => ({
  nodes: [
    createNode(definition('builtin:trigger'), 'start', at(0)),
    { id: 'claude', kind: 'action', plugin: 'io.universalflow.claude@1.0.0', action: 'chat', input: { prompt: 'Summarise {{trigger.text}}' }, position: at(3) },
    createNode(definition('builtin:approval'), 'approval', at(6)),
    { id: 'telegram', kind: 'action', plugin: 'io.universalflow.telegram@1.0.0', action: 'sendMessage', input: { chatId: 'team', text: '{{nodes.claude.output.text}}' }, position: at(9) },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'claude' },
    { id: 'e2', from: 'claude', to: 'approval' },
    { id: 'e3', from: 'approval', port: 'approved', to: 'telegram' },
  ],
});

describe('Studio and the engine agree', () => {
  it('uses the engine flow ports', () => {
    assert.deepEqual(FLOW_OUTPUT_PORTS, ENGINE_PORTS);
  });

  it('draws boards exactly as tall as the node generator says, with jacks in its order', () => {
    for (const candidate of palette) {
      const ports = portsOf(createNode(candidate, 'x', at(0)), candidate);
      const layout = layoutBoard(ports);
      assert.ok(Math.abs(layout.height - candidate.geometry.height * UNIT_PX) < 1e-6, `${candidate.type} height`);
      assert.equal(layout.width, candidate.geometry.width * UNIT_PX);
      const right = layout.jacks.filter((jack) => jack.side === 'out').map((jack) => jack.key);
      assert.deepEqual(right, [...candidate.geometry.flowOutputs, ...candidate.geometry.dataOutputs].map((anchor) => anchor.key), `${candidate.type} outputs`);
    }
  });

  it('builds the content pipeline as a graph the engine accepts, even with modules missing', () => {
    const full = contentPipelineTemplate(palette);
    assert.deepEqual(full.missing.map((entry) => entry.name), ['Facebook']);
    assert.deepEqual(validateGraph(toEngine(full.graph), { isBody: false }), []);
    assert.equal(full.graph.nodes.length, 11);
    assert.ok(full.graph.edges.some((edge) => edge.from === 'approval' && edge.port === 'rejected' && edge.to === 'notify-rejected'));

    const withoutDrive = contentPipelineTemplate(palette.filter((candidate) => !candidate.type.startsWith('io.universalflow.gdrive')));
    assert.deepEqual(withoutDrive.missing.map((entry) => entry.name), ['Google Drive', 'Facebook']);
    assert.ok(withoutDrive.graph.edges.some((edge) => edge.from === 'chatgpt' && edge.to === 'video'), 'the cable is joined around the missing step');
    assert.deepEqual(validateGraph(toEngine(withoutDrive.graph), { isBody: false }), []);
  });

  it('blocks saving exactly when the engine would refuse the graph', () => {
    const loopWith = (body: WorkflowGraph): WorkflowNode => ({ id: 'each', kind: 'loop', items: '{{trigger.rows}}', body });
    const cases: [string, WorkflowGraph][] = [
      ['valid chain', chain()],
      ['no nodes', { nodes: [], edges: [] }],
      ['no trigger', { nodes: [{ id: 'wait', kind: 'delay', ms: 10 }], edges: [] }],
      ['unconnected step', { ...chain(), edges: chain().edges.slice(0, 2) }],
      ['trigger with an incoming cable', { ...chain(), edges: [...chain().edges, { id: 'back', from: 'telegram', to: 'start' }] }],
      ['cycle', { ...chain(), edges: [...chain().edges, { id: 'back', from: 'telegram', to: 'claude' }] }],
      ['schedule without cron', { nodes: [{ id: 'tick', kind: 'trigger', trigger: 'schedule' }], edges: [] }],
      ['empty loop', { nodes: [{ id: 'start', kind: 'trigger', trigger: 'manual' }, loopWith({ nodes: [], edges: [] })], edges: [{ id: 'e', from: 'start', to: 'each' }] }],
      [
        'approval inside a loop',
        { nodes: [{ id: 'start', kind: 'trigger', trigger: 'manual' }, loopWith({ nodes: [{ id: 'ask', kind: 'approval', message: '?' }], edges: [] })], edges: [{ id: 'e', from: 'start', to: 'each' }] },
      ],
      [
        'valid loop',
        { nodes: [{ id: 'start', kind: 'trigger', trigger: 'manual' }, loopWith({ nodes: [{ id: 'shape', kind: 'transform', output: { email: '{{item.email}}' } }], edges: [] })], edges: [{ id: 'e', from: 'start', to: 'each' }] },
      ],
      ['bad port', { ...chain(), edges: [...chain().edges.slice(0, 2), { id: 'e3', from: 'approval', port: 'maybe', to: 'telegram' }] }],
      ['bad delay', { nodes: [{ id: 'start', kind: 'trigger', trigger: 'manual' }, { id: 'wait', kind: 'delay', ms: -5 }], edges: [{ id: 'e', from: 'start', to: 'wait' }] }],
    ];
    for (const [name, graph] of cases) {
      const engine = validateGraph(toEngine(graph), { isBody: false });
      const studio = checkWorkflow(graph, { palette, credentials: [] });
      assert.equal(hasErrors(studio), engine.length > 0, `${name}: engine says ${JSON.stringify(engine)}; studio says ${JSON.stringify(studio.filter((issue) => issue.severity === 'error'))}`);
    }
  });
});

describe('editing the graph', () => {
  it('connects only what the engine can run', () => {
    const graph = chain();
    assert.equal(connect(graph, 'telegram', 'out', 'claude').ok, false, 'a cycle');
    assert.equal(connect(graph, 'claude', 'out', 'claude').ok, false, 'itself');
    assert.equal(connect(graph, 'claude', 'out', 'start').ok, false, 'into a trigger');
    assert.equal(connect(graph, 'claude', 'out', 'approval').ok, false, 'twice');
    assert.equal(connect(graph, 'claude', 'maybe', 'telegram').ok, false, 'a missing port');
    const error = connect(graph, 'claude', 'error', 'telegram');
    assert.ok(error.ok);
    if (error.ok) assert.deepEqual(error.edge, { id: 'claude-error-telegram', from: 'claude', port: 'error', to: 'telegram' });
    const plain = connect({ ...graph, edges: graph.edges.slice(0, 2) }, 'approval', 'out', 'telegram');
    assert.equal(plain.ok, false, 'approvals have no out port');
    assert.ok(wouldCreateCycle(graph, 'telegram', 'start'));
  });

  it('removes a step with its cables and finds what runs before a step', () => {
    const graph = removeNodes(chain(), new Set(['approval']));
    assert.deepEqual(graph.edges.map((edge) => edge.id), ['e1']);
    assert.deepEqual(upstreamOf(chain(), 'telegram').map((node) => node.id), ['approval', 'claude', 'start']);
  });

  it('suggests short unique ids and edits loop bodies through a path', () => {
    assert.equal(suggestNodeId('Claude', new Set()), 'claude');
    assert.equal(suggestNodeId('Telegram', new Set(['telegram', 'telegram-2'])), 'telegram-3');
    assert.equal(suggestNodeId('2 step!', new Set()), 'step-2-step');
    const root: WorkflowGraph = { nodes: [{ id: 'each', kind: 'loop', items: '{{trigger.rows}}', body: { nodes: [], edges: [] } }], edges: [] };
    const updated = updateGraphAt(root, ['each'], (body) => ({ ...body, nodes: [{ id: 'shape', kind: 'transform', output: {} }] }));
    assert.equal(graphAt(updated, ['each'])?.nodes[0]?.id, 'shape');
    assert.deepEqual(locate(updated, 'shape'), ['each']);
  });

  it('falls back honestly when a module is missing or pinned to another version', () => {
    const missing = resolveDefinition({ id: 'x', kind: 'action', plugin: 'org.gone@2.0.0', action: 'go', input: { a: 1 } }, palette);
    assert.equal(missing.status, 'missing');
    assert.deepEqual(missing.definition.dataInputs.map((port) => port.key), ['a']);
    const older = resolveDefinition({ id: 'y', kind: 'action', plugin: 'io.universalflow.claude@0.9.0', action: 'chat', input: {} }, palette);
    assert.equal(older.status, 'other-version');
    const warnings = checkWorkflow({ nodes: [{ id: 'start', kind: 'trigger', trigger: 'manual' }, { id: 'x', kind: 'action', plugin: 'org.gone@2.0.0', action: 'go', input: {} }], edges: [{ id: 'e', from: 'start', to: 'x' }] }, { palette, credentials: [] });
    assert.ok(warnings.some((issue) => issue.severity === 'warning' && /not installed/.test(issue.message)));
    assert.equal(hasErrors(warnings), false, 'saving is allowed; running is what fails');
  });

  it('maps server issues back onto steps, inside loops too', () => {
    const root: WorkflowGraph = {
      nodes: [
        { id: 'start', kind: 'trigger', trigger: 'manual' },
        { id: 'each', kind: 'loop', items: '{{trigger.rows}}', body: { nodes: [{ id: 'mail', kind: 'action', plugin: 'a@1.0.0', action: 'send', input: {} }], edges: [] } },
      ],
      edges: [{ id: 'e', from: 'start', to: 'each' }],
    };
    const [nested, runnable, quoted, edge] = issuesFromServer(root, [
      { path: '$.graph.nodes[1].body.nodes[0].retry.maxAttempts', message: 'bad' },
      { path: 'nodes.mail.credentialId', message: 'gone' },
      { path: '$.graph', message: 'node "each" is not connected to any trigger' },
      { path: '$.graph.edges[0].port', message: 'no port' },
    ]);
    assert.deepEqual([nested?.nodeId, nested?.path, nested?.field], ['mail', ['each'], 'retry']);
    assert.deepEqual([runnable?.nodeId, runnable?.path, runnable?.field], ['mail', ['each'], 'credentialId']);
    assert.equal(quoted?.nodeId, 'each');
    assert.equal(edge?.nodeId, 'start');
  });
});

describe('data between steps', () => {
  it('reads and parses references', () => {
    assert.deepEqual(referencesIn({ a: 'Hi {{ nodes.claude.output.text }}', b: ['{{trigger.body.text}}'] }), ['nodes.claude.output.text', 'trigger.body.text']);
    assert.equal(soleReference('{{item.email}}'), 'item.email');
    assert.equal(soleReference('Dear {{item.name}}'), undefined);
    assert.deepEqual(parseReference('nodes.claude.output.text'), { kind: 'node', nodeId: 'claude', port: 'text' });
    assert.deepEqual(parseReference('trigger.body.text'), { kind: 'trigger', port: 'body' });
    assert.deepEqual(parseReference('item.email'), { kind: 'item' });
  });

  it('draws a data cable for every reference in an action input', () => {
    const graph = chain();
    const ports = new Map(graph.nodes.map((node) => [node.id, portsOf(node, resolveDefinition(node, palette).definition)]));
    const links = dataLinksOf(graph, ports);
    assert.deepEqual(
      links.map((link) => [link.fromNodeId, link.fromPort, link.toNodeId, link.toPort]),
      [
        ['start', 'payload', 'claude', 'prompt'],
        ['claude', 'text', 'telegram', 'text'],
      ],
    );
  });

  it('links and unlinks inputs, keeping text around a reference', () => {
    const linked = linkInput(chain(), 'telegram', 'chatId', 'nodes.approval.output.by');
    const telegram = linked.nodes.find((node) => node.id === 'telegram');
    assert.equal(telegram?.kind === 'action' ? telegram.input.chatId : undefined, '{{nodes.approval.output.by}}');
    const unlinked = unlinkInput(chain(), 'claude', 'prompt', 'trigger.text');
    const claude = unlinked.nodes.find((node) => node.id === 'claude');
    assert.equal(claude?.kind === 'action' ? claude.input.prompt : undefined, 'Summarise');
    assert.equal(insertToken('Hello !', 'trigger.name', 6), 'Hello {{trigger.name}}!');
  });

  it('offers earlier steps, and inside a loop the item and the steps before the loop', () => {
    const root: WorkflowGraph = {
      nodes: [
        { id: 'start', kind: 'trigger', trigger: 'manual' },
        { id: 'claude', kind: 'action', plugin: 'io.universalflow.claude@1.0.0', action: 'chat', input: {} },
        { id: 'each', kind: 'loop', items: '{{nodes.claude.output.text}}', body: { nodes: [{ id: 'shape', kind: 'transform', output: {} }], edges: [] } },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'claude' },
        { id: 'e2', from: 'claude', to: 'each' },
      ],
    };
    const ports = (node: WorkflowNode) => portsOf(node, resolveDefinition(node, palette).definition);
    const title = (node: WorkflowNode) => node.id;
    const outside = dataSourcesFor(root, [], 'each', ports, title);
    assert.deepEqual(outside.map((source) => source.id), ['claude', 'start']);
    assert.deepEqual(outside[0]?.choices.map((choice) => choice.reference), ['nodes.claude.output.text', 'nodes.claude.output.tokens']);
    assert.equal(outside[1]?.choices[0]?.reference, 'trigger');
    const inside = dataSourcesFor(root, ['each'], 'shape', ports, title);
    assert.deepEqual(inside.map((source) => source.id), ['$item', 'claude', 'start']);
  });

  it('suggests a run payload from what the workflow reads', () => {
    assert.deepEqual(samplePayload(contentPipelineTemplate(palette).graph), { body: { text: '' } });
  });
});

describe('the camera', () => {
  const viewport = { width: 900, height: 600 };

  it('unprojects what it projects, on any plane', () => {
    const camera = { yaw: 25, tilt: 50, zoom: 0.7, target: { x: 120, y: -40 } };
    for (const point of [{ x: 0, y: 0, z: 0 }, { x: 400, y: 260, z: 21 }, { x: -300, y: 500, z: 60 }]) {
      const back = unproject(camera, viewport, project(camera, viewport, point), point.z);
      assert.ok(Math.hypot(back.x - point.x, back.y - point.y) < 1e-6);
    }
  });

  it('keeps the point under the pointer still while zooming and panning', () => {
    const screen = { x: 640, y: 210 };
    const before = unproject(DEFAULT_CAMERA, viewport, screen);
    const zoomed = zoomAt(DEFAULT_CAMERA, viewport, screen, 1.6);
    const after = unproject(zoomed, viewport, screen);
    assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 1e-6);
    const panned = panTo(DEFAULT_CAMERA, viewport, { x: 0, y: 0 }, { x: 100, y: 100 });
    const moved = unproject(panned, viewport, { x: 100, y: 100 });
    assert.ok(Math.hypot(moved.x, moved.y) < 1e-6);
  });

  it('frames a box inside the viewport and never zooms past life size', () => {
    const box = { minX: -1200, minY: -300, maxX: 1600, maxY: 500, height: 21 };
    const fitted = fitCamera(DEFAULT_CAMERA, viewport, box);
    for (const x of [box.minX, box.maxX]) {
      for (const y of [box.minY, box.maxY]) {
        const point = project(fitted, viewport, { x, y, z: 0 });
        assert.ok(point.x >= 0 && point.x <= viewport.width && point.y >= 0 && point.y <= viewport.height, 'corner on screen');
      }
    }
    const small = fitCamera(DEFAULT_CAMERA, viewport, { minX: 0, minY: 0, maxX: 240, maxY: 100, height: 21 });
    assert.equal(small.zoom, FIT_MAX_ZOOM);
  });
});

describe('layout', () => {
  it('lays steps out in columns that follow the cables, without overlaps', () => {
    const heightOf = (node: WorkflowNode) => layoutBoard(portsOf(node, resolveDefinition(node, palette).definition)).height / UNIT_PX;
    const laidOut = autoLayout(contentPipelineTemplate(palette).graph, heightOf);
    const nodeAt = (id: string) => {
      const found = laidOut.nodes.find((node) => node.id === id);
      assert.ok(found, id);
      return found;
    };
    const x = (id: string) => positionOf(nodeAt(id)).x;
    for (const edge of laidOut.edges) assert.ok(x(edge.to) > x(edge.from), `${edge.from} before ${edge.to}`);
    assert.equal(x('youtube'), x('instagram'), 'parallel branches share a column');
    const taken = positionOf(nodeAt('incoming'));
    assert.notDeepEqual(freeSpot(laidOut, heightOf, taken, 1.4), taken, 'a new board moves off an occupied spot');
    assert.equal(boardHeightUnits(0, 0), GEOMETRY.header + GEOMETRY.portSpacing + GEOMETRY.padding);
  });
});

describe('runs on the boards', () => {
  const detail: ExecutionDetail = {
    execution: {
      id: 'exec_1',
      workflowId: 'wf',
      workflowVersion: 2,
      workspaceId: 'ws',
      status: 'waiting',
      trigger: { nodeId: 'start', payload: {} },
      nodes: {
        start: { status: 'succeeded', attempts: 1, port: 'out' },
        claude: { status: 'succeeded', attempts: 2, port: 'out' },
        approval: { status: 'waiting', attempts: 1, waitingFor: 'approval', output: { message: 'Publish it?' } },
        telegram: { status: 'pending', attempts: 0 },
      },
      edges: { e1: 'fired', e2: 'fired', e3: 'pending' },
      startedAt: 1,
    },
    steps: [
      { executionId: 'exec_1', nodeId: 'each[0].shape', attempt: 1, status: 'succeeded', startedAt: 1, durationMs: 3 },
      { executionId: 'exec_1', nodeId: 'each[1].shape', attempt: 1, status: 'failed', startedAt: 2, durationMs: 3 },
      { executionId: 'exec_1', nodeId: 'claude', attempt: 2, status: 'succeeded', startedAt: 2, durationMs: 30 },
    ],
  };

  it('lights each board from the engine state, and loop bodies from their records', () => {
    const views = runViewsFor(detail, []);
    assert.equal(views.get('approval')?.label, 'Waiting for approval');
    assert.equal(views.get('claude')?.tone, 'ready');
    assert.equal(views.has('telegram'), false, 'pending steps stay dark');
    const body = runViewsFor(detail, ['each']);
    assert.deepEqual([body.get('shape')?.tone, body.get('shape')?.label], ['fault', '1 failed, 1 done']);
    assert.equal(stepsOf(detail.steps, ['each'], 'shape').length, 2);
    assert.deepEqual(pendingApprovals(detail.execution), ['approval']);
    assert.equal(approvalMessage(detail.execution.status === 'waiting' && 'nodes' in detail.execution ? detail.execution.nodes.approval : undefined), 'Publish it?');
    assert.equal(pollDelayFor('running'), 700);
    assert.equal(pollDelayFor('succeeded'), undefined);
  });
});

describe('words on the boards', () => {
  it('describes schedules and waits in plain language', () => {
    assert.equal(describeCron('0 9 * * 1-5'), 'Weekdays at 09:00');
    assert.equal(describeCron('*/15 * * * *'), 'Every 15 minutes');
    assert.equal(describeCron('30 7 * * 1'), 'Every Monday at 07:30');
    assert.equal(describeCron('5 4 1 */2 *'), '5 4 1 */2 *');
    assert.equal(describeDelay(90_000), 'Waits 90 seconds');
    assert.equal(describeDelay(3_600_000), 'Waits 1 hour');
    assert.equal(splitDelay(120_000).unit.key, 'minutes');
    assert.equal(nodeSummary({ id: 'c', kind: 'condition', when: { op: 'gt', left: '{{nodes.claude.output.tokens}}', right: 100 } }, definition('builtin:condition')), 'If claude tokens is more than 100');
  });
});

describe('undo and drafts', () => {
  it('groups related changes into one undo step', () => {
    let history = createHistory(1);
    history = record(history, 2, 'typing');
    history = record(history, 3, 'typing');
    history = seal(history);
    history = record(history, 4);
    assert.equal(undo(history).present, 3);
    assert.equal(undo(undo(history)).present, 1);
    assert.equal(redo(undo(history)).present, 4);
  });

  it('keeps an unsaved draft per workspace and ignores damaged ones', () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value), removeItem: (key: string) => void memory.delete(key) };
    const drafts = createDraftStore(storage);
    const draft = { baseVersion: 3, name: 'x', graph: chain(), settings: {}, savedAt: 5 };
    drafts.save('ws1', 'wf', draft);
    assert.deepEqual(drafts.load('ws1', 'wf'), draft);
    assert.equal(drafts.load('ws2', 'wf'), undefined);
    memory.set('uf.draft.ws1.wf', '{oops');
    assert.equal(drafts.load('ws1', 'wf'), undefined);
    drafts.clear('ws1', 'wf');
    assert.equal(memory.size, 0);
    assert.equal(createDraftStore(undefined).load('ws', 'wf'), undefined, 'works without storage');
  });
});

describe('the workflow API client', () => {
  it('saves with the expected version and runs a pinned version with the CSRF token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = createApiClient({
      csrfToken: () => 'csrf-1',
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ executionId: 'exec_9', jobId: 'job_1', currentVersion: 4 }), { status: 200 });
      },
    });
    await api.saveWorkflow('wf_1', { name: 'n', graph: chain(), settings: {}, expectedVersion: 3 });
    await api.run('wf_1', { version: 4, payload: { text: 'hi' } });
    await api.executions({ workflowId: 'wf_1', limit: 25 });
    assert.equal(calls[0]?.init.method, 'PUT');
    assert.equal(JSON.parse(String(calls[0]?.init.body)).expectedVersion, 3);
    assert.equal(calls[1]?.url, '/v1/workflows/wf_1/run');
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { version: 4, payload: { text: 'hi' } });
    assert.deepEqual(calls[1]?.init.headers, { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': 'csrf-1' });
    assert.equal(calls[2]?.url, '/v1/executions?workflowId=wf_1&limit=25');
  });
});
