export type Issue = { path: string; message: string };

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PERMISSION'
  | 'SECURITY'
  | 'CONNECTOR'
  | 'WORKFLOW';

export class EngineError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export class ValidationError extends EngineError {
  readonly issues: Issue[];

  constructor(message: string, issues: Issue[]) {
    const detail = issues.map((issue) => `${issue.path} ${issue.message}`).join('; ');
    super('VALIDATION', detail ? `${message}: ${detail}` : message);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export type ConnectorErrorOptions = {
  status?: number;
  retryable: boolean;
  responseBody?: unknown;
};

export class ConnectorError extends EngineError {
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly responseBody: unknown;

  constructor(message: string, options: ConnectorErrorOptions) {
    super('CONNECTOR', message);
    this.name = 'ConnectorError';
    this.status = options.status;
    this.retryable = options.retryable;
    this.responseBody = options.responseBody;
  }
}

export type Failure = { message: string; code: string };

/**
 * Engine errors carry a decision about retrying. Anything else (a network
 * failure, a bug in a native handler) is treated as possibly transient.
 */
export const isRetryable = (error: unknown): boolean => {
  if (error instanceof ConnectorError) return error.retryable;
  if (error instanceof EngineError) return false;
  return true;
};

export const toFailure = (error: unknown): Failure => {
  if (error instanceof EngineError) return { message: error.message, code: error.code };
  if (error instanceof Error) return { message: error.message, code: 'UNKNOWN' };
  return { message: String(error), code: 'UNKNOWN' };
};
