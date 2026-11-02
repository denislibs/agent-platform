import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Minus, Plus, Upload, X } from 'lucide-preact';
import { cx } from '../lib/cx.ts';
import { IconButton } from './button.tsx';
import { Tag } from './chip.tsx';
import { useFieldControl } from './field.tsx';

export interface StepperProps {
  value: number;
  onChange(value: number): void;
  min?: number;
  max?: number;
  step?: number;
  /** Имя поля; внутри `<Field>` можно не задавать. */
  label?: string;
}

export function Stepper({ value, onChange, min = -Infinity, max = Infinity, step = 1, label }: StepperProps) {
  const field = useFieldControl({});
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div class="ui-stepper">
      <button
        type="button"
        aria-label={label ? `Decrease ${label}` : 'Decrease'}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - step))}
      >
        <Minus aria-hidden="true" class="ui-icon-sm" />
      </button>
      <input
        {...field}
        type="number"
        inputMode="numeric"
        aria-label={label}
        value={value}
        min={Number.isFinite(min) ? min : undefined}
        max={Number.isFinite(max) ? max : undefined}
        step={step}
        onChange={event => {
          const typed = event.currentTarget.valueAsNumber;
          const next = Number.isFinite(typed) ? clamp(typed) : value;
          event.currentTarget.value = String(next);
          if (next !== value) onChange(next);
        }}
      />
      <button
        type="button"
        aria-label={label ? `Increase ${label}` : 'Increase'}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + step))}
      >
        <Plus aria-hidden="true" class="ui-icon-sm" />
      </button>
    </div>
  );
}

export interface OtpInputProps {
  /** Цифры кода без пропусков, длина 0…length. */
  value: string;
  onChange(value: string): void;
  onComplete?(value: string): void;
  length?: number;
  /** Разделитель «–» после каждых N ячеек. */
  groupSize?: number;
  label: string;
  disabled?: boolean;
}

/** Код подтверждения: автопереход между ячейками, Backspace назад, вставка всего кода. */
export function OtpInput({ value, onChange, onComplete, length = 6, groupSize = 3, label, disabled }: OtpInputProps) {
  const cells = useRef<Array<HTMLInputElement | null>>([]);
  const focus = (index: number) => cells.current[Math.max(0, Math.min(index, length - 1))]?.focus();

  const fill = (index: number, digits: string) => {
    const start = Math.min(index, value.length);
    const next = (value.slice(0, start) + digits + value.slice(start + digits.length)).slice(0, length);
    if (next !== value) onChange(next);
    focus(start + digits.length);
    if (next.length === length && digits.length > 0) onComplete?.(next);
    return next;
  };

  return (
    <div class="ui-otp" role="group" aria-label={label}>
      {Array.from({ length }, (_, index) => (
        <Fragment key={index}>
          {index > 0 && index % groupSize === 0 && (
            <span class="ui-otp__sep" aria-hidden="true">
              –
            </span>
          )}
          <input
            ref={el => {
              cells.current[index] = el;
            }}
            value={value[index] ?? ''}
            inputMode="numeric"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            aria-label={`Digit ${index + 1} of ${length}`}
            disabled={disabled}
            onInput={event => {
              const el = event.currentTarget;
              const digits = el.value.replace(/\D/g, '');
              // В занятой ячейке остаётся последняя набранная цифра; в пустую может прийти весь код (автозаполнение).
              const typed = value[index] && digits.length > 1 ? digits.slice(-1) : digits;
              const next = typed ? fill(index, typed) : value.slice(0, index) + value.slice(index + 1);
              if (!typed && next !== value) onChange(next);
              el.value = next[index] ?? '';
            }}
            onKeyDown={event => {
              if (event.key === 'Backspace' && !value[index] && index > 0) {
                event.preventDefault();
                onChange(value.slice(0, index - 1));
                focus(index - 1);
              } else if (event.key === 'ArrowLeft') focus(index - 1);
              else if (event.key === 'ArrowRight') focus(index + 1);
            }}
            onPaste={event => {
              event.preventDefault();
              fill(index, (event.clipboardData?.getData('text') ?? '').replace(/\D/g, ''));
            }}
          />
        </Fragment>
      ))}
    </div>
  );
}

export interface TagInputProps {
  values: readonly string[];
  onChange(values: string[]): void;
  /** Имя поля ввода; внутри `<Field>` можно не задавать. */
  label?: string;
  placeholder?: string;
  /** false — значение не добавляется (например, не email). */
  validate?(value: string): boolean;
}

