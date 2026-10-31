import { asClass } from 'awilix';
import { TaskIntake } from './task-intake';

export interface AgentServices {
  intake: TaskIntake;
}

/** Регистрации сервисов агента: одни и те же в боевом (composition) и тестовом контейнерах. */
export function agentServices() {
  return {
    intake: asClass(TaskIntake).singleton(),
  };
}
