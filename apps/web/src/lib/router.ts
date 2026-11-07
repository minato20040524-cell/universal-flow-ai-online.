/** A small history router: patterns with `:param` segments, matched in order. */

export type RouteMatch<Name extends string> = { name: Name; params: Record<string, string> };

export const matchPath = (pattern: string, path: string): Record<string, string> | undefined => {
  const expected = pattern.split('/').filter(Boolean);
  const actual = path.split('/').filter(Boolean);
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const segment = expected.at(index) ?? '';
    const value = actual.at(index) ?? '';
    if (segment.startsWith(':')) {
      try {
        params[segment.slice(1)] = decodeURIComponent(value);
      } catch {
        return undefined;
      }
    } else if (segment !== value) {
      return undefined;
    }
  }
  return params;
};

export const resolveRoute = <Name extends string>(routes: readonly { name: Name; pattern: string }[], path: string): RouteMatch<Name> | undefined => {
  for (const route of routes) {
    const params = matchPath(route.pattern, path);
    if (params) return { name: route.name, params };
  }
  return undefined;
};

/** Only same-app paths may be used as a return target after sign-in. */
export const safeReturnPath = (value: string | null | undefined): string =>
  value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/integrations';
