import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { createApi, type ApiOptions } from '../api/client.ts';
import { openTaskEvents, type TaskEventsOptions } from '../api/events.ts';
import { createSession, type Session } from './session.ts';
import { createTaskList } from './tasks.ts';

export interface AppDeps {
  fetch?: ApiOptions['fetch'];
  /** Поток шагов задачи; тесты подставляют фейковый EventSource. */
  openEvents?: (opts: TaskEventsOptions) => { close(): void };
  /** Переход на страницу провайдера OAuth (window.location.assign). */
  assign?: (url: string) => void;
}

/** Состояние приложения: клиент API, сессия и список задач — одни на всё приложение. */
export function createAppState(deps: AppDeps = {}) {
  let session: Session | undefined;
  const api = createApi({
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    // Сессия кончилась посреди работы: любой 401 охраняемого маршрута переводит приложение на вход.
    onUnauthorized: () => session?.signedOut(),
  });
  session = createSession(api);
  return {
    api,
    session,
    tasks: createTaskList(api),
    openEvents: deps.openEvents ?? openTaskEvents,
    assign: deps.assign ?? ((url: string) => window.location.assign(url)),
  };
}

export type AppState = ReturnType<typeof createAppState>;

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error('useApp() needs an <AppContext.Provider> above it');
  return state;
}
