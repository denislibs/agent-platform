import type { ComponentChildren } from 'preact';
import { CircleCheck, CircleX, Info, TriangleAlert, type LucideIcon } from 'lucide-preact';
import { cx } from '../lib/cx.ts';
import type { StatusTone } from './display.tsx';

const TONE_ICON: Record<'neutral' | StatusTone, LucideIcon> = {
  neutral: Info,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleX,
};

export interface AlertProps {
  tone?: 'neutral' | StatusTone;
  title?: string;
  icon?: LucideIcon;
  actions?: ComponentChildren;
  /** Появилось в ответ на событие: озвучить (`role="alert"` для warning/danger, иначе `status`). */
  live?: boolean;
  children?: ComponentChildren;
}

export function Alert({ tone = 'neutral', title, icon, actions, live = false, children }: AlertProps) {
  const Icon = icon ?? TONE_ICON[tone];
  const role = live ? (tone === 'danger' || tone === 'warning' ? 'alert' : 'status') : undefined;
  return (
    <div class={cx('ui-alert', tone !== 'neutral' && `ui-alert--${tone}`)} role={role}>
      <span class="ui-alert__icon">
        <Icon aria-hidden="true" />
      </span>
      <div class="ui-alert__body">
        {title && <b class="ui-alert__title">{title}</b>}
        {children && <span class={cx(title && 'ui-alert__desc')}>{children}</span>}
      </div>
      {actions && <div class="ui-alert__actions">{actions}</div>}
    </div>
  );
}

export function Banner({ icon: Icon, children }: { icon?: LucideIcon; children: ComponentChildren }) {
  return (
    <div class="ui-banner">
      {Icon && <Icon aria-hidden="true" class="ui-icon-sm" />}
      {children}
    </div>
  );
}

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: ComponentChildren;
  actions?: ComponentChildren;
  /** Заголовок этого уровня вместо текста — когда пустое состояние и есть страница (вид тот же). */
  heading?: 1 | 2 | 3 | 4 | 5 | 6;
}

export function EmptyState({ icon: Icon, title, description, actions, heading }: EmptyStateProps) {
  const Title = heading ? (`h${heading}` as const) : 'span';
  return (
    <div class="ui-empty">
      <span class="ui-empty__icon">
        <Icon aria-hidden="true" class="ui-icon-xl" />
      </span>
      <Title class="ui-empty__title">{title}</Title>
      {description && <span class="ui-empty__desc">{description}</span>}
      {actions && <div class="ui-empty__actions">{actions}</div>}
    </div>
  );
}
