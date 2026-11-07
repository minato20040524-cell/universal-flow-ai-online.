import { EngineError } from '../errors.js';
import type { AuthType, PluginManifest } from '../manifest/types.js';
import type { JsonSchema, JsonType } from '../schema/json-schema.js';
import type { CredentialInfo } from '../security/secret-store.js';
import { FLOW_OUTPUT_PORTS } from '../workflow/ports.js';
import type { NodeKind } from '../workflow/types.js';

/**
 * Turns plugin metadata into everything Spatial Studio needs to draw and
 * configure a 3D node. It is a pure function of the manifest, so a brand-new
 * Custom API gets a working node the moment it is registered.
 */

export type PortType = JsonType | 'any';

export type DataPort = {
  key: string;
  label: string;
  type: PortType;
  required: boolean;
  description: string | undefined;
};

export type ConfigWidget = 'text' | 'textarea' | 'number' | 'toggle' | 'select' | 'json';

export type ConfigField = {
  key: string;
  label: string;
  widget: ConfigWidget;
  required: boolean;
  options: (string | number | boolean | null)[] | undefined;
  defaultValue: unknown;
  description: string | undefined;
};

export type PortAnchor = { key: string; x: number; y: number; z: number };

/** Sizes in scene units; the renderer decides the material and look. */
export type NodeGeometry = {
  width: number;
  height: number;
  depth: number;
  dataInputs: PortAnchor[];
  dataOutputs: PortAnchor[];
  flowInputs: PortAnchor[];
  flowOutputs: PortAnchor[];
};

export type NodeSource =
  | { kind: 'plugin'; pluginId: string; version: string; key: string; role: 'action' | 'trigger' }
  | { kind: 'builtin'; nodeKind: NodeKind };

export type NodeDefinition = {
  /** Stable type id, e.g. `com.example.ai@1.2.0:generate` or `builtin:condition`. */
  type: string;
  source: NodeSource;
  title: string;
  subtitle: string;
  description: string | undefined;
  icon: string;
  color: string;
  category: string;
  dataInputs: DataPort[];
  dataOutputs: DataPort[];
  flowInputs: string[];
  flowOutputs: string[];
  configFields: ConfigField[];
  auth: { type: AuthType; required: boolean };
  limitations: string[];
  geometry: NodeGeometry;
};

const CATEGORY_STYLE: Record<string, { icon: string; color: string }> = {
  'ai-llm': { icon: 'brain', color: '#7C5CFF' },
  'ai-image': { icon: 'image', color: '#E0569B' },
  'ai-video': { icon: 'film', color: '#F25F4C' },
  'ai-audio': { icon: 'mic', color: '#F2994A' },
  'social-media': { icon: 'share', color: '#2D9CDB' },
  messaging: { icon: 'message', color: '#27AE60' },
  email: { icon: 'mail', color: '#56CCF2' },
  'cloud-storage': { icon: 'cloud', color: '#4F86F7' },
  'office-documents': { icon: 'file', color: '#219653' },
  database: { icon: 'database', color: '#9B51E0' },
  webhooks: { icon: 'webhook', color: '#EB5757' },
  'custom-api': { icon: 'plug', color: '#64748B' },
};
const DEFAULT_STYLE = { icon: 'plug', color: '#64748B' };
const BUILTIN_COLOR = '#94A3B8';

const GEOMETRY = { width: 2.4, header: 0.7, portSpacing: 0.36, padding: 0.3, depth: 0.4 } as const;

export const labelize = (key: string): string =>
  key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (first) => first.toUpperCase());

const portsFromSchema = (schema: JsonSchema, fallbackKey: string): DataPort[] => {
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length === 0) {
    return schema.type === 'object' && schema.properties !== undefined
      ? []
      : [{ key: fallbackKey, label: labelize(fallbackKey), type: schema.type ?? 'any', required: false, description: schema.description }];
  }
  const required = new Set(schema.required ?? []);
  return properties.map(([key, property]) => ({
    key,
    label: property.title ?? labelize(key),
    type: property.type ?? 'any',
    required: required.has(key),
    description: property.description,
  }));
};

