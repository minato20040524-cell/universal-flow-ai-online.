import type { Issue } from '../errors.js';
import { isRecord, isStringArray } from '../util.js';

/**
 * The subset of JSON Schema that plugin inputs and outputs use. It is enough
 * to build node ports and configuration forms and to validate data at runtime.
 */
export const JSON_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'] as const;
export type JsonType = (typeof JSON_TYPES)[number];
export type JsonLiteral = string | number | boolean | null;

export type JsonSchema = {
  type?: JsonType;
  title?: string;
  description?: string;
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: JsonLiteral[];
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
};

const isJsonType = (value: unknown): value is JsonType => JSON_TYPES.some((type) => type === value);

const isJsonLiteral = (value: unknown): value is JsonLiteral =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

const TEXT_KEYS = ['title', 'description', 'format'] as const;
const NUMBER_KEYS = ['minLength', 'maxLength', 'minimum', 'maximum'] as const;

/** Reads an untrusted object into a typed schema, collecting every problem it finds. */
export const parseJsonSchema = (value: unknown, path: string, issues: Issue[]): JsonSchema => {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be a JSON Schema object' });
    return {};
  }
  const schema: JsonSchema = {};

  if (value.type !== undefined) {
    if (isJsonType(value.type)) schema.type = value.type;
    else issues.push({ path: `${path}.type`, message: `must be one of ${JSON_TYPES.join(', ')}` });
  }
  for (const key of TEXT_KEYS) {
    const text = value[key];
    if (text === undefined) continue;
    if (typeof text === 'string') schema[key] = text;
    else issues.push({ path: `${path}.${key}`, message: 'must be a string' });
  }
  for (const key of NUMBER_KEYS) {
    const amount = value[key];
    if (amount === undefined) continue;
    if (typeof amount === 'number' && Number.isFinite(amount)) schema[key] = amount;
    else issues.push({ path: `${path}.${key}`, message: 'must be a number' });
  }
  if (value.properties !== undefined) {
    const properties = value.properties;
    if (isRecord(properties)) {
      schema.properties = Object.fromEntries(
        Object.entries(properties).map(([key, child]) => [
          key,
          parseJsonSchema(child, `${path}.properties.${key}`, issues),
        ]),
      );
    } else {
      issues.push({ path: `${path}.properties`, message: 'must be an object' });
    }
  }
  if (value.required !== undefined) {
    if (isStringArray(value.required)) schema.required = value.required;
    else issues.push({ path: `${path}.required`, message: 'must be an array of strings' });
  }
  if (value.items !== undefined) schema.items = parseJsonSchema(value.items, `${path}.items`, issues);
  if (value.enum !== undefined) {
    if (Array.isArray(value.enum) && value.enum.every(isJsonLiteral)) schema.enum = value.enum;
    else issues.push({ path: `${path}.enum`, message: 'must be an array of literal values' });
  }
  if (value.default !== undefined) schema.default = value.default;
  if (value.additionalProperties !== undefined) {
    if (typeof value.additionalProperties === 'boolean') schema.additionalProperties = value.additionalProperties;
    else issues.push({ path: `${path}.additionalProperties`, message: 'must be a boolean' });
  }
  return schema;
};

export const typeOfValue = (value: unknown): JsonType => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  return 'object';
};

const matchesType = (expected: JsonType, value: unknown): boolean => {
  const actual = typeOfValue(value);
  return actual === expected || (expected === 'number' && actual === 'integer');
};

/** Validates a value against a schema. Returns an empty list when the value is valid. */
export const validateValue = (schema: JsonSchema, value: unknown, path = '$'): Issue[] => {
  if (value === undefined) return [{ path, message: 'is missing' }];
  if (schema.type && !matchesType(schema.type, value)) {
    return [{ path, message: `must be ${schema.type}, got ${typeOfValue(value)}` }];
  }
  const issues: Issue[] = [];

  if (schema.enum && !schema.enum.some((option) => option === value)) {
    issues.push({ path, message: `must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}` });
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path, message: `must be at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ path, message: `must be at most ${schema.maxLength} characters` });
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: `must be >= ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: `must be <= ${schema.maximum}` });
  }
  const itemSchema = schema.items;
  if (Array.isArray(value) && itemSchema) {
    value.forEach((item, index) => issues.push(...validateValue(itemSchema, item, `${path}[${index}]`)));
  }
  if (isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) issues.push({ path: `${path}.${key}`, message: 'is required' });
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (value[key] !== undefined) issues.push(...validateValue(child, value[key], `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) issues.push({ path: `${path}.${key}`, message: 'is not allowed' });
      }
    }
  }
  return issues;
};
