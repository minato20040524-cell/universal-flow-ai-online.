import type { HttpMethod, Route } from './types.js';

type CompiledRoute = { route: Route; segments: string[] };

export type RouteMatch =
  | { kind: 'found'; route: Route; params: Record<string, string> }
  | { kind: 'method-not-allowed'; allowed: HttpMethod[] }
  | { kind: 'not-found' };

const split = (path: string): string[] => path.split('/').filter((segment) => segment !== '');

const matchSegments = (pattern: readonly string[], actual: readonly string[]): Record<string, string> | undefined => {
  if (pattern.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern.at(index) ?? '';
    const segment = actual.at(index) ?? '';
    if (expected.startsWith(':')) {
      try {
        params[expected.slice(1)] = decodeURIComponent(segment);
      } catch {
        return undefined;
      }
    } else if (expected !== segment) {
      return undefined;
    }
  }
  return params;
};

/** Framework-free router; the same route table can be mounted on Fastify later. */
export const createRouter = (routes: readonly Route[]) => {
  const compiled: CompiledRoute[] = routes.map((route) => ({ route, segments: split(route.pattern) }));

  // Static segments win over parameters, so /v1/integrations/custom beats /v1/integrations/:pluginId.
  const specificity = (segments: readonly string[]) => segments.reduce((score, segment) => score * 2 + (segment.startsWith(':') ? 0 : 1), 1);
  compiled.sort((a, b) => specificity(b.segments) - specificity(a.segments));

  return {
    match: (method: HttpMethod, path: string): RouteMatch => {
      const actual = split(path);
      const allowed: HttpMethod[] = [];
      for (const { route, segments } of compiled) {
        const params = matchSegments(segments, actual);
        if (!params) continue;
        if (route.method === method) return { kind: 'found', route, params };
        allowed.push(route.method);
      }
      return allowed.length > 0 ? { kind: 'method-not-allowed', allowed } : { kind: 'not-found' };
    },
  };
};
