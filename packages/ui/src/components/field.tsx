import { createContext, type ComponentChildren } from 'preact';
import { useContext, useId } from 'preact/hooks';
import { CircleAlert } from 'lucide-preact';

interface FieldContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldControlProps {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

const own = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/**
 * Атрибуты контрола внутри `<Field>`: id для `<label for>`, подсказка или ошибка в
 * `aria-describedby`, `aria-invalid` при ошибке. Явные пропсы контрола важнее поля.
 */
export function useFieldControl(props: {
  id?: unknown;
  'aria-describedby'?: unknown;
  'aria-invalid'?: unknown;
}): FieldControlProps {
  const field = useContext(FieldContext);
  const describedBy = [own(props['aria-describedby']), field?.describedBy].filter(Boolean).join(' ');
  const invalid = props['aria-invalid'] === true || props['aria-invalid'] === 'true' || field?.invalid === true;
  return {
    id: own(props.id) ?? field?.id,
    'aria-describedby': describedBy || undefined,
    'aria-invalid': invalid || undefined,
  };
}

export interface FieldProps {
  label: ComponentChildren;
  hint?: ComponentChildren;
  /** Текст ошибки; при ошибке подсказка не показывается, контрол получает aria-invalid. */
  error?: ComponentChildren;
  optional?: boolean;
  /** Счётчик справа под полем, например «12 / 300». */
  counter?: string;
  id?: string;
  children: ComponentChildren;
}

export function Field({ label, hint, error, optional = false, counter, id, children }: FieldProps) {
  const autoId = useId();
  const controlId = id ?? `ui-field-${autoId}`;
  const messageId = `${controlId}-message`;
  const message = error ? (
    <span class="ui-error" id={messageId}>
      <CircleAlert aria-hidden="true" class="ui-icon-sm" />
      {error}
    </span>
  ) : hint ? (
    <span class="ui-hint" id={messageId}>
      {hint}
    </span>
  ) : null;
  return (
    <div class="ui-field">
      <label class="ui-label" for={controlId}>
        {label}
        {optional && <span class="ui-label__opt">Optional</span>}
      </label>
      <FieldContext.Provider
        value={{ id: controlId, describedBy: message ? messageId : undefined, invalid: Boolean(error) }}
      >
        {children}
      </FieldContext.Provider>
      {counter === undefined ? (
        message
      ) : (
        <div class="ui-field__foot">
          {message}
          <span class="ui-counter">{counter}</span>
        </div>
      )}
    </div>
  );
}
