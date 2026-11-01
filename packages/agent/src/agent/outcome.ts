/** Что ставить следующим job (план 3d): kind job, ожидание ответа пользователя или ничего. */
export type StageOutcome = { next: 'plan' | 'execute' | 'review' | 'finalize' | 'wait_user' | 'stop' };

/** Почему задача остановлена раньше времени (tasks.stop_reason). */
export type StopReason = 'token_budget' | 'wall_time' | 'credits' | 'no_plan' | 'wait_timeout' | 'model_error';
