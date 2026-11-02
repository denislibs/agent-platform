import type { ComponentChildren } from 'preact';
import { render } from '@testing-library/preact';
import { LocationProvider } from 'preact-iso';
import { ToastProvider } from '@agent/ui';
import { openTaskEvents } from '../src/api/events.ts';
import { APP_LINKS, resetPageFocus } from '../src/layout/page.ts';
import { AppContext, createAppState, type AppDeps } from '../src/state/app.ts';
import { fakeFetch, json, me } from './fixtures.ts';
import { FakeEventSource } from './sse.ts';

type Routes = Parameters<typeof fakeFetch>[0];

/** Маршруты, которые нужны любому экрану после входа: профиль, настройки клиента, пустой список задач. */
export const signedIn = (): Routes => ({
  'GET /api/config': json({ providers: ['github'], uploadMaxBytes: 1024 }),
  'GET /api/me': json(me()),
  'GET /api/tasks': json({ tasks: [], nextCursor: null }),
});

/**
 * Экран в окружении приложения: состояние на фейковом fetch и фейковом EventSource, роутер и тосты.
 * path — адрес, с которого начинается тест (history.replaceState); deps — ручные таймеры экрана задачи.
 */
export function setup(routes: Routes, path = '/', deps: Pick<AppDeps, 'setTimer' | 'clearTimer'> = {}) {
  history.replaceState(null, '', path);
  resetPageFocus();
  FakeEventSource.reset();
  const { fetch, calls } = fakeFetch(routes);
  const assigned: string[] = [];
  const state = createAppState({
    fetch,
    openEvents: opts => openTaskEvents({ ...opts, createSource: url => new FakeEventSource(url) }),
    assign: url => assigned.push(url),
    ...deps,
  });
  const view = (ui: ComponentChildren) =>
    render(
      <ToastProvider>
        <AppContext.Provider value={state}>
          <LocationProvider scope={APP_LINKS}>{ui}</LocationProvider>
        </AppContext.Provider>
      </ToastProvider>,
    );
  return { state, calls, assigned, view };
}

/** Ждать, пока условие станет истинным (без expect внутри — так быстрее в Bun, см. README ui-kit). */
export async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
