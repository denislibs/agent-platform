export type LogFields = Record<string, unknown>;

/** Журнал для оператора. Реализации не бросают: сбой журнала не должен ронять сценарий. */
export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}
