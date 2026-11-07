import { isRecord } from '../util.js';

/**
 * Paths like `nodes.claude.output.text`, `items[0]` or `headers["x-id"]`.
 * Expressions are paths only: no function calls and no `eval`, so a workflow
 * can read data but never run code.
 */
export type PathSegment = string | number;

const IDENTIFIER = /^[A-Za-z_$][\w$-]*/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export const parsePath = (input: string): PathSegment[] | undefined => {
  const segments: PathSegment[] = [];
  let rest = input.trim();
  const first = IDENTIFIER.exec(rest)?.[0];
  if (first === undefined) return undefined;
  segments.push(first);
  rest = rest.slice(first.length);

  while (rest.length > 0) {
    if (rest.startsWith('.')) {
      const name = IDENTIFIER.exec(rest.slice(1))?.[0];
      if (name === undefined) return undefined;
      segments.push(name);
      rest = rest.slice(1 + name.length);
      continue;
    }
    const index = /^\[(\d+)\]/.exec(rest);
    if (index?.[1] !== undefined) {
      segments.push(Number(index[1]));
      rest = rest.slice(index[0].length);
      continue;
    }
    const quoted = /^\[(?:"([^"]*)"|'([^']*)')\]/.exec(rest);
    if (quoted) {
      segments.push(quoted[1] ?? quoted[2] ?? '');
      rest = rest.slice(quoted[0].length);
      continue;
    }
    return undefined;
  }
  return segments.some((segment) => typeof segment === 'string' && FORBIDDEN_KEYS.has(segment)) ? undefined : segments;
};

export const readPath = (root: unknown, segments: readonly PathSegment[]): unknown => {
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current.at(segment);
    } else {
      if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
      current = current[segment];
    }
  }
  return current;
};

/** Reads a JSON path such as `$`, `$.data.items[0].id` or `$[0]`. */
export const readJsonPath = (root: unknown, jsonPath: string): unknown => {
  const trimmed = jsonPath.trim();
  if (trimmed === '$') return root;
  if (!trimmed.startsWith('$')) return undefined;
  const segments = parsePath(`root${trimmed.slice(1)}`);
  return segments ? readPath(root, segments.slice(1)) : undefined;
};
