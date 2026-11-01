import { asClass, type Resolver } from 'awilix';
import { Compactor, ModelGateway, TaskGuard } from './agent';
import { TaskIntake } from './task-intake';

export interface AgentServices {
  intake: TaskIntake;
  gateway: ModelGateway;
  guard: TaskGuard;
  compactor: Compactor;
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
  };
}
