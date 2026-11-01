import { asClass, type Resolver } from 'awilix';
import {
  Compactor,
  ExecutorStage,
  Finalizer,
  JobRunner,
  ModelGateway,
  PlannerStage,
  ResultComposer,
  Sweeper,
  TaskGuard,
  ToolExecutor,
} from './agent';
import { TaskIntake } from './task-intake';

export interface AgentServices {
  intake: TaskIntake;
  gateway: ModelGateway;
  guard: TaskGuard;
  compactor: Compactor;
  toolExecutor: ToolExecutor;
  executorStage: ExecutorStage;
  plannerStage: PlannerStage;
  composer: ResultComposer;
  finalizer: Finalizer;
  runner: JobRunner;
  sweeper: Sweeper;
}

/**
 * Регистрации сервисов агента: одни и те же в боевом (composition) и тестовом контейнерах.
 * Тип возврата перечисляет все поля AgentServices: незарегистрированный сервис не скомпилируется.
 */
export function agentServices(): { [K in keyof AgentServices]: Resolver<AgentServices[K]> } {
  return {
    intake: asClass(TaskIntake).singleton(),
    gateway: asClass(ModelGateway).singleton(),
    guard: asClass(TaskGuard).singleton(),
    compactor: asClass(Compactor).singleton(),
    toolExecutor: asClass(ToolExecutor).singleton(),
    executorStage: asClass(ExecutorStage).singleton(),
    plannerStage: asClass(PlannerStage).singleton(),
    composer: asClass(ResultComposer).singleton(),
    finalizer: asClass(Finalizer).singleton(),
    runner: asClass(JobRunner).singleton(),
    sweeper: asClass(Sweeper).singleton(),
  };
}
