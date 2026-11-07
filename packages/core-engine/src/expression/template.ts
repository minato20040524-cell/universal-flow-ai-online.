import { ValidationError } from '../errors.js';
import { isRecord } from '../util.js';
import { parsePath, readPath } from './path.js';

const FULL_EXPRESSION = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const ANY_EXPRESSION = /\{\{\s*([^{}]+?)\s*\}\}/g;

export type TemplateScope = Record<string, unknown>;
export type RenderOptions = {
  /** Applied to every interpolated value, e.g. encodeURIComponent for URL paths. */
  encode?: (text: string) => string;
};

export const stringifyValue = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
};

export const resolveExpression = (expression: string, scope: TemplateScope): unknown => {
  const segments = parsePath(expression);
  if (!segments) {
    throw new ValidationError('Invalid expression', [{ path: expression, message: 'only data paths like nodes.id.output.field are allowed' }]);
  }
  return readPath(scope, segments);
};

/**
 * Renders `{{path}}` placeholders anywhere inside a JSON value.
 * A string that is exactly one placeholder keeps the referenced value's type
 * (an array stays an array); placeholders inside longer text are stringified.
 */
export const renderTemplate = (template: unknown, scope: TemplateScope, options: RenderOptions = {}): unknown => {
  if (typeof template === 'string') {
    const full = FULL_EXPRESSION.exec(template);
    if (full?.[1] !== undefined) {
      const value = resolveExpression(full[1], scope);
      return options.encode ? options.encode(stringifyValue(value)) : value;
    }
    return template.replace(ANY_EXPRESSION, (_match, expression: string) => {
      const text = stringifyValue(resolveExpression(expression, scope));
      return options.encode ? options.encode(text) : text;
    });
  }
  if (Array.isArray(template)) return template.map((item) => renderTemplate(item, scope, options));
  if (isRecord(template)) {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, renderTemplate(value, scope, options)]));
  }
  return template;
};

/** Lists every path a template refers to, e.g. to draw data links in Spatial Studio. */
export const listReferences = (template: unknown): string[] => {
  const references: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(ANY_EXPRESSION)) if (match[1] !== undefined) references.push(match[1].trim());
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (isRecord(value)) Object.values(value).forEach(walk);
  };
  walk(template);
  return references;
};
