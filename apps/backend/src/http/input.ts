import { ValidationError, isRecord, isStringArray, isStringRecord } from '@universal-flow/core-engine';

/** Small readers for untrusted request bodies and query strings; each failure names its field. */

const fail = (path: string, message: string) => new ValidationError('Invalid request', [{ path, message }]);

export const object = (value: unknown, path = 'body'): Record<string, unknown> => {
  if (!isRecord(value)) throw fail(path, 'must be a JSON object');
  return value;
};

export const string = (source: Record<string, unknown>, key: string, options: { maxLength?: number } = {}): string => {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') throw fail(key, 'must be a non-empty string');
  if (options.maxLength !== undefined && value.length > options.maxLength) throw fail(key, `must be at most ${options.maxLength} characters`);
  return value;
};

export const optionalString = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw fail(key, 'must be a string');
  return value;
};

export const boolean = (source: Record<string, unknown>, key: string): boolean => {
  const value = source[key];
  if (typeof value !== 'boolean') throw fail(key, 'must be true or false');
  return value;
};

export const optionalInteger = (source: Record<string, unknown>, key: string, range: { min: number; max: number }): number | undefined => {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < range.min || value > range.max) {
    throw fail(key, `must be an integer from ${range.min} to ${range.max}`);
  }
  return value;
};

export const stringList = (source: Record<string, unknown>, key: string): string[] => {
  const value = source[key] ?? [];
  if (!isStringArray(value)) throw fail(key, 'must be an array of strings');
  return value;
};

export const stringMap = (source: Record<string, unknown>, key: string): Record<string, string> => {
  const value = source[key];
  if (!isStringRecord(value)) throw fail(key, 'must be an object of string values');
  return value;
};

export const queryInteger = (query: URLSearchParams, key: string, fallback: number, range: { min: number; max: number }): number => {
  const raw = query.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < range.min || value > range.max) throw fail(key, `must be an integer from ${range.min} to ${range.max}`);
  return value;
};

export const queryString = (query: URLSearchParams, key: string): string | undefined => {
  const raw = query.get(key);
  return raw === null || raw === '' ? undefined : raw;
};
