import { ValidationError, type Issue } from '../errors.js';
import { isRecord } from '../util.js';
import { isCondition } from './condition.js';
import type { Position3D, RetryPolicy, WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowSettings } from './types.js';

/**
 * Reads untrusted workflow JSON (from the API or an import) into typed data.
 * Unknown fields are dropped. Semantic checks (cycles, ports, reachability)
 * are done afterwards by validateGraph.
 */

const TRIGGER_TYPES = ['manual', 'webhook', 'schedule', 'plugin'] as const;

type Source = Record<string, unknown>;

const text = (source: Source, key: string, path: string, issues: Issue[]): string => {
  const value = source[key];
  if (typeof value === 'string' && value !== '') return value;
  issues.push({ path: `${path}.${key}`, message: 'must be a non-empty string' });
  return '';
};

const optionalText = (source: Source, key: string, path: string, issues: Issue[]): string | undefined => {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  issues.push({ path: `${path}.${key}`, message: 'must be a string' });
  return undefined;
};

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const object = (source: Source, key: string, path: string, issues: Issue[]): Record<string, unknown> => {
  const value = source[key];
  if (value === undefined) return {};
  if (isRecord(value)) return value;
  issues.push({ path: `${path}.${key}`, message: 'must be an object' });
  return {};
};

const parsePosition = (value: unknown): Position3D | undefined =>
  isRecord(value) && finiteNumber(value.x) && finiteNumber(value.y) && finiteNumber(value.z) ? { x: value.x, y: value.y, z: value.z } : undefined;

const parseRetry = (value: unknown, path: string, issues: Issue[]): RetryPolicy | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !finiteNumber(value.maxAttempts) || !finiteNumber(value.backoffMs)) {
    issues.push({ path, message: 'must have numeric maxAttempts and backoffMs' });
    return undefined;
  }
  return {
    maxAttempts: value.maxAttempts,
    backoffMs: value.backoffMs,
    ...(finiteNumber(value.factor) ? { factor: value.factor } : {}),
    ...(finiteNumber(value.maxBackoffMs) ? { maxBackoffMs: value.maxBackoffMs } : {}),
  };
};

const parseNode = (value: unknown, path: string, issues: Issue[]): WorkflowNode | undefined => {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return undefined;
  }
  const base = {
    id: text(value, 'id', path, issues),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(parsePosition(value.position) ? { position: parsePosition(value.position) } : {}),
  };
  switch (value.kind) {
    case 'trigger': {
      const trigger = TRIGGER_TYPES.find((type) => type === value.trigger);
      if (!trigger) issues.push({ path: `${path}.trigger`, message: `must be one of ${TRIGGER_TYPES.join(', ')}` });
      const schedule = optionalText(value, 'schedule', path, issues);
      const timezone = optionalText(value, 'timezone', path, issues);
      const plugin = optionalText(value, 'plugin', path, issues);
      const key = optionalText(value, 'key', path, issues);
      return {
        ...base,
        kind: 'trigger',
        trigger: trigger ?? 'manual',
        ...(schedule ? { schedule } : {}),
        ...(timezone ? { timezone } : {}),
        ...(plugin ? { plugin } : {}),
        ...(key ? { key } : {}),
      };
    }
    case 'action': {
      const credentialId = optionalText(value, 'credentialId', path, issues);
      const retry = parseRetry(value.retry, `${path}.retry`, issues);
      return {
        ...base,
        kind: 'action',
        plugin: text(value, 'plugin', path, issues),
        action: text(value, 'action', path, issues),
        input: object(value, 'input', path, issues),
        ...(credentialId ? { credentialId } : {}),
        ...(retry ? { retry } : {}),
        ...(value.continueOnError === true ? { continueOnError: true } : {}),
      };
    }
    case 'condition':
      if (!isCondition(value.when)) issues.push({ path: `${path}.when`, message: 'is not a valid condition' });
      return isCondition(value.when) ? { ...base, kind: 'condition', when: value.when } : undefined;
    case 'loop': {
      const body = parseGraphShape(value.body, `${path}.body`, issues);
      return {
        ...base,
        kind: 'loop',
        items: text(value, 'items', path, issues),
        body,
        ...(finiteNumber(value.concurrency) ? { concurrency: value.concurrency } : {}),
        ...(finiteNumber(value.maxIterations) ? { maxIterations: value.maxIterations } : {}),
      };
    }
    case 'delay':
      if (!finiteNumber(value.ms)) issues.push({ path: `${path}.ms`, message: 'must be a number' });
      return { ...base, kind: 'delay', ms: finiteNumber(value.ms) ? value.ms : 0 };
    case 'approval':
      return { ...base, kind: 'approval', message: optionalText(value, 'message', path, issues) ?? '' };
    case 'transform':
      return { ...base, kind: 'transform', output: object(value, 'output', path, issues) };
    default:
      issues.push({ path: `${path}.kind`, message: 'must be trigger, action, condition, loop, delay, approval or transform' });
      return undefined;
  }
};

const parseEdge = (value: unknown, path: string, issues: Issue[]): WorkflowEdge | undefined => {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return undefined;
  }
  const port = optionalText(value, 'port', path, issues);
  return { id: text(value, 'id', path, issues), from: text(value, 'from', path, issues), to: text(value, 'to', path, issues), ...(port ? { port } : {}) };
};

const parseGraphShape = (value: unknown, path: string, issues: Issue[]): WorkflowGraph => {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges ?? [])) {
    issues.push({ path, message: 'must have a nodes array and an edges array' });
    return { nodes: [], edges: [] };
  }
  const edges = Array.isArray(value.edges) ? value.edges : [];
  return {
    nodes: value.nodes.flatMap((node, index) => {
      const parsed = parseNode(node, `${path}.nodes[${index}]`, issues);
      return parsed ? [parsed] : [];
    }),
    edges: edges.flatMap((edge, index) => {
      const parsed = parseEdge(edge, `${path}.edges[${index}]`, issues);
      return parsed ? [parsed] : [];
    }),
  };
};

export const parseWorkflowGraph = (value: unknown): WorkflowGraph => {
  const issues: Issue[] = [];
  const graph = parseGraphShape(value, '$.graph', issues);
  if (issues.length > 0) throw new ValidationError('Invalid workflow graph', issues);
  return graph;
};

export const parseWorkflowSettings = (value: unknown): WorkflowSettings => {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ValidationError('Invalid workflow settings', [{ path: '$.settings', message: 'must be an object' }]);
  const { concurrency } = value;
  if (concurrency === undefined) return {};
  if (!finiteNumber(concurrency) || concurrency < 1 || concurrency > 50) {
    throw new ValidationError('Invalid workflow settings', [{ path: '$.settings.concurrency', message: 'must be from 1 to 50' }]);
  }
  return { concurrency };
};
