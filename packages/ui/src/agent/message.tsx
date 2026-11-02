import type { ComponentChildren } from 'preact';
import { useId, useState } from 'preact/hooks';
import { ArrowRight, ArrowUp, ChevronRight, CornerDownRight, MessageCircleQuestion } from 'lucide-preact';
import { Button, IconButton } from '../components/button.tsx';
import { StatusDot } from '../components/display.tsx';
import { Input } from '../components/input.tsx';
import { isComposing } from '../lib/ime.ts';
import { safeHref } from '../lib/url.ts';
import { FILE_KIND_ICONS, fileKind, formatDuration, type FileKind } from './format.ts';

export function UserMessage({ children }: { children: ComponentChildren }) {
  return <div class="ui-msg-user">{children}</div>;
}

export interface AgentMessageProps {
  /** Секунды с начала работы (или общее время, когда закончил). */
  elapsed: number;
  working: boolean;
  name?: string;
  /** Знак перед именем (логотип). */
  mark?: ComponentChildren;
  /** Бейдж после имени, например модель. */
  badge?: ComponentChildren;
  /** «Worked for … ›» раскрывает подробности хода работы. */
  onShowDetails?(): void;
  children?: ComponentChildren;
}

/** Ответ агента: шапка, «Working for 12s» → «Worked for 1m 27s ›», содержимое. */
export function AgentMessage({
  elapsed,
  working,
  name = 'agent',
  mark,
  badge,
  onShowDetails,
  children,
}: AgentMessageProps) {
  const time = formatDuration(elapsed);
  return (
    <div class="ui-agent">
      <div class="ui-agent__head">
        {mark}
        <span class="ui-agent__name">{name}</span>
        {badge}
      </div>
      {working ? (
        <span class="ui-agent__meta">Working for {time}</span>
      ) : onShowDetails ? (
        <button type="button" class="ui-agent__meta" onClick={onShowDetails}>
          Worked for {time}
          <ChevronRight aria-hidden="true" class="ui-icon-sm" />
        </button>
      ) : (
        <span class="ui-agent__meta">Worked for {time}</span>
      )}
      {children}
    </div>
  );
}

export function AgentText({ children }: { children: ComponentChildren }) {
  return <div class="ui-agent__text">{children}</div>;
}

/**
 * Индикатор «агент думает»: пульсирующая точка и бегущий блик по тексту. announce={false} — без role="status",
 * когда статус объявляет свой живой регион экрана (иначе скринридер услышит его дважды).
 */
export function Thinking({ label = 'Thinking…', announce = true }: { label?: string; announce?: boolean }) {
  return (
    <span class="ui-thinking" role={announce ? 'status' : undefined}>
      <StatusDot tone="info" pulse />
      <span class="ui-shimmer">{label}</span>
    </span>
  );
}

export interface AskCardProps {
  question: ComponentChildren;
  /** Готовые ответы кнопками. */
  options?: readonly string[];
  onAnswer(answer: string): void;
  heading?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Начальный текст поля: например, ответ, который не ушёл и вернулся пользователю. */
  defaultValue?: string;
}

/** Вопрос агента пользователю (ask_user): варианты ответа и поле для своего. */
export function AskCard({
  question,
  options = [],
  onAnswer,
  heading = 'Your agent needs an answer',
  placeholder = 'Or type your answer…',
  disabled = false,
  defaultValue = '',
}: AskCardProps) {
  const id = useId();
  const headingId = `${id}-ask`;
  const questionId = `${id}-question`;
  const [draft, setDraft] = useState(defaultValue);
  const send = () => {
    const answer = draft.trim();
    if (!answer || disabled) return;
    onAnswer(answer);
    setDraft('');
  };
  return (
    <section class="ui-ask" aria-labelledby={headingId} aria-describedby={questionId}>
      <div class="ui-ask__head" id={headingId}>
        <MessageCircleQuestion aria-hidden="true" class="ui-icon-sm" />
        {heading}
      </div>
      <div class="ui-ask__q" id={questionId}>
        {question}
      </div>
      {options.length > 0 && (
        <div class="ui-ask__options" role="group" aria-labelledby={questionId}>
          {options.map(option => (
            <Button key={option} size="sm" disabled={disabled} onClick={() => onAnswer(option)}>
              {option}
            </Button>
          ))}
        </div>
      )}
      <Input
        // Строковый вопрос входит в имя поля; иначе поле связано с вопросом через описание.
        aria-label={typeof question === 'string' ? `Your answer: ${question}` : 'Your answer'}
        aria-describedby={typeof question === 'string' ? undefined : questionId}
        placeholder={placeholder}
        value={draft}
        disabled={disabled}
        onInput={event => setDraft(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || isComposing(event)) return;
          event.preventDefault();
          send();
        }}
        action={
          <IconButton
            icon={ArrowUp}
            label="Send answer"
            variant="primary"
            pill
            disabled={disabled || !draft.trim()}
            onClick={send}
          />
        }
      />
    </section>
  );
}

export interface FileCardProps {
  name: string;
  /** «Spreadsheet · 394 B». */
  meta?: string;
  /** По умолчанию — по расширению имени. */
  kind?: FileKind;
  /**
   * Ссылка на скачивание. Небезопасные схемы (`javascript:`, `data:`…) пакет отбрасывает (`safeHref`).
   * Без ссылки карточка — кнопка с `onOpen`; без обоих — неинтерактивный блок.
   */
  href?: string;
  onOpen?(): void;
}

export function FileCard({ name, meta, kind, href: hrefProp, onOpen }: FileCardProps) {
  const href = safeHref(hrefProp);
  const resolved = kind ?? fileKind(name);
  const Icon = FILE_KIND_ICONS[resolved];
  const content = (
    <>
      <span class="ui-file__icon" data-kind={resolved === 'other' ? undefined : resolved}>
        <Icon aria-hidden="true" />
      </span>
      <span class="ui-file__body">
        <span class="ui-file__name" title={name}>
          {name}
        </span>
        {meta && <span class="ui-file__meta">{meta}</span>}
      </span>
    </>
  );
  return href ? (
    <a class="ui-file" href={href}>
      {content}
    </a>
  ) : onOpen ? (
    <button type="button" class="ui-file" onClick={onOpen}>
      {content}
    </button>
  ) : (
    <div class="ui-file ui-file--static">{content}</div>
  );
}

/** Предложенный следующий шаг под ответом. */
export function Suggestion({ children, onSelect }: { children: ComponentChildren; onSelect(): void }) {
  return (
    <button type="button" class="ui-suggestion" onClick={onSelect}>
      <CornerDownRight aria-hidden="true" class="ui-icon-sm" />
      {children}
      <ArrowRight aria-hidden="true" class="ui-icon-sm" />
    </button>
  );
}
