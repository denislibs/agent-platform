import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { LocationProvider, Route, Router, useLocation } from 'preact-iso';
import { Compass } from 'lucide-preact';
import { Alert, Button, EmptyState, Spinner, ToastProvider } from '@agent/ui';
import { APP_LINKS, MAIN_ID, usePage } from './layout/page.ts';
import { Shell } from './layout/shell.tsx';
import { Home } from './routes/home.tsx';
import { SettingsPage } from './routes/settings.tsx';
import { SignIn } from './routes/sign-in.tsx';
import { TaskScreen } from './routes/task.tsx';
import { AppContext, createAppState, useApp, type AppDeps } from './state/app.ts';
import { RETURN_PARAM, safeReturnPath, signInPath } from './state/return-to.ts';

/** Как часто продлевать cookie сессии, пока вкладка открыта (Better Auth обновляет его в get-session). */
export const SESSION_TOUCH_MS = 10 * 60_000;

function Splash({ children }: { children: ComponentChildren }) {
  return (
    <main id={MAIN_ID} class="ui-auth" tabIndex={-1}>
      {children}
    </main>
  );
}

function NotFound() {
  usePage('Not found');
  return (
    <Shell>
      <div class="ui-center">
        <EmptyState
          icon={Compass}
          title="Page not found"
          description="The address is wrong or the page was moved."
          actions={
            <a class="ui-link" href="/">
              Start a new task
            </a>
          }
        />
      </div>
    </Shell>
  );
}

/** Задача по адресу: key пересоздаёт экран при смене id — закрывается поток прежней задачи, сбрасываются черновики. */
function TaskRoute({ id }: { id: string }) {
  return <TaskScreen key={id} id={id} />;
}

/**
 * Продление сессии (backlog плана 4a): охрана API не пересылает обновлённый cookie, а get-session — да.
 * Раз в SESSION_TOUCH_MS, пока вкладка видима, и сразу при возвращении на вкладку, которая простояла дольше
 * (таймеры скрытой вкладки браузер притормаживает). Работает только с сессией; сбой сети молчит, «сессии нет» — вход.
 */
function useSessionRefresh(): void {
  const app = useApp();
  const status = app.session.status.value;
  useEffect(() => {
    if (status !== 'signed_in') return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
      app.touchSession().catch(() => undefined);
    };
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') touch();
    }, SESSION_TOUCH_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - last >= SESSION_TOUCH_MS) touch();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [status, app]);
}

/** Охрана маршрутов: без сессии — только вход; с сессией вход не нужен. 401 посреди работы переводит сюда же. */
function Routes() {
  const { session } = useApp();
  const { path, url, query, route } = useLocation();
  const status = session.status.value;
  const onSignIn = path === '/sign-in';

  useEffect(() => {
    void session.load();
  }, [session]);
  // Без сессии вход помнит страницу, на которую вернуться; после входа — назад на неё (только путь этого приложения).
  const returnTo = safeReturnPath(query[RETURN_PARAM]) ?? '/';
  useEffect(() => {
    // Вышел сам — вход без памятки: возвращать на настройки, откуда нажали «Sign out», незачем.
    if (status === 'signed_out' && !onSignIn) route(session.leftOnPurpose.peek() ? '/sign-in' : signInPath(url), true);
    if (status === 'signed_in' && onSignIn) route(returnTo, true);
  }, [status, onSignIn, url, returnTo, route, session]);
  useSessionRefresh();

  if (status === 'unreachable')
    return (
      <Splash>
        <Alert
          tone="danger"
          title="Cannot reach the server"
          actions={<Button onClick={() => void session.load()}>Retry</Button>}
        >
          Check your connection and try again.
        </Alert>
      </Splash>
    );
  if (status === 'loading' || (status === 'signed_out') !== onSignIn)
    return (
      <Splash>
        <Spinner size="lg" label="Loading" />
      </Splash>
    );
  return (
    <Router>
      <Route path="/sign-in" component={SignIn} />
      <Route path="/" component={Home} />
      <Route path="/tasks/:id" component={TaskRoute} />
      <Route path="/settings" component={SettingsPage} />
      <Route default component={NotFound} />
    </Router>
  );
}

/** Веб-приложение: состояние, тосты, роутер (ссылки /api/ уходят браузеру — APP_LINKS). */
export function App({ deps }: { deps?: AppDeps }) {
  // Одно состояние на всё время жизни приложения.
  const [state] = useState(() => createAppState(deps));
  return (
    <ToastProvider>
      <AppContext.Provider value={state}>
        <LocationProvider scope={APP_LINKS}>
          <Routes />
        </LocationProvider>
      </AppContext.Provider>
    </ToastProvider>
  );
}
