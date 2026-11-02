import { createContext, type ComponentChildren } from 'preact';
import { useContext, useId, useLayoutEffect, useState } from 'preact/hooks';
import { CircleAlert } from 'lucide-preact';

interface FieldContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
  /** Контрол с собственным id сообщает его полю, чтобы `<label for>` и id сообщений не разошлись. */
  registerId(id: string | undefined): void;
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
 * `aria-describedby`, `aria-invalid` при ошибке. Явный id контрола важнее поля (поле
 * подхватывает его для `<label for>`). Возвращает только заданные атрибуты, чтобы
 * спред после пропсов потребителя не затирал его `aria-*` значением `undefined`.
 */
export function useFieldControl(props: {
  id?: unknown;
  'aria-describedby'?: unknown;
  'aria-invalid'?: unknown;
}): FieldControlProps {
  const field = useContext(FieldContext);
  const ownId = own(props.id);
  const registerId = field?.registerId;
  useLayoutEffect(() => {
    if (!registerId || !ownId) return;
    registerId(ownId);
    return () => registerId(undefined);
  }, [registerId, ownId]);
  const describedBy = [own(props['aria-describedby']), field?.describedBy].filter(Boolean).join(' ');
  const invalid = props['aria-invalid'] === true || props['aria-invalid'] === 'true' || field?.invalid === true;
  const result: FieldControlProps = {};
  const id = ownId ?? field?.id;
  if (id) result.id = id;
  if (describedBy) result['aria-describedby'] = describedBy;
  if (invalid) result['aria-invalid'] = true;
  return result;
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
  const [registeredId, registerId] = useState<string>();
  const controlId = registeredId ?? id ?? `ui-field-${autoId}`;
  const messageId = `${controlId}-message`;
  const message = error ? (
    <span class="ui-error" id={messageId} role="alert">
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
        value={{ id: controlId, describedBy: message ? messageId : undefined, invalid: Boolean(error), registerId }}
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
