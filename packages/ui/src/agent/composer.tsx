import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import { ArrowUp, Square, X, type LucideIcon } from 'lucide-preact';
import { useAutosize } from '../lib/autosize.ts';
import { isComposing } from '../lib/ime.ts';
import { FILE_KIND_ICONS, fileKind } from './format.ts';

export interface ComposerProps {
  value: string;
  onValueChange(value: string): void;
  onSubmit(value: string): void;
  /** Агент работает: вместо отправки — кнопка «стоп». */
  running?: boolean;
  onStop?(): void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Чипы над полем (облако, проект). */
  context?: ComponentChildren;
  /** Вложения (`<Attachment>`). */
  attachments?: ComponentChildren;
  /** Кнопки слева в нижней полосе (прикрепить, инструменты). */
  tools?: ComponentChildren;
  /** Кнопки справа перед отправкой (голос). */
  actions?: ComponentChildren;
}

/** Поле задачи: растёт по содержимому, Enter отправляет, Shift+Enter — новая строка. */
export function Composer({
  value,
  onValueChange,
  onSubmit,
  running = false,
  onStop,
  label = 'Task',
  placeholder = 'Give your agent a task',
  disabled = false,
  context,
  attachments,
  tools,
  actions,
}: ComposerProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  useAutosize(input, value);
  const canSend = !disabled && !running && value.trim().length > 0;
  const submit = () => {
    if (canSend) onSubmit(value.trim());
  };
  return (
    <div class="ui-composer">
      {context && <div class="ui-composer__ctx">{context}</div>}
      {attachments && (
        <div class="ui-composer__attachments" role="list" aria-label="Attachments">
          {attachments}
        </div>
      )}
      <textarea
        ref={input}
        class="ui-composer__input"
        rows={2}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onInput={event => onValueChange(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return;
          event.preventDefault();
          submit();
        }}
      />
      <div class="ui-composer__bar">
        {tools}
        <span class="ui-spacer" />
        {actions}
        {running ? (
          // Без обработчика кнопка «стоп» была бы мёртвой — её нет.
          onStop && (
            <button type="button" class="ui-send" data-state="stop" aria-label="Stop" onClick={onStop}>
              <Square aria-hidden="true" />
            </button>
          )
        ) : (
          <button
            type="button"
            class="ui-send"
            data-state={canSend ? 'ready' : undefined}
            aria-label="Send"
            disabled={!canSend}
            onClick={submit}
          >
            <ArrowUp aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

export interface AttachmentProps {
  name: string;
  /** «Spreadsheet · 84 KB». */
  meta?: string;
  icon?: LucideIcon;
  onRemove?(): void;
}

export function Attachment({ name, meta, icon, onRemove }: AttachmentProps) {
  const Icon = icon ?? FILE_KIND_ICONS[fileKind(name)];
  return (
    <div class="ui-attachment" role="listitem">
      <span class="ui-attachment__thumb">
        <Icon aria-hidden="true" />
      </span>
      <div class="ui-truncate">
        <b class="ui-truncate" title={name}>
          {name}
        </b>
        {meta && <small>{meta}</small>}
      </div>
      {onRemove && (
        <button type="button" class="ui-attachment__remove" aria-label={`Remove ${name}`} onClick={onRemove}>
          <X aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
