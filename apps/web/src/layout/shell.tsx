import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Settings, SquarePen } from 'lucide-preact';
import { Button, CreditBalance, TaskItem, cx } from '@agent/ui';
import { useApp } from '../state/app.ts';
import { taskItemStatus } from '../view/status.ts';
import { MAIN_ID } from './page.ts';

/** Название задачи в сайдбаре — первая строка запроса. */
export const taskTitle = (prompt: string): string => prompt.split('\n', 1)[0]!.trim() || 'Untitled task';

function TaskNav() {
  const { tasks } = useApp();
  const { path } = useLocation();
  // Первая страница — один раз на приложение: список живёт в состоянии приложения между экранами.
  useEffect(() => {
    if (tasks.items.peek().length === 0) void tasks.reload();
  }, [tasks]);
  const items = tasks.items.value;
  return (
    <nav class="ui-nav ui-shell__nav" aria-label="Tasks">
      <div class="ui-nav-label">Tasks</div>
      {items.map(task => (
        <TaskItem
          key={task.id}
          title={taskTitle(task.prompt)}
          status={taskItemStatus(task.status)}
          href={`/tasks/${encodeURIComponent(task.id)}`}
          current={path === `/tasks/${task.id}`}
        />
      ))}
      {items.length === 0 && tasks.loaded.value && <p class="ui-hint">No tasks yet.</p>}
      {tasks.nextCursor.value !== null && (
        <Button variant="ghost" size="sm" block loading={tasks.loading.value} onClick={() => void tasks.more()}>
          Load more
        </Button>
      )}
    </nav>
  );
}

function Account() {
  const { session } = useApp();
  const { path } = useLocation();
  const balance = session.me.value?.balance;
  return (
    <div class="ui-shell__account">
      {balance && (
        <CreditBalance
          value={balance.millicredits / 1000}
          // Строка из API: без плавающей точки (formatCredits), число — только для полосы.
          format={() => balance.credits}
          hint={balance.millicredits <= 0 ? 'Out of credits: new tasks will not start.' : undefined}
        />
      )}
      <a class="ui-nav-item" href="/settings" aria-current={path === '/settings' ? 'page' : undefined}>
        <Settings aria-hidden="true" />
        Settings
      </a>
    </div>
  );
}

export interface ShellProps {
  children: ComponentChildren;
  /** Панель компьютера справа (экран задачи). */
  computer?: ComponentChildren;
}

/** Оболочка экранов после входа: сайдбар (новая задача, задачи, баланс, настройки), <main>, панель компьютера. */
export function Shell({ children, computer }: ShellProps) {
  const { path } = useLocation();
  return (
    <div class={cx('ui-shell', computer && 'ui-shell--computer')}>
      <a class="ui-skip-link" href={`#${MAIN_ID}`}>
        Skip to content
      </a>
      <aside class="ui-shell__side" aria-label="Sidebar">
        <a class="ui-brand" href="/">
          <span class="ui-mark ui-mark--sm" />
          agent
        </a>
        <a class="ui-nav-item" href="/" aria-current={path === '/' ? 'page' : undefined}>
          <SquarePen aria-hidden="true" />
          New task
        </a>
        <TaskNav />
        <Account />
      </aside>
      <main id={MAIN_ID} class="ui-shell__main" tabIndex={-1}>
        {children}
      </main>
      {computer}
    </div>
  );
}
