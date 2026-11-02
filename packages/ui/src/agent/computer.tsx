import type { ComponentChildren } from 'preact';
import { Maximize2, Monitor, Play, SkipBack, SkipForward, Sparkles, X } from 'lucide-preact';
import { Button, IconButton } from '../components/button.tsx';
import { Progress } from '../components/display.tsx';

export interface ComputerPanelProps {
  title?: string;
  /** «Using Browser», «Using Terminal». */
  activity?: string;
  /** Адрес страницы или путь файла. */
  detail?: string;
  /** Снимок экрана: Markdown страницы или файл моноширинным. */
  children?: ComponentChildren;
  /** Положение в ленте шагов, 0–100. */
  position?: number;
  /** Показывается последний шаг. */
  live?: boolean;
  onPrevious?(): void;
  onNext?(): void;
  onJumpToLive?(): void;
  onExpand?(): void;
  onClose?(): void;
}

/** Панель «компьютера агента»: вкладка, строка состояния, снимок и таймлайн перемотки. */
export function ComputerPanel({
  title = "Agent's computer",
  activity,
  detail,
  children,
  position = 100,
  live = true,
  onPrevious,
  onNext,
  onJumpToLive,
  onExpand,
  onClose,
}: ComputerPanelProps) {
  const value = Math.min(Math.max(position, 0), 100);
  return (
    <section class="ui-computer" aria-label={title}>
      <div class="ui-computer__tabs">
        <div class="ui-computer__tab">
          <Monitor aria-hidden="true" class="ui-icon-sm" />
          {title}
        </div>
        <span class="ui-spacer" />
        {onExpand && <IconButton icon={Maximize2} label="Expand" onClick={onExpand} />}
        {onClose && <IconButton icon={X} label="Close" onClick={onClose} />}
      </div>
      {activity && (
        <div class="ui-computer__status">
          <b>{activity}</b>
          {detail}
        </div>
      )}
      {/* Прокручиваемая область должна быть доступна с клавиатуры. */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div class="ui-computer__body" role="region" aria-label={`${title}: screen`} tabIndex={0}>
        {children}
      </div>
      <div class="ui-computer__foot">
        <IconButton icon={SkipBack} label="Previous step" size="xs" disabled={!onPrevious} onClick={onPrevious} />
        <IconButton icon={SkipForward} label="Next step" size="xs" disabled={!onNext} onClick={onNext} />
        <div
          class="ui-timeline-bar"
          role="progressbar"
          aria-label="Replay position"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(value)}
        >
          <i style={{ '--val': `${value}%` }} />
        </div>
        {live ? (
          <span class="ui-live">Live</span>
        ) : (
          <Button variant="ghost" size="xs" icon={Play} onClick={onJumpToLive}>
            Jump to live
          </Button>
        )}
      </div>
    </section>
  );
}

export interface CreditBalanceProps {
  value: number;
  /** Объём, от которого считается полоса. Без него полосы нет. */
  total?: number;
  label?: string;
  hint?: ComponentChildren;
  format?(value: number): string;
}

const formatCreditValue = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 3 });

/** Баланс кредитов: «996 / 1,300», полоса (жёлтая, когда осталось ≤ 10 %) и подсказка. */
export function CreditBalance({
  value,
  total,
  label = 'Credits',
  hint,
  format = formatCreditValue,
}: CreditBalanceProps) {
  const low = total !== undefined && total > 0 && value / total <= 0.1;
  return (
    <div class="ui-meter">
      <div class="ui-meter__head">
        <span class="ui-label">
          <Sparkles aria-hidden="true" class="ui-icon-sm" />
          {label}
        </span>
        <span class="ui-meter__value">
          {format(value)}
          {total !== undefined && <small> / {format(total)}</small>}
        </span>
      </div>
      {total !== undefined && <Progress label={label} value={value} max={total} tone={low ? 'warning' : 'accent'} />}
      {hint && <span class="ui-hint">{hint}</span>}
    </div>
  );
}
