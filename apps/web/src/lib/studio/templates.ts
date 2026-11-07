import type { NodeDefinition, WorkflowEdge, WorkflowGraph, WorkflowNode } from '../types.js';
import { referencesIn } from './data.js';
import { DEFAULT_PORT, portsOf, resolveDefinition } from './graph.js';
import { UNIT_PX, autoLayout, layoutBoard } from './layout.js';

/** Starting points for a new workflow. */

export type TemplateId = 'blank' | 'content-pipeline';
export type TemplateResult = { graph: WorkflowGraph; missing: { pluginId: string; name: string }[] };

export const TEMPLATES: { id: TemplateId; title: string; description: string }[] = [
  { id: 'blank', title: 'Blank', description: 'A Manual Trigger and nothing else.' },
  {
    id: 'content-pipeline',
    title: 'Content pipeline',
    description:
      'A message comes in, Claude writes a script, ChatGPT writes the caption, the script is saved to Google Drive, a video is rendered and logged in Google Sheets. After your approval it is published to YouTube, Facebook and Instagram and the team hears about it on Telegram.',
  },
];

type Step = {
  id: string;
  pluginId: string;
  action: string;
  name: string;
  /** Display name when the module is not installed. */
  appName: string;
  input: Record<string, unknown>;
  after: readonly (readonly [string, string])[];
  retry?: { maxAttempts: number; backoffMs: number };
};

const PIPELINE: Step[] = [
  {
    id: 'claude',
    pluginId: 'io.universalflow.claude',
    action: 'chat',
    appName: 'Claude',
    name: 'Write the script',
    input: { prompt: 'Write a 30-second video script about: {{trigger.body.text}}', system: 'You write short, upbeat video scripts.' },
    after: [['incoming', DEFAULT_PORT]],
  },
  {
    id: 'chatgpt',
    pluginId: 'io.universalflow.openai',
    action: 'chat',
    appName: 'ChatGPT',
    name: 'Write the caption',
    input: { prompt: 'Write a short social caption for this script:\n{{nodes.claude.output.text}}' },
    after: [['claude', DEFAULT_PORT]],
  },
  {
    id: 'drive',
    pluginId: 'io.universalflow.gdrive',
    action: 'upload',
    appName: 'Google Drive',
    name: 'Save the script',
    input: { name: 'video-script.txt', content: '{{nodes.claude.output.text}}' },
    after: [['chatgpt', DEFAULT_PORT]],
  },
  {
    id: 'video',
    pluginId: 'io.universalflow.video',
    action: 'render',
    appName: 'Video Generator',
    name: 'Render the video',
    input: { script: '{{nodes.claude.output.text}}', style: 'clean' },
    after: [['drive', DEFAULT_PORT]],
    retry: { maxAttempts: 3, backoffMs: 5000 },
  },
  {
    id: 'sheets',
    pluginId: 'io.universalflow.sheets',
    action: 'appendRow',
    appName: 'Google Sheets',
    name: 'Log it',
    input: { spreadsheetId: '', row: ['{{nodes.video.output.url}}', '{{nodes.chatgpt.output.text}}'] },
    after: [['video', DEFAULT_PORT]],
  },
  {
    id: 'youtube',
    pluginId: 'io.universalflow.youtube',
    action: 'publish',
    appName: 'YouTube',
    name: 'Publish on YouTube',
    input: { videoUrl: '{{nodes.video.output.url}}', title: '{{nodes.chatgpt.output.text}}' },
    after: [['approval', 'approved']],
  },
  {
    id: 'facebook',
    pluginId: 'io.universalflow.facebook',
    action: 'publish',
    appName: 'Facebook',
    name: 'Publish on Facebook',
    input: { videoUrl: '{{nodes.video.output.url}}', caption: '{{nodes.chatgpt.output.text}}' },
    after: [['approval', 'approved']],
  },
  {
    id: 'instagram',
    pluginId: 'io.universalflow.instagram',
    action: 'publish',
    appName: 'Instagram',
    name: 'Publish on Instagram',
    input: { videoUrl: '{{nodes.video.output.url}}', caption: '{{nodes.chatgpt.output.text}}' },
    after: [['approval', 'approved']],
  },
  {
    id: 'notify',
    pluginId: 'io.universalflow.telegram',
    action: 'sendMessage',
    appName: 'Telegram',
    name: 'Tell the team',
    input: { chatId: '', text: 'Published: {{nodes.video.output.url}}' },
    after: [
      ['youtube', DEFAULT_PORT],
      ['facebook', DEFAULT_PORT],
      ['instagram', DEFAULT_PORT],
    ],
  },
  {
    id: 'notify-rejected',
    pluginId: 'io.universalflow.telegram',
    action: 'sendMessage',
    appName: 'Telegram',
    name: 'Say it was held back',
    input: { chatId: '', text: 'Not published: {{nodes.approval.output.comment}}' },
    after: [['approval', 'rejected']],
  },
];

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const definitionFor = (palette: readonly NodeDefinition[], pluginId: string, key: string) =>
  palette.find((definition) => definition.source.kind === 'plugin' && definition.source.pluginId === pluginId && definition.source.key === key);

