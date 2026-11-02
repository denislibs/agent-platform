import type { ComponentChildren, JSX } from 'preact';
import { forwardRef } from 'preact/compat';
import type { LucideIcon } from 'lucide-preact';
import { cx } from '../lib/cx.ts';

export type ButtonVariant =
  'primary' | 'secondary' | 'outline' | 'ghost' | 'inverted' | 'danger' | 'danger-outline' | 'danger-ghost' | 'link';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'icon' | 'size'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Иконка Lucide перед текстом. */
  icon?: LucideIcon;
  block?: boolean;
  pill?: boolean;
  /** Спиннер вместо текста (`aria-busy`); нажатия, в том числе Enter, игнорируются. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon: Icon,
    block = false,
    pill = false,
    loading = false,
    type = 'button',
    class: className,
    onClick,
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      class={cx(
        'ui-btn',
        `ui-btn--${variant}`,
        size !== 'md' && `ui-btn--${size}`,
        block && 'ui-btn--block',
        pill && 'ui-btn--pill',
        className,
      )}
      aria-busy={loading || undefined}
      onClick={event => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {Icon && <Icon aria-hidden="true" />}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'children' | 'block'> {
  icon: LucideIcon;
  /** Доступное имя кнопки (`aria-label`): у иконочной кнопки нет текста. */
  label: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = 'ghost', size = 'sm', class: className, ...rest },
  ref,
) {
  return (
    <Button
      {...rest}
      ref={ref}
      icon={icon}
      variant={variant}
      size={size}
      aria-label={label}
      class={cx('ui-btn--icon', className)}
    />
  );
});

export function ButtonGroup({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="ui-btn-group" role="group" aria-label={label}>
      {children}
    </div>
  );
}
