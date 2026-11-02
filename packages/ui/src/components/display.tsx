import type { ComponentChildren } from 'preact';
import type { LucideIcon } from 'lucide-preact';
import { cx } from '../lib/cx.ts';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info';
export type BadgeTone = 'neutral' | 'accent' | StatusTone;

export interface BadgeProps {
  tone?: BadgeTone;
  /** soft — заливка тона, outline — контур, solid — заливка акцентом (счётчики, тариф). */
  variant?: 'soft' | 'outline' | 'solid';
  pill?: boolean;
  /** Круглый счётчик с табличными цифрами. */
  count?: boolean;
  icon?: LucideIcon;
  children: ComponentChildren;
}

export function Badge({
  tone = 'neutral',
  variant = 'soft',
  pill = false,
  count = false,
  icon: Icon,
  children,
}: BadgeProps) {
  return (
    <span
      class={cx(
        'ui-badge',
        variant === 'soft' && tone !== 'neutral' && `ui-badge--${tone}`,
        variant === 'outline' && 'ui-badge--outline',
        variant === 'solid' && 'ui-badge--solid',
        pill && 'ui-badge--pill',
        count && 'ui-badge--count',
      )}
    >
      {Icon && <Icon aria-hidden="true" />}
      {children}
    </span>
  );
}

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/** Инициалы для аватара: первые буквы двух первых слов, «?» для пустого имени. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return words
    .slice(0, 2)
    .map(word => [...word][0]!.toUpperCase())
    .join('');
}

export interface AvatarProps {
  name: string;
  src?: string;
  size?: AvatarSize;
  square?: boolean;
  /** Зелёная точка «в сети». */
  online?: boolean;
}

export function Avatar({ name, src, size = 'md', square = false, online = false }: AvatarProps) {
  return (
    <span
      class={cx('ui-avatar', size !== 'md' && `ui-avatar--${size}`, square && 'ui-avatar--square')}
      role="img"
      aria-label={name}
    >
      {src ? <img src={src} alt="" /> : <span aria-hidden="true">{initials(name)}</span>}
      {online && <span class="ui-avatar__status" />}
    </span>
  );
}

export interface AvatarGroupProps {
  people: Array<{ name: string; src?: string }>;
  /** Сколько аватаров показать; остальные — «+N». */
  max?: number;
  size?: AvatarSize;
  label: string;
}

export function AvatarGroup({ people, max = 3, size = 'sm', label }: AvatarGroupProps) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span class="ui-avatar-group" role="group" aria-label={label}>
      {shown.map(person => (
        <Avatar key={person.name} name={person.name} src={person.src} size={size} />
      ))}
      {rest > 0 && (
        <span class={cx('ui-avatar', size !== 'md' && `ui-avatar--${size}`)} role="img" aria-label={`${rest} more`}>
          <span aria-hidden="true">+{rest}</span>
        </span>
      )}
    </span>
  );
}

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  tone?: 'neutral' | 'accent' | 'info';
  /** Без подписи спиннер декоративный (aria-hidden), с подписью — `role="status"`. */
  label?: string;
}

export function Spinner({ size = 'md', tone = 'neutral', label }: SpinnerProps) {
  return (
    <span
      class={cx('ui-spinner', size !== 'md' && `ui-spinner--${size}`, tone !== 'neutral' && `ui-spinner--${tone}`)}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export interface SkeletonProps {
  variant?: 'block' | 'text' | 'circle';
  width?: string | number;
  height?: string | number;
}

export function Skeleton({ variant = 'block', width, height }: SkeletonProps) {
  return (
    <div
      class={cx('ui-skeleton', variant !== 'block' && `ui-skeleton--${variant}`)}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}

export interface ProgressProps {
  /** Доступное имя полосы. */
  label: string;
  value?: number;
  max?: number;
  tone?: 'accent' | StatusTone;
  size?: 'sm' | 'md';
  indeterminate?: boolean;
}

export function Progress({
  label,
  value = 0,
  max = 100,
  tone = 'accent',
  size = 'md',
  indeterminate = false,
}: ProgressProps) {
  const clamped = Math.min(Math.max(value, 0), max);
  const percent = max > 0 ? (clamped / max) * 100 : 0;
  return (
    <div
      class={cx(
        'ui-progress',
        size === 'sm' && 'ui-progress--sm',
        tone !== 'accent' && `ui-progress--${tone}`,
        indeterminate && 'ui-progress--indeterminate',
      )}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={indeterminate ? undefined : clamped}
      style={indeterminate ? undefined : { '--val': `${percent}%` }}
    />
  );
}

export interface StatusDotProps {
  tone?: 'neutral' | 'accent' | StatusTone;
  /** Пульсация — только для индикаторов работы. */
  pulse?: boolean;
  /** Без подписи точка декоративная: рядом обычно есть текст статуса. */
  label?: string;
}

export function StatusDot({ tone = 'neutral', pulse = false, label }: StatusDotProps) {
  return (
    <span
      class={cx('ui-dot', tone !== 'neutral' && `ui-dot--${tone}`, pulse && 'ui-dot--pulse')}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="ui-kbd">{children}</kbd>;
}

export function KbdCombo({ keys }: { keys: readonly string[] }) {
  return (
    <span class="ui-kbd-combo">
      {keys.map((key, i) => (
        <kbd key={`${i}-${key}`} class="ui-kbd">
          {key}
        </kbd>
      ))}
    </span>
  );
}
