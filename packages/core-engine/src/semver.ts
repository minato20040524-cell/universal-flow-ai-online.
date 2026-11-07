/**
 * Minimal semantic versioning: enough to pin plugin versions in workflows and
 * to check a plugin's `engine` range against the running Core Engine.
 * Supported ranges: `*`, `1.2.3`, `=1.2.3`, `^1.2.3`, `~1.2.3`, `>=`, `>`, `<`, `<=`,
 * space-separated (AND) and `||` (OR).
 */
export type SemVer = { major: number; minor: number; patch: number; prerelease: string[] };

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export const parseSemver = (input: string): SemVer | undefined => {
  const match = SEMVER_PATTERN.exec(input.trim());
  if (!match) return undefined;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
};

export const isValidSemver = (input: string): boolean => parseSemver(input) !== undefined;

const compareIdentifiers = (left: string, right: string): number => {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
};

const comparePrerelease = (left: string[], right: string[]): number => {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.at(index);
    const rightPart = right.at(index);
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const result = compareIdentifiers(leftPart, rightPart);
    if (result !== 0) return result;
  }
  return 0;
};

export const compareVersions = (left: SemVer, right: SemVer): number =>
  left.major - right.major ||
  left.minor - right.minor ||
  left.patch - right.patch ||
  comparePrerelease(left.prerelease, right.prerelease);

/** Compares two version strings; invalid versions sort first. */
export const compareSemver = (left: string, right: string): number => {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  return compareVersions(a, b);
};

type Operator = '>=' | '>' | '<' | '<=' | '=';
type Comparator = { operator: Operator; version: SemVer };

const release = (major: number, minor: number, patch: number): SemVer => ({ major, minor, patch, prerelease: [] });

const caretUpperBound = (version: SemVer): SemVer => {
  if (version.major > 0) return release(version.major + 1, 0, 0);
  if (version.minor > 0) return release(0, version.minor + 1, 0);
  return release(0, 0, version.patch + 1);
};

const OPERATOR_PATTERN = /^(>=|<=|>|<|=)?(.+)$/;

const expandToken = (token: string): Comparator[] | undefined => {
  if (token === '*' || token === 'x') return [];
  if (token.startsWith('^') || token.startsWith('~')) {
    const version = parseSemver(token.slice(1));
    if (!version) return undefined;
    const upper = token.startsWith('^') ? caretUpperBound(version) : release(version.major, version.minor + 1, 0);
    return [
      { operator: '>=', version },
      { operator: '<', version: upper },
    ];
  }
  const match = OPERATOR_PATTERN.exec(token);
  const versionText = match?.[2];
  if (!match || versionText === undefined) return undefined;
  const version = parseSemver(versionText);
  if (!version) return undefined;
  const operator: Operator = match[1] === '>=' || match[1] === '<=' || match[1] === '>' || match[1] === '<' ? match[1] : '=';
  return [{ operator, version }];
};

const parseComparatorSet = (part: string): Comparator[] | undefined => {
  const comparators: Comparator[] = [];
  for (const token of part.trim().split(/\s+/).filter(Boolean)) {
    const expanded = expandToken(token);
    if (!expanded) return undefined;
    comparators.push(...expanded);
  }
  return comparators;
};

const passes = (version: SemVer, comparator: Comparator): boolean => {
  const result = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case '>=':
      return result >= 0;
    case '>':
      return result > 0;
    case '<':
      return result < 0;
    case '<=':
      return result <= 0;
    case '=':
      return result === 0;
  }
};

export const isValidRange = (range: string): boolean =>
  range.trim() !== '' && range.split('||').every((part) => parseComparatorSet(part) !== undefined);

export const satisfies = (version: string, range: string): boolean => {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  return range.split('||').some((part) => {
    const comparators = parseComparatorSet(part);
    return comparators !== undefined && comparators.every((comparator) => passes(parsed, comparator));
  });
};
