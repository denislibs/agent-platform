import type { ComponentChildren, JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { LucideIcon } from 'lucide-preact';
import { cx } from '../lib/cx.ts';
import { useFieldControl } from './field.tsx';

type NativeInputProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'type' | 'label' | 'size' | 'role'>;

export interface CheckboxProps extends NativeInputProps {
  label: ComponentChildren;
  description?: ComponentChildren;
  indeterminate?: boolean;
}

export function Checkbox({ label, description, indeterminate = false, class: className, ...rest }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label class={cx('ui-check', className)}>
      <input {...rest} ref={ref} type="checkbox" class="ui-checkbox" />
      <span>
        {label}
        {description && <small>{description}</small>}
      </span>
    </label>
  );
}

export interface SwitchProps extends Omit<NativeInputProps, 'checked' | 'onChange'> {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  label: string;
  /** Подпись только для скринридера: видимый заголовок стоит в строке настроек. */
  hideLabel?: boolean;
  size?: 'sm' | 'md';
}

/** Для настроек, которые применяются сразу (дизайн-система, «Выбор»). */
export function Switch({
  checked,
  onCheckedChange,
  label,
  hideLabel = false,
  size = 'md',
  class: className,
  ...rest
}: SwitchProps) {
  const input = (
    <input
      {...rest}
      type="checkbox"
      role="switch"
      checked={checked}
      aria-checked={checked}
      onChange={event => onCheckedChange(event.currentTarget.checked)}
      class={cx('ui-switch', size === 'sm' && 'ui-switch--sm', hideLabel && className)}
      aria-label={hideLabel ? label : undefined}
    />
  );
  if (hideLabel) return input;
  return (
    <label class={cx('ui-check', className)}>
      {input}
      <span>{label}</span>
    </label>
  );
}

export interface RadioOption<V extends string> {
  value: V;
  label: ComponentChildren;
  description?: ComponentChildren;
  disabled?: boolean;
}

export interface RadioGroupProps<V extends string> {
  label: string;
  name: string;
  /** Тип значений выводится из списка вариантов. */
  value: NoInfer<V>;
  onChange(value: NoInfer<V>): void;
  options: ReadonlyArray<RadioOption<V>>;
}

/** Нативные радиокнопки: стрелки и Tab работают без JS. */
export function RadioGroup<V extends string>({ label, name, value, onChange, options }: RadioGroupProps<V>) {
  return (
    <div class="ui-radio-group" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <label key={option.value} class="ui-check">
          <input
            type="radio"
            class="ui-radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          <span>
            {option.label}
            {option.description && <small>{option.description}</small>}
          </span>
        </label>
      ))}
    </div>
  );
}

export interface SliderProps extends Omit<NativeInputProps, 'value' | 'min' | 'max' | 'step' | 'onInput' | 'onChange'> {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange(value: number): void;
  /** Текст для скринридера вместо числа, например «6,000 credits». */
  formatValue?(value: number): string;
}

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onValueChange,
  formatValue,
  class: className,
  ...rest
}: SliderProps) {
  const field = useFieldControl(rest);
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      {...rest}
      {...field}
      type="range"
      class={cx('ui-range', className)}
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ '--val': `${percent}%` }}
      aria-valuetext={formatValue?.(value)}
      onInput={event => onValueChange(Number(event.currentTarget.value))}
    />
  );
}

export interface SegmentedOption<V extends string> {
  value: V;
  label?: ComponentChildren;
  icon?: LucideIcon;
  /** Обязателен, если у сегмента только иконка. */
  ariaLabel?: string;
}

export interface SegmentedControlProps<V extends string> {
  label: string;
  /** Тип значений выводится из списка вариантов. */
  value: NoInfer<V>;
  onChange(value: NoInfer<V>): void;
  options: ReadonlyArray<SegmentedOption<V>>;
  block?: boolean;
}

export function SegmentedControl<V extends string>({
  label,
  value,
  onChange,
  options,
  block = false,
}: SegmentedControlProps<V>) {
  return (
    <div class={cx('ui-segmented', block && 'ui-segmented--block')} role="group" aria-label={label}>
      {options.map(({ value: optionValue, label: text, icon: Icon, ariaLabel }) => (
        <button
          key={optionValue}
          type="button"
          aria-pressed={optionValue === value}
          aria-label={ariaLabel}
          onClick={() => onChange(optionValue)}
        >
          {Icon && <Icon aria-hidden="true" />}
          {text}
        </button>
      ))}
    </div>
  );
}

export interface ChoiceOption<V extends string> {
  value: V;
  label: ComponentChildren;
  icon?: LucideIcon;
}

export interface ChoiceGroupProps<V extends string> {
  label: string;
  name: string;
  /** Тип значений выводится из списка вариантов. */
  value: NoInfer<V>;
  onChange(value: NoInfer<V>): void;
  options: ReadonlyArray<ChoiceOption<V>>;
  /** Иконка слева от текста, а не над ним. */
  row?: boolean;
}

/** Карточки выбора (тема, режим, тариф) на нативных радиокнопках. */
export function ChoiceGroup<V extends string>({
  label,
  name,
  value,
  onChange,
  options,
  row = false,
}: ChoiceGroupProps<V>) {
  return (
    <div class="ui-choice-group" role="radiogroup" aria-label={label}>
      {options.map(({ value: optionValue, label: text, icon: Icon }) => (
        <label key={optionValue} class={cx('ui-choice', row && 'ui-choice--row')}>
          <input
            type="radio"
            name={name}
            value={optionValue}
            checked={optionValue === value}
            onChange={() => onChange(optionValue)}
          />
          {Icon && <Icon aria-hidden="true" class="ui-icon-lg" />}
          {text}
        </label>
      ))}
    </div>
  );
}
