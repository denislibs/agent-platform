export class InvalidTransitionError extends Error {
  constructor(
    readonly entity: 'task' | 'subtask',
    readonly id: string,
    readonly to: string,
  ) {
    super(`${entity} ${id}: transition to "${to}" is not allowed from its current status`);
    this.name = 'InvalidTransitionError';
  }
}

export class NotFoundError extends Error {
  constructor(
    readonly entity: string,
    readonly key: string,
  ) {
    super(`${entity} ${key} not found`);
    this.name = 'NotFoundError';
  }
}

export type SandboxErrorCode =
  'path_outside_workspace' | 'element_not_found' | 'browser_failed' | 'not_running' | 'file_too_large';

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export type SearchErrorCode = 'invalid_query' | 'rate_limited' | 'unavailable';

export class SearchError extends Error {
  constructor(
    readonly code: SearchErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SearchError';
  }
}
