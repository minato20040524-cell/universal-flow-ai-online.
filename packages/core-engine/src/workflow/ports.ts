import type { NodeKind } from './types.js';

/** Flow ports each node kind can finish on. Shared by the engine, the validator and the node generator. */
export const FLOW_OUTPUT_PORTS = {
  trigger: ['out'],
  action: ['out', 'error'],
  condition: ['true', 'false'],
  loop: ['out', 'error'],
  delay: ['out'],
  approval: ['approved', 'rejected'],
  transform: ['out', 'error'],
} as const satisfies Record<NodeKind, readonly string[]>;

export const DEFAULT_PORT = 'out';

export const outputPortsOf = (kind: NodeKind): readonly string[] => FLOW_OUTPUT_PORTS[kind];
