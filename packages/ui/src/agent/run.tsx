import type { ComponentChildren } from 'preact';
import { useId, useState } from 'preact/hooks';
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  MessageCircleQuestion,
  MessageSquare,
  Wrench,
  type LucideIcon,
} from 'lucide-preact';
import { Spinner } from '../components/display.tsx';
import { cx } from '../lib/cx.ts';
import { TOOL_ICONS } from './format.ts';

/** Статус строки плана. Перевод статусов подзадач ядра — в веб-приложении (план 6). */
export type PlanStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface PlanItem {
  id: string;
  title: string;
  description?: string;
  status: PlanStatus;
}

const PLAN_STATUS_TEXT: Record<PlanStatus, string> = {
  pending: 'Pending',
  running: 'In progress',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
};

/** План подзадач: маркер статуса слева, текущая подзадача — `aria-current="step"`. */
export function PlanList({ items, label = 'Plan' }: { items: readonly PlanItem[]; label?: string }) {
  return (
    <div class="ui-timeline" role="list" aria-label={label}>
      {items.map(item => (
        <div
          key={item.id}
          class="ui-timeline__item"
          role="listitem"
          data-status={item.status}
          aria-current={item.status === 'running' ? 'step' : undefined}
        >
          <span class="ui-timeline__marker" aria-hidden="true" />
          <div>
            <div class="ui-timeline__title">
              <span class="ui-sr-only">{PLAN_STATUS_TEXT[item.status]}: </span>
              {item.title}
            </div>
            {item.description && (
              <div class={cx('ui-timeline__desc', item.status === 'running' && 'ui-shimmer')}>{item.description}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export interface StepGroupProps {
  /** «Searched 3 queries · Browsed 5 pages». */
  summary: string;
  /** Управляемый режим; без него группа помнит состояние сама. */
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?(expanded: boolean): void;
  children: ComponentChildren;
}

/** Группа шагов, свёрнутая в строку-сводку (дизайн-система, «Сводка → подробности»). */
export function StepGroup({ summary, expanded, defaultExpanded = true, onExpandedChange, children }: StepGroupProps) {
  const listId = `${useId()}-steps`;
  const [own, setOwn] = useState(defaultExpanded);
  const open = expanded ?? own;
  return (
    <div class="ui-steps">
      <button
        type="button"
        class="ui-steps__summary"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setOwn(!open);
          onExpandedChange?.(!open);
        }}
      >
        <span>{summary}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      <div id={listId} class="ui-steps__list" role="list">
        {children}
      </div>
    </div>
  );
}

export interface StepProps {
  /** Имя инструмента агента: от него зависит иконка. */
  tool?: string;
  icon?: LucideIcon;
  children: string;
  /** «0:42». */
  time?: string;
  /** Текущий шаг — с бегущим бликом. */
  active?: boolean;
  error?: boolean;
}

export function Step({ tool, icon, children, time, active = false, error = false }: StepProps) {
  // Поиск по таблице, а не вызов toolIcon(): компонент не должен «создаваться» во время рендера.
  const Icon = icon ?? (tool ? TOOL_ICONS[tool] : undefined) ?? Wrench;
  return (
    <div class={cx('ui-step', error && 'ui-step--error')} role="listitem">
      <Icon aria-hidden="true" />
      <span class={cx(active && 'ui-shimmer')} title={children}>
        {children}
      </span>
      {time && <span class="ui-step__time">{time}</span>}
    </div>
  );
}

export type TaskItemStatus = 'running' | 'waiting' | 'done' | 'failed' | 'idle';

const TASK_STATUS: Record<Exclude<TaskItemStatus, 'running'>, [LucideIcon, string]> = {
  waiting: [MessageCircleQuestion, 'needs your answer'],
  done: [CircleCheck, 'completed'],
  failed: [CircleAlert, 'failed'],
  idle: [MessageSquare, 'idle'],
};

export interface TaskItemProps {
  title: string;
  status: TaskItemStatus;
  href: string;
  /** Открытая сейчас задача. */
  current?: boolean;
  /** Меню задачи (появляется при наведении). */
  menu?: ComponentChildren;
}

/** Задача в сайдбаре: статус слева, название-ссылка, меню при наведении. */
export function TaskItem({ title, status, href, current = false, menu }: TaskItemProps) {
  const [Icon, text] = status === 'running' ? [null, 'running'] : TASK_STATUS[status];
  return (
    <div class="ui-task-item">
      <span class="ui-task-item__status" data-status={status} aria-hidden="true">
        {Icon ? <Icon class="ui-icon-lg" /> : <Spinner size="sm" tone="info" />}
      </span>
      <a class="ui-task-item__title" href={href} aria-current={current ? 'page' : undefined}>
        {title}
        <span class="ui-sr-only">, {text}</span>
      </a>
      {menu}
    </div>
  );
}
