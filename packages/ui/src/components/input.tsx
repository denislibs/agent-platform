import type { ComponentChildren, JSX } from 'preact';
import { forwardRef } from 'preact/compat';
import { useRef } from 'preact/hooks';
import type { LucideIcon } from 'lucide-preact';
import { fitToContent, useAutosize } from '../lib/autosize.ts';
import { cx } from '../lib/cx.ts';
import { useMergedRefs } from '../lib/refs.ts';
import { useFieldControl } from './field.tsx';

export interface InputProps extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'size' | 'icon' | 'prefix'> {
  size?: 'sm' | 'md' | 'lg';
  filled?: boolean;
  /** Иконка слева внутри поля (поиск). */
  icon?: LucideIcon;
  /** Неизменяемые части значения слева и справа: «https://», «.agent.app». */
  prefix?: string;
  suffix?: string;
  /** Подсказка-клавиша справа, например «/». */
  kbd?: string;
  /** Кнопки справа внутри поля: показать пароль, копировать, отправить. */
  action?: ComponentChildren;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', filled = false, icon: Icon, prefix, suffix, kbd, action, class: classProp, className, ...rest },
  ref,
) {
  const field = useFieldControl(rest);
  const input = (
    <input
      {...rest}
      {...field}
      ref={ref}
      class={cx('ui-input', size !== 'md' && `ui-input--${size}`, filled && 'ui-input--filled', className, classProp)}
    />
  );
  if (!Icon && !prefix && !suffix && !kbd && !action) return input;
  return (
    <div class="ui-input-group">
      {prefix && <span class="ui-input-group__addon">{prefix}</span>}
      {Icon && (
        <span class="ui-input-group__icon">
          <Icon aria-hidden="true" />
        </span>
      )}
      {input}
      {suffix && <span class="ui-input-group__addon">{suffix}</span>}
      {kbd && (
        <span class="ui-input-group__kbd">
          <kbd class="ui-kbd">{kbd}</kbd>
        </span>
      )}
      {action && <span class="ui-input-group__action">{action}</span>}
    </div>
  );
});

export interface TextareaProps extends JSX.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Растягивать по содержимому. */
  autosize?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { autosize = false, class: classProp, className, value, onInput, ...rest },
  ref,
) {
  const own = useRef<HTMLTextAreaElement>(null);
  const field = useFieldControl(rest);
  useAutosize(own, value, autosize);
  const merged = useMergedRefs(ref, own);
  return (
    <textarea
      {...rest}
      {...field}
      value={value}
      ref={merged}
      class={cx('ui-textarea', className, classProp)}
      onInput={event => {
        // Неуправляемое поле: значение не приходит пропсом, подгоняем высоту по вводу.
        if (autosize) fitToContent(event.currentTarget);
        onInput?.(event);
      }}
    />
  );
});

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface NativeSelectProps extends Omit<JSX.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  options: readonly SelectOption[];
  size?: 'sm' | 'md';
  filled?: boolean;
}

/** Нативный `<select>`: для простых списков без описаний опций. */
export function NativeSelect({
  options,
  size = 'md',
  filled = false,
  class: classProp,
  className,
  ...rest
}: NativeSelectProps) {
  const field = useFieldControl(rest);
  return (
    <select
      {...rest}
      {...field}
      class={cx('ui-select', size === 'sm' && 'ui-select--sm', filled && 'ui-select--filled', className, classProp)}
    >
      {options.map(option => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
