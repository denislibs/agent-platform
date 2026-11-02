import type { ComponentChildren } from 'preact';
import { X, type LucideIcon } from 'lucide-preact';
import { cx } from '../lib/cx.ts';

export interface ChipProps {
  /** С `pressed` чип — переключатель-фильтр (`aria-pressed`), без него — обычная кнопка. */
  pressed?: boolean;
  onPressedChange?(pressed: boolean): void;
  onClick?(): void;
  ghost?: boolean;
  icon?: LucideIcon;
  children: ComponentChildren;
}

export function Chip({ pressed, onPressedChange, onClick, ghost = false, icon: Icon, children }: ChipProps) {
  return (
    <button
      type="button"
      class={cx('ui-chip', ghost && 'ui-chip--ghost')}
      aria-pressed={pressed}
      onClick={() => {
        if (pressed !== undefined) onPressedChange?.(!pressed);
        onClick?.();
      }}
    >
      {Icon && <Icon aria-hidden="true" class="ui-icon-sm" />}
      {children}
    </button>
  );
}

export interface TagProps {
  label: string;
  /** Без обработчика тег не удаляется и кнопки нет. */
  onRemove?(): void;
}

export function Tag({ label, onRemove }: TagProps) {
  return (
    <span class="ui-tag">
      {label}
      {onRemove && (
        <button type="button" aria-label={`Remove ${label}`} onClick={onRemove}>
          <X aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
