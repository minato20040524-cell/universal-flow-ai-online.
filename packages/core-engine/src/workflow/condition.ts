import { renderTemplate, type TemplateScope } from '../expression/template.js';
import { isRecord, stableStringify } from '../util.js';
import type { Comparison, Condition } from './types.js';

const COMPARISON_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'exists', 'empty'] as const;

export const isCondition = (value: unknown): value is Condition => {
  if (!isRecord(value)) return false;
  if (Array.isArray(value.all)) return value.all.every(isCondition);
  if (Array.isArray(value.any)) return value.any.every(isCondition);
  if (value.not !== undefined) return isCondition(value.not);
  return COMPARISON_OPS.some((op) => op === value.op) && 'left' in value;
};

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && Object.keys(value).length === 0);

const toComparable = (value: unknown): number | string | undefined => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    return value.trim() !== '' && Number.isFinite(numeric) ? numeric : value;
  }
  return undefined;
};

const order = (left: unknown, right: unknown): number | undefined => {
  const a = toComparable(left);
  const b = toComparable(right);
  if (a === undefined || b === undefined || typeof a !== typeof b) return undefined;
  return a < b ? -1 : a > b ? 1 : 0;
};

/** Numbers and strings compare; anything else (or a mix) never satisfies an ordering. */
const isOrdered = (left: unknown, right: unknown, test: (result: number) => boolean): boolean => {
  const result = order(left, right);
  return result !== undefined && test(result);
};

const equals = (left: unknown, right: unknown): boolean =>
  left === right || (typeof left === 'object' && typeof right === 'object' && stableStringify(left) === stableStringify(right));

const compare = ({ op, left, right }: Comparison): boolean => {
  switch (op) {
    case 'eq':
      return equals(left, right);
    case 'neq':
      return !equals(left, right);
    case 'gt':
      return isOrdered(left, right, (result) => result > 0);
    case 'gte':
      return isOrdered(left, right, (result) => result >= 0);
    case 'lt':
      return isOrdered(left, right, (result) => result < 0);
    case 'lte':
      return isOrdered(left, right, (result) => result <= 0);
    case 'contains':
      if (typeof left === 'string') return typeof right === 'string' && left.includes(right);
      return Array.isArray(left) && left.some((item) => equals(item, right));
    case 'startsWith':
      return typeof left === 'string' && typeof right === 'string' && left.startsWith(right);
    case 'exists':
      return left !== undefined && left !== null;
    case 'empty':
      return isEmpty(left);
  }
};

export const evaluateCondition = (condition: Condition, scope: TemplateScope): boolean => {
  if ('all' in condition) return condition.all.every((child) => evaluateCondition(child, scope));
  if ('any' in condition) return condition.any.some((child) => evaluateCondition(child, scope));
  if ('not' in condition) return !evaluateCondition(condition.not, scope);
  return compare({
    op: condition.op,
    left: renderTemplate(condition.left, scope),
    right: renderTemplate(condition.right, scope),
  });
};
