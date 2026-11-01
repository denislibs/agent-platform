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
  | 'path_outside_workspace'
  | 'element_not_found'
  | 'browser_failed'
  | 'browser_unavailable'
  | 'not_running'
  | 'file_too_large'
  | 'not_a_file'
  | 'fs_error'
  /** Контейнер с именем песочницы создан не провайдером: сбой инфраструктуры, модели не показывается. */
  | 'foreign_container';

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

export type LimitKind = 'active_tasks' | 'credits';

/** Действие пользователя упёрлось в лимит (спецификация 4.4, 11); API отвечает 429 или 402. */
export class LimitExceededError extends Error {
  constructor(
    readonly limit: LimitKind,
    message: string,
  ) {
    super(message);
    this.name = 'LimitExceededError';
  }
}

export type LlmErrorCode = 'rate_limited' | 'unavailable' | 'timeout' | 'context_length' | 'bad_request' | 'auth';

/**
 * Ошибка вызова модели — уже после повторов внутри SDK (спецификация 7: до 4 повторов на 429/5xx).
 * retryable = true: имеет смысл повторить позже — job падает, и BullMQ повторяет его (план 3d).
 * retryable = false: повтор не поможет (ключ, формат запроса, переполненный контекст) — job не повторяется,
 * вызывающий решает сам (например, ужимает контекст при context_length).
 */
export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
