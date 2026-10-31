import type { SubtaskContract, SubtaskStatus, TaskStatus } from '@agent/shared';
import type {
  AppendStepInput,
  FileKind,
  FileRecord,
  NewFile,
  Step,
  Subtask,
  SubtaskPatch,
  Task,
  TaskPatch,
  UsageInput,
} from '../entities';

/**
 * Общие правила для всех репозиториев:
 * - Кривой id (не UUID) ведёт себя ровно как неизвестный: чтение даёт undefined / [],
 *   запись — NotFoundError. Адаптер не пропускает наружу ошибки формата из хранилища.
 * - Ссылка на несуществующую сущность (внешний ключ) даёт NotFoundError(entity, id),
 *   и при этом ничего не записывается.
 */

/** Ожидаемый текущий статус (один или несколько) для защиты перехода от гонок. */
export type ExpectedFrom<S extends string> = S | readonly S[];

/**
 * transition/update бросают NotFoundError для неизвестной задачи и InvalidTransitionError для запрещённого перехода.
 * transition атомарен: с opts.expectedFrom переход разрешён только из (допустимые по машине статусов ∩ expectedFrom),
 * иначе InvalidTransitionError и ничего не меняется. Так из двух параллельных переходов из одного статуса
 * побеждает ровно один.
 * Ключи патча со значением undefined игнорируются (поле не меняется); null явно очищает поле.
 */
export interface TaskRepository {
  /** Неизвестный userId — NotFoundError('user'). */
  create(input: { userId: string; prompt: string }): Promise<Task>;
  get(id: string): Promise<Task | undefined>;
  transition(
    id: string,
    to: TaskStatus,
    patch?: TaskPatch,
    opts?: { expectedFrom?: ExpectedFrom<TaskStatus> },
  ): Promise<Task>;
  update(id: string, patch: TaskPatch): Promise<Task>;
  /** Задачи пользователя в нефинальных статусах. */
  countActive(userId: string): Promise<number>;
}

/** Лента шагов. seq растёт на 1 внутри задачи и не повторяется даже при параллельной записи. */
export interface StepLog {
  /** Неизвестная задача — NotFoundError('task'), неизвестный subtaskId — NotFoundError('subtask'); lastSeq не растёт. */
  append(input: AppendStepInput): Promise<Step>;
  list(taskId: string, opts?: { afterSeq?: number; subtaskId?: string }): Promise<Step[]>;
}

export interface SubtaskRepository {
  /**
   * idx продолжает нумерацию задачи с 0 (повторный вызов — это replan).
   * Неизвестная задача — NotFoundError('task'); пустой список возвращает [] без проверок.
   */
  insertMany(taskId: string, contracts: SubtaskContract[]): Promise<Subtask[]>;
  list(taskId: string): Promise<Subtask[]>;
  nextPending(taskId: string): Promise<Subtask | undefined>;
  /** Как TaskRepository.transition: NotFoundError / InvalidTransitionError, атомарная проверка opts.expectedFrom. */
  transition(
    id: string,
    to: SubtaskStatus,
    patch?: SubtaskPatch,
    opts?: { expectedFrom?: ExpectedFrom<SubtaskStatus> },
  ): Promise<Subtask>;
}

/** Учёт расхода: событие, списание кредитов и токены задачи — атомарно. Баланс может уйти в минус. */
export interface CreditLedger {
  /** Неизвестный пользователь — NotFoundError('user'), неизвестная задача — NotFoundError('task'); ничего не списывается и не пишется. */
  record(e: UsageInput): Promise<{ balance: number }>;
  grant(email: string, amount: number): Promise<{ balance: number }>;
}

export interface FileRepository {
  /** Неизвестный userId — NotFoundError('user'), неизвестный taskId — NotFoundError('task'). */
  insert(input: NewFile): Promise<FileRecord>;
  listForTask(taskId: string, kind?: FileKind): Promise<FileRecord[]>;
  /**
   * Привязывает только файлы этого пользователя, ещё не привязанные к задаче. Возвращает их число.
   * Кривые и чужие id файлов молча пропускаются; неизвестная задача — NotFoundError('task')
   * (пустой список возвращает 0 без проверок).
   */
  attachToTask(fileIds: string[], userId: string, taskId: string): Promise<number>;
}