const widgetFor = (schema: JsonSchema): ConfigWidget => {
  if (schema.enum) return 'select';
  switch (schema.type) {
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'toggle';
    case 'object':
    case 'array':
      return 'json';
    case 'string':
      return schema.format === 'textarea' || (schema.maxLength ?? 0) > 200 ? 'textarea' : 'text';
    default:
      return 'text';
  }
};

const configFromSchema = (schema: JsonSchema): ConfigField[] => {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([key, property]) => ({
    key,
    label: property.title ?? labelize(key),
    widget: widgetFor(property),
    required: required.has(key),
    options: property.enum,
    defaultValue: property.default,
    description: property.description,
  }));
};

const anchors = (keys: readonly string[], x: number, startY: number): PortAnchor[] =>
  keys.map((key, index) => ({ key, x, y: -(startY + index * GEOMETRY.portSpacing), z: 0 }));

export const computeGeometry = (dataInputs: readonly string[], dataOutputs: readonly string[], flowInputs: readonly string[], flowOutputs: readonly string[]): NodeGeometry => {
  const leftCount = flowInputs.length + dataInputs.length;
  const rightCount = flowOutputs.length + dataOutputs.length;
  const height = GEOMETRY.header + Math.max(leftCount, rightCount, 1) * GEOMETRY.portSpacing + GEOMETRY.padding;
  const left = -GEOMETRY.width / 2;
  const right = GEOMETRY.width / 2;
  const firstRow = GEOMETRY.header;
  return {
    width: GEOMETRY.width,
    height,
    depth: GEOMETRY.depth,
    flowInputs: anchors(flowInputs, left, firstRow),
    dataInputs: anchors(dataInputs, left, firstRow + flowInputs.length * GEOMETRY.portSpacing),
    flowOutputs: anchors(flowOutputs, right, firstRow),
    dataOutputs: anchors(dataOutputs, right, firstRow + flowOutputs.length * GEOMETRY.portSpacing),
  };
};

const styleOf = (manifest: PluginManifest) => {
  const categoryStyle = CATEGORY_STYLE[manifest.category] ?? DEFAULT_STYLE;
  return { icon: manifest.ui.icon ?? categoryStyle.icon, color: manifest.ui.color ?? categoryStyle.color };
};

export const generateNodeDefinitions = (manifest: PluginManifest): NodeDefinition[] => {
  const { icon, color } = styleOf(manifest);
  const auth = { type: manifest.auth.type, required: manifest.auth.type !== 'none' };
  const base = { icon, color, category: manifest.category, auth, limitations: [...manifest.limitations] };

  const actions = manifest.actions.map((action): NodeDefinition => {
    const dataInputs = portsFromSchema(action.inputSchema, 'input');
    const dataOutputs = portsFromSchema(action.outputSchema, 'result');
    const flowInputs = ['in'];
    const flowOutputs = [...FLOW_OUTPUT_PORTS.action];
    return {
      ...base,
      type: `${manifest.id}@${manifest.version}:${action.key}`,
      source: { kind: 'plugin', pluginId: manifest.id, version: manifest.version, key: action.key, role: 'action' },
      title: manifest.name,
      subtitle: action.name,
      description: action.description ?? manifest.description,
      dataInputs,
      dataOutputs,
      flowInputs,
      flowOutputs,
      configFields: configFromSchema(action.inputSchema),
      geometry: computeGeometry(dataInputs.map((port) => port.key), dataOutputs.map((port) => port.key), flowInputs, flowOutputs),
    };
  });

  const triggers = manifest.triggers.map((trigger): NodeDefinition => {
    const dataOutputs = portsFromSchema(trigger.outputSchema, 'payload');
    const flowOutputs = [...FLOW_OUTPUT_PORTS.trigger];
    return {
      ...base,
      type: `${manifest.id}@${manifest.version}:${trigger.key}`,
      source: { kind: 'plugin', pluginId: manifest.id, version: manifest.version, key: trigger.key, role: 'trigger' },
      title: manifest.name,
      subtitle: trigger.name,
      description: trigger.description ?? manifest.description,
      dataInputs: [],
      dataOutputs,
      flowInputs: [],
      flowOutputs,
      configFields: [],
      geometry: computeGeometry([], dataOutputs.map((port) => port.key), [], flowOutputs),
    };
  });

  return [...triggers, ...actions];
};

