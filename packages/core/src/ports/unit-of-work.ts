import type { CreditLedger, FileRepository, StepLog, SubtaskRepository, TaskRepository } from './repositories';

/** Репозитории, привязанные к одной транзакции. */
export interface TxRepositories {
  tasks: TaskRepository;
  steps: StepLog;
  subtasks: SubtaskRepository;
  ledger: CreditLedger;
  files: FileRepository;
  /**
   * Блокирует пользователя до конца транзакции: другие транзакции, вызвавшие lockUser для него же, ждут.
   * Так проверки «активных задач не больше лимита» и «баланс > 0» не гоняются с созданием задачи.
   * Неизвестный пользователь — NotFoundError('user').
   */
  lockUser(userId: string): Promise<void>;
}

/**
 * Несколько операций с репозиториями как одна транзакция (спецификация 4.1).
 * fn завершилась — всё записано; бросила — не записано ничего, а наружу уходит та же ошибка.
 * Внутри fn — только репозитории из tx. Вложенный run не поддерживается.
 */
export interface UnitOfWork {
  run<T>(fn: (tx: TxRepositories) => Promise<T>): Promise<T>;
}