/** Enter или запятая добавляют тег, Backspace в пустом поле удаляет последний. */
export function TagInput({ values, onChange, label, placeholder, validate }: TagInputProps) {
  const field = useFieldControl({});
  const [draft, setDraft] = useState('');
  const add = () => {
    const tag = draft.trim();
    if (!tag || values.includes(tag) || (validate && !validate(tag))) return;
    onChange([...values, tag]);
    setDraft('');
  };
  return (
    <div class="ui-tags">
      {values.map(tag => (
        <Tag key={tag} label={tag} onRemove={() => onChange(values.filter(v => v !== tag))} />
      ))}
      <input
        {...field}
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        onInput={event => setDraft(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            add();
          } else if (event.key === 'Backspace' && draft === '' && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

export interface DropzoneProps {
  onFiles(files: File[]): void;
  accept?: string;
  multiple?: boolean;
  title?: ComponentChildren;
  hint?: ComponentChildren;
  disabled?: boolean;
}

/** Зона загрузки: перетаскивание и выбор через нативный `<input type="file">` внутри `<label>`. */
export function Dropzone({ onFiles, accept, multiple = true, title, hint, disabled }: DropzoneProps) {
  const zone = useRef<HTMLLabelElement>(null);
  const [over, setOver] = useState(false);
  const take = (list: FileList | null | undefined) => {
    const files = [...(list ?? [])];
    if (files.length > 0) onFiles(multiple ? files : files.slice(0, 1));
  };
  useEffect(() => {
    const el = zone.current;
    if (!el || disabled) return;
    const enter = (event: DragEvent) => {
      event.preventDefault();
      setOver(true);
    };
    const leave = (event: DragEvent) => {
      event.preventDefault();
      setOver(false);
    };
    const drop = (event: DragEvent) => {
      leave(event);
      take(event.dataTransfer?.files);
    };
    // Обработчики через addEventListener: у <label> нет роли для перетаскивания в JSX-правилах a11y.
    el.addEventListener('dragenter', enter);
    el.addEventListener('dragover', enter);
    el.addEventListener('dragleave', leave);
    el.addEventListener('drop', drop);
    return () => {
      el.removeEventListener('dragenter', enter);
      el.removeEventListener('dragover', enter);
      el.removeEventListener('dragleave', leave);
      el.removeEventListener('drop', drop);
    };
  });
  return (
    <label ref={zone} class={cx('ui-dropzone', over && 'is-dragover')}>
      <span class="ui-dropzone__icon">
        <Upload aria-hidden="true" />
      </span>
      <b>
        {title ?? (
          <>
            Drop files here or <span class="ui-link">browse</span>
          </>
        )}
      </b>
      {hint && <span class="ui-hint">{hint}</span>}
      <input
        type="file"
        class="ui-sr-only"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={event => {
          take(event.currentTarget.files);
          event.currentTarget.value = '';
        }}
      />
    </label>
  );
}

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↵',
  Backspace: '⌫',
  Delete: '⌦',
};
const MODIFIERS = new Set(['Meta', 'Control', 'Alt', 'Shift']);

/** Комбинация из события клавиатуры: `['⌘', '⇧', 'O']`; `null` — нажат только модификатор. */
export function shortcutFromEvent(event: KeyboardEvent): string[] | null {
  if (MODIFIERS.has(event.key)) return null;
  const key = KEY_NAMES[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return [event.metaKey && '⌘', event.ctrlKey && '⌃', event.altKey && '⌥', event.shiftKey && '⇧', key].filter(
    (part): part is string => Boolean(part),
  );
}

export interface ShortcutInputProps {
  value: readonly string[];
  onChange(keys: string[]): void;
  label: string;
  placeholder?: string;
}

/** Запись шортката: клик — запись (`aria-pressed`), следующая комбинация сохраняется, Esc — отмена. */
export function ShortcutInput({ value, onChange, label, placeholder = 'Not set' }: ShortcutInputProps) {
  const [recording, setRecording] = useState(false);
  return (
    <div class="ui-shortcut">
      <button
        type="button"
        class="ui-shortcut__keys"
        aria-pressed={recording}
        aria-label={recording ? `${label}: press a new shortcut` : `${label}: ${value.join(' ') || placeholder}`}
        onClick={() => setRecording(r => !r)}
        onBlur={() => setRecording(false)}
        onKeyDown={event => {
          if (!recording || event.key === 'Tab') return;
          event.preventDefault();
          if (event.key === 'Escape') return setRecording(false);
          const keys = shortcutFromEvent(event);
          if (!keys) return;
          onChange(keys);
          setRecording(false);
        }}
      >
        {recording ? (
          <span class="ui-shortcut__placeholder">Press keys…</span>
        ) : value.length > 0 ? (
          value.map((key, i) => (
            <kbd key={`${i}-${key}`} class="ui-kbd">
              {key}
            </kbd>
          ))
        ) : (
          <span class="ui-shortcut__placeholder">{placeholder}</span>
        )}
      </button>
      {value.length > 0 && (
        <IconButton
          icon={X}
          label={`Clear ${label}`}
          size="xs"
          class="ui-shortcut__clear"
          onClick={() => onChange([])}
        />
      )}
    </div>
  );
}
