import { EngineError } from '@universal-flow/core-engine';

export type SqlParam = string | number | boolean | null;
export type SqlRow = Record<string, unknown>;

/**
 * The one thing repositories need from a database driver. `pg.Pool#query`
 * fits this shape. Queries use $1..$n placeholders and explicit casts
 * (`$1::jsonb`, `$2::timestamptz`), so they behave the same under any driver.
 */
export type SqlClient = {
  query: (text: string, params?: readonly SqlParam[]) => Promise<SqlRow[]>;
  close?: () => Promise<void>;
};

const columnError = (column: string, expected: string, value: unknown) =>
  new EngineError('WORKFLOW', `Column ${column} should be ${expected}, got ${typeof value}`);

export const col = {
  string: (row: SqlRow, column: string): string => {
    const value = row[column];
    if (typeof value !== 'string') throw columnError(column, 'text', value);
    return value;
  },
  optionalString: (row: SqlRow, column: string): string | undefined => {
    const value = row[column];
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'string') throw columnError(column, 'text', value);
    return value;
  },
  number: (row: SqlRow, column: string): number => {
    const value = row[column];
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) throw columnError(column, 'a number', value);
    return parsed;
  },
  optionalNumber: (row: SqlRow, column: string): number | undefined =>
    row[column] === null || row[column] === undefined ? undefined : col.number(row, column),
  boolean: (row: SqlRow, column: string): boolean => {
    const value = row[column];
    if (typeof value !== 'boolean') throw columnError(column, 'boolean', value);
    return value;
  },
  /** timestamptz arrives as a Date from pg and as an ISO string from JSON; both become epoch ms. */
  epoch: (row: SqlRow, column: string): number => {
    const value = row[column];
    const ms = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(ms)) throw columnError(column, 'a timestamp', value);
    return ms;
  },
  optionalEpoch: (row: SqlRow, column: string): number | undefined =>
    row[column] === null || row[column] === undefined ? undefined : col.epoch(row, column),
  json: (row: SqlRow, column: string): unknown => {
    const value = row[column];
    return typeof value === 'string' ? JSON.parse(value) : value;
  },
};

export const ts = (epochMs: number): string => new Date(epochMs).toISOString();
export const optionalTs = (epochMs: number | undefined): string | null => (epochMs === undefined ? null : ts(epochMs));
export const jsonParam = (value: unknown): string => JSON.stringify(value ?? null);

/** Thrown when a row changed under us; workers retry the job instead of overwriting newer state. */
export class ConcurrentModificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentModificationError';
  }
}

export const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