export const generateNodeDefinition = (manifest: PluginManifest, key: string): NodeDefinition => {
  const definition = generateNodeDefinitions(manifest).find((candidate) => candidate.source.kind === 'plugin' && candidate.source.key === key);
  if (!definition) throw new EngineError('NOT_FOUND', `${manifest.id} has no action or trigger "${key}"`);
  return definition;
};

const BUILTIN_INFO: Record<NodeKind, { title: string; icon: string; description: string }> = {
  trigger: { title: 'Manual Trigger', icon: 'play', description: 'Starts the workflow by hand, from a webhook or on a schedule' },
  action: { title: 'Action', icon: 'bolt', description: 'Runs a plugin action' },
  condition: { title: 'Condition', icon: 'split', description: 'Continues on the true or false port' },
  loop: { title: 'Loop', icon: 'repeat', description: 'Runs its body once per item' },
  delay: { title: 'Delay', icon: 'clock', description: 'Waits before continuing' },
  approval: { title: 'User Approval', icon: 'user-check', description: 'Pauses until someone approves or rejects' },
  transform: { title: 'Transform', icon: 'shuffle', description: 'Builds a new object from earlier outputs' },
};

const outputPort = (key: string, type: PortType, description: string, label = labelize(key)): DataPort => ({ key, label, type, required: false, description });

/**
 * What each control node hands to later steps, exactly as the engine produces it.
 * A trigger's output is the payload itself; a transform's outputs are the fields
 * the workflow author defines, so Studio adds those per node.
 */
const BUILTIN_OUTPUTS: Record<NodeKind, DataPort[]> = {
  trigger: [outputPort('payload', 'object', 'What the trigger received: the webhook request, the manual run payload or the schedule time')],
  action: [],
  condition: [outputPort('result', 'boolean', 'Whether the condition held')],
  loop: [outputPort('count', 'integer', 'How many items were processed'), outputPort('results', 'array', 'Outputs of the loop body, one entry per item')],
  delay: [outputPort('waitedMs', 'integer', 'How long the workflow waited')],
  approval: [
    // Not "Approved": that is already the name of the flow jack above it.
    outputPort('approved', 'boolean', 'The decision: true when approved', 'Decision'),
    outputPort('by', 'string', 'Who decided', 'Decided by'),
    outputPort('comment', 'string', 'The note left with the decision', 'Note'),
  ],
  transform: [],
};

/** Control nodes for the Spatial Studio palette; their ports match the engine exactly. */
export const builtinNodeDefinitions = (): NodeDefinition[] =>
  (['trigger', 'condition', 'loop', 'delay', 'approval', 'transform'] as const).map((kind) => {
    const info = BUILTIN_INFO[kind];
    const flowInputs = kind === 'trigger' ? [] : ['in'];
    const flowOutputs = [...FLOW_OUTPUT_PORTS[kind]];
    const dataOutputs = BUILTIN_OUTPUTS[kind];
    return {
      type: `builtin:${kind}`,
      source: { kind: 'builtin', nodeKind: kind },
      title: info.title,
      subtitle: '',
      description: info.description,
      icon: info.icon,
      color: BUILTIN_COLOR,
      category: 'automation',
      dataInputs: [],
      dataOutputs,
      flowInputs,
      flowOutputs,
      configFields: [],
      auth: { type: 'none', required: false },
      limitations: [],
      geometry: computeGeometry([], dataOutputs.map((port) => port.key), flowInputs, flowOutputs),
    };
  });

export type PortCompatibility = 'ok' | 'convertible' | 'incompatible';

/** Whether a data output may feed a data input; `convertible` means Studio offers a conversion. */
export const portCompatibility = (from: PortType, to: PortType): PortCompatibility => {
  if (from === to || from === 'any' || to === 'any') return 'ok';
  if (from === 'integer' && to === 'number') return 'ok';
  if (to === 'string' && from !== 'null') return 'convertible';
  if (from === 'string' && (to === 'number' || to === 'integer' || to === 'boolean')) return 'convertible';
  if (from === 'number' && to === 'integer') return 'convertible';
  return 'incompatible';
};

export type ConnectionStatus = 'not_required' | 'not_connected' | CredentialInfo['status'];

export const connectionStatusFor = (definition: NodeDefinition, credential: CredentialInfo | undefined): ConnectionStatus => {
  if (!definition.auth.required) return 'not_required';
  return credential ? credential.status : 'not_connected';
};
