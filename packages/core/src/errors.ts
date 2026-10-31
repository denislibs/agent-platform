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
