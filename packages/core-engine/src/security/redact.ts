import { isRecord } from '../util.js';

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY = /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|^token$|secret|password|cookie)/i;
const MIN_SECRET_LENGTH = 4;

/**
 * Removes secrets from anything that will be logged, stored in execution
 * history or shown in Test API: values under sensitive keys, plus every
 * occurrence of a known secret string (even inside an echoed response).
 */
export const redactValue = (value: unknown, secrets: readonly string[] = []): unknown => {
  const needles = [...new Set(secrets)].filter((secret) => secret.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);

  const scrub = (text: string): string => needles.reduce((result, needle) => result.replaceAll(needle, REDACTED), text);

  const walk = (current: unknown, key: string | undefined): unknown => {
    if (key !== undefined && SENSITIVE_KEY.test(key) && current !== null && current !== undefined && typeof current !== 'object') {
      return REDACTED;
    }
    if (typeof current === 'string') return scrub(current);
    if (Array.isArray(current)) return current.map((item) => walk(item, undefined));
    if (isRecord(current)) return Object.fromEntries(Object.entries(current).map(([childKey, child]) => [childKey, walk(child, childKey)]));
    return current;
  };

  return walk(value, undefined);
};

export const redactText = (text: string, secrets: readonly string[]): string => {
  const result = redactValue(text, secrets);
  return typeof result === 'string' ? result : text;
};
