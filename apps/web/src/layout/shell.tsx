import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Library, Search, Settings, SquarePen, Trash2 } from 'lucide-preact';
import { Button, ConfirmDialog, CreditBalance, IconButton, Input, TaskItem, cx, useToast } from '@agent/ui';
import { MAX_SEARCH_CHARS, type TaskSummary } from '@agent/shared';
import { useApp } from '../state/app.ts';
import { SEARCH_DEBOUNCE_MS } from '../state/tasks.ts';
import { errorText } from '../view/errors.ts';
import { taskItemStatus } from '../view/status.ts';
import { MAIN_ID } from './page.ts';
import { neighbourOf, removalButton, removalField, useRemovalFocus } from './removal-focus.ts';

/** Название задачи в сайдбаре — первая строка запроса. */
export const taskTitle = (prompt: string): string => prompt.split('\n', 1)[0]!.trim() || 'Untitled task';

function TaskNav() {
  const { tasks } = useApp();
  const { path, route } = useLocation();
  const toast = useToast();
  const [deleting, setDeleting] = useState<TaskSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const focusAfterRemoval = useRemovalFocus('task', deleting === null);
  // Текст поиска живёт дольше экрана: Shell монтируется заново на каждом маршруте, а поиск остаётся в состоянии списка.
  const [searchText, setSearchText] = useState(tasks.query.peek());
  useEffect(() => {
    if (searchText.trim() === tasks.query.peek()) return;
    const timer = setTimeout(() => void tasks.search(searchText), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText, tasks]);
  // Первая страница — один раз на приложение: список живёт в состоянии приложения между экранами.
  useEffect(() => {
    if (tasks.items.peek().length === 0) void tasks.reload();
  }, [tasks]);
  const items = tasks.items.value;

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    const neighbour = neighbourOf(tasks.items.peek(), deleting.id);
    try {
      await tasks.remove(deleting.id);
      toast.show({ tone: 'success', title: 'Task deleted' });
      // Экрану удалённой задачи показывать нечего: route('/') сам переносит фокус в <main>.
      if (path === `/tasks/${deleting.id}`) route('/');
      else focusAfterRemoval(neighbour);
    } catch (err) {
      toast.show({ tone: 'danger', title: 'Could not delete the task', description: errorText(err) });
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  };

  return (
    <nav class="ui-nav ui-shell__nav" aria-label="Tasks">
      <div class="ui-nav-label">Tasks</div>
      <Input
        type="search"
        size="sm"
        icon={Search}
        {...removalField('task')}
        aria-label="Search tasks"
        placeholder="Search tasks"
        maxLength={MAX_SEARCH_CHARS}
        value={searchText}
        onInput={event => setSearchText(event.currentTarget.value)}
      />
      {items.map(task => (
        <TaskItem
          key={task.id}
          title={taskTitle(task.prompt)}
          status={taskItemStatus(task.status)}
          href={`/tasks/${encodeURIComponent(task.id)}`}
          current={path === `/tasks/${task.id}`}
          menu={
            <IconButton
              icon={Trash2}
              label={`Delete task ${taskTitle(task.prompt)}`}
              size="xs"
              {...removalButton('task', task.id)}
              onClick={() => setDeleting(task)}
            />
          }
        />
      ))}
      {items.length === 0 && tasks.error.value && tasks.query.value ? (
        <>
          <p class="ui-hint">Could not search your tasks.</p>
          <Button
            variant="ghost"
            size="sm"
            block
            loading={tasks.loading.value}
            onClick={() => void tasks.search(tasks.query.value)}
          >
            Try again
          </Button>
        </>
      ) : (
        items.length === 0 &&
        tasks.nextCursor.value === null &&
        tasks.loaded.value && (
          <p class="ui-hint" role="status">
            {tasks.query.value ? 'No tasks match your search.' : 'No tasks yet.'}
          </p>
        )
      )}
      {tasks.nextCursor.value !== null && (
        <Button variant="ghost" size="sm" block loading={tasks.loading.value} onClick={() => void tasks.more()}>
          Load more
        </Button>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={open => {
          if (!open) setDeleting(null);
        }}
        title="Delete this task?"
        description="The task and its files will be deleted. This cannot be undone."
        confirmLabel="Delete"
        busy={busy}
        onConfirm={() => void confirmDelete()}
      />
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

/** Оболочка экранов после входа: сайдбар (новая задача, Library, задачи, баланс, настройки), <main>, панель компьютера. */
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
        <a class="ui-nav-item" href="/library" aria-current={path === '/library' ? 'page' : undefined}>
          <Library aria-hidden="true" />
          Library
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
