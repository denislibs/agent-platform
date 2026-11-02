import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { createApi, type ApiOptions } from '../api/client.ts';
import { openTaskEvents, type TaskEventsOptions } from '../api/events.ts';
import { createSession, type Session } from './session.ts';
import type { TaskStoreDeps } from './task.ts';
import { createTaskList, type TaskList } from './tasks.ts';

export interface AppDeps {
  fetch?: ApiOptions['fetch'];
  /** Поток шагов задачи; тесты подставляют фейковый EventSource. */
  openEvents?: (opts: TaskEventsOptions) => { close(): void };
  /** Переход на страницу провайдера OAuth (window.location.assign). */
  assign?: (url: string) => void;
  /** Таймеры экрана задачи (задержка пометки «нет связи»); тесты подставляют ручные. */
  setTimer?: TaskStoreDeps['setTimer'];
  clearTimer?: TaskStoreDeps['clearTimer'];
}

/** Состояние приложения: клиент API, сессия и список задач — одни на всё приложение. */
export function createAppState(deps: AppDeps = {}) {
  let session: Session | undefined;
  let tasks: TaskList | undefined;
  /**
   * Сессия кончилась посреди работы: приложение уходит на вход, а список задач прежней сессии забывается сразу —
   * не дожидаясь экрана настроек (защита в глубину: сайдбар следующего входа не покажет чужие задачи).
   */
  const expire = () => {
    session?.signedOut();
    tasks?.clear();
  };
  // Любой 401 охраняемого маршрута переводит приложение на вход.
  const api = createApi({ ...(deps.fetch ? { fetch: deps.fetch } : {}), onUnauthorized: expire });
  session = createSession(api);
  tasks = createTaskList(api);
  return {
    api,
    session,
    tasks,
    /**
     * Продлить cookie сессии (GET /api/auth/get-session). Сессии нет — то же, что 401; сбой сети пробрасывается,
     * вызывающий решает, молчать ли.
     */
    async touchSession(): Promise<void> {
      if (!(await api.touchSession())) expire();
    },
    openEvents: deps.openEvents ?? openTaskEvents,
    assign: deps.assign ?? ((url: string) => window.location.assign(url)),
    timers: {
      ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
      ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
    } satisfies Pick<TaskStoreDeps, 'setTimer' | 'clearTimer'>,
  };
}

export type AppState = ReturnType<typeof createAppState>;

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error('useApp() needs an <AppContext.Provider> above it');
  return state;
}