const heightIn = (palette: readonly NodeDefinition[]) => (node: WorkflowNode) => layoutBoard(portsOf(node, resolveDefinition(node, palette).definition)).height / UNIT_PX;

export const blankTemplate = (): WorkflowGraph => ({ nodes: [{ id: 'start', kind: 'trigger', trigger: 'manual', name: 'Start', position: { x: 0, y: 0, z: 0 } }], edges: [] });

/**
 * The workflow from the specification, built from the modules installed in
 * this workspace. A missing module is left out (and named), and the cables
 * that went through it are joined around it, so the rest still works.
 */
export const contentPipelineTemplate = (palette: readonly NodeDefinition[]): TemplateResult => {
  const nodes: WorkflowNode[] = [
    { id: 'incoming', kind: 'trigger', trigger: 'webhook', name: 'Incoming message' },
  ];
  const missing: TemplateResult['missing'] = [];
  const present = new Set(['incoming', 'approval']);
  const afterOf = new Map<string, readonly (readonly [string, string])[]>(PIPELINE.map((step) => [step.id, step.after]));
  afterOf.set('approval', [['sheets', DEFAULT_PORT]]);

  for (const step of PIPELINE) {
    const definition = definitionFor(palette, step.pluginId, step.action);
    if (!definition || definition.source.kind !== 'plugin') {
      if (!missing.some((entry) => entry.pluginId === step.pluginId)) missing.push({ pluginId: step.pluginId, name: step.appName });
      continue;
    }
    present.add(step.id);
    nodes.push({
      id: step.id,
      kind: 'action',
      name: step.name,
      plugin: `${step.pluginId}@${definition.source.version}`,
      action: step.action,
      input: step.input,
      ...(step.retry ? { retry: step.retry } : {}),
    });
  }
  const approvalIndex = nodes.findIndex((node) => node.id === 'youtube' || node.id === 'facebook' || node.id === 'instagram' || node.id === 'notify' || node.id === 'notify-rejected');
  const approval: WorkflowNode = { id: 'approval', kind: 'approval', name: 'Approve publishing', message: 'Publish {{nodes.video.output.url}} with this caption?\n{{nodes.chatgpt.output.text}}' };
  nodes.splice(approvalIndex === -1 ? nodes.length : approvalIndex, 0, approval);

  /** Follows a missing step back to the nearest steps that exist. */
  const resolveSources = (from: string, port: string, seen = new Set<string>()): (readonly [string, string])[] => {
    if (present.has(from)) return [[from, port]];
    if (seen.has(from)) return [];
    seen.add(from);
    return (afterOf.get(from) ?? []).flatMap(([previous, previousPort]) => resolveSources(previous, previousPort, seen));
  };

  const edges: WorkflowEdge[] = [];
  for (const node of nodes) {
    for (const [from, port] of afterOf.get(node.id) ?? []) {
      for (const [source, sourcePort] of resolveSources(from, port)) {
        const id = `${source}-${sourcePort}-${node.id}`;
        if (!edges.some((edge) => edge.id === id)) edges.push({ id, from: source, to: node.id, ...(sourcePort === DEFAULT_PORT ? {} : { port: sourcePort }) });
      }
    }
  }
  return { graph: autoLayout({ nodes, edges }, heightIn(palette)), missing };
};

export const buildTemplate = (id: TemplateId, palette: readonly NodeDefinition[]): TemplateResult =>
  id === 'blank' ? { graph: blankTemplate(), missing: [] } : contentPipelineTemplate(palette);

/**
 * An example payload for a manual run, shaped by what the workflow reads from
 * its trigger: `{{trigger.body.text}}` gives `{ "body": { "text": "" } }`.
 */
export const samplePayload = (graph: WorkflowGraph): Record<string, unknown> => {
  const sample: Record<string, unknown> = {};
  const values = graph.nodes.flatMap((node): unknown[] =>
    node.kind === 'action' ? [node.input] : node.kind === 'transform' ? [node.output] : node.kind === 'approval' ? [node.message] : node.kind === 'condition' ? [node.when] : node.kind === 'loop' ? [node.items] : [],
  );
  for (const reference of values.flatMap(referencesIn)) {
    if (!reference.startsWith('trigger.')) continue;
    const segments = reference.slice('trigger.'.length).split('.').filter((segment) => /^[A-Za-z_$][\w$-]*$/.test(segment));
    let cursor: Record<string, unknown> = sample;
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        if (!(segment in cursor)) cursor[segment] = '';
        return;
      }
      const next = cursor[segment];
      if (isPlainObject(next)) cursor = next;
      else {
        const created: Record<string, unknown> = {};
        cursor[segment] = created;
        cursor = created;
      }
    });
  }
  return sample;
};
