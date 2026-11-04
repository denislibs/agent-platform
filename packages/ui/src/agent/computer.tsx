import type { ComponentChildren } from 'preact';
import { ExternalLink, Maximize2, Monitor, Play, SkipBack, SkipForward, Sparkles, X } from 'lucide-preact';
import { Button, IconButton } from '../components/button.tsx';
import { Progress } from '../components/display.tsx';
import { safeHref } from '../lib/url.ts';

export interface ComputerFrame {
  /** Адрес сайта; небезопасные схемы пакет отбрасывает (`safeHref`), и панель остаётся обычной. */
  src: string;
  /** Доступное имя фрейма. */
  title: string;
  /** Другой ключ — новый фрейм: сайт загружается заново. */
  reloadKey: string;
}

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
  /** Содержимое шапки справа от заголовка: переключатель вида, ссылки. */
  actions?: ComponentChildren;
  /** Сайт во фрейме вместо снимка, строки состояния и таймлайна. */
  frame?: ComputerFrame;
}

/** Ссылка на сайт агента: новая вкладка без opener и Referer, небезопасный адрес не показывается. */
export function OpenInNewTab({ href, children = 'Open in new tab' }: { href: string; children?: ComponentChildren }) {
  const safe = safeHref(href);
  if (!safe) return null;
  return (
    <a class="ui-btn ui-btn--ghost ui-btn--xs" href={safe} target="_blank" rel="noopener noreferrer">
      <ExternalLink aria-hidden="true" />
      {children}
    </a>
  );
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
  actions,
  frame,
}: ComputerPanelProps) {
  // NaN — это «нет данных»: показываем конец ленты, а не ломаем aria-valuenow.
  const value = Number.isNaN(position) ? 100 : Math.min(Math.max(position, 0), 100);
  const frameSrc = safeHref(frame?.src);
  return (
    <section class="ui-computer" aria-label={title}>
      <div class="ui-computer__tabs">
        <div class="ui-computer__tab">
          <Monitor aria-hidden="true" class="ui-icon-sm" />
          {title}
        </div>
        <span class="ui-spacer" />
        {actions}
        {onExpand && <IconButton icon={Maximize2} label="Expand" onClick={onExpand} />}
        {onClose && <IconButton icon={X} label="Close" onClick={onClose} />}
      </div>
      {frame && frameSrc ? (
        /*
         * allow-same-origin намеренно: без него localStorage бросает исключение, и обычное React-приложение падает. Здесь
         * это безопасно: origin сайта — отдельный хост задачи и никогда не origin приложения, поэтому сайт получает доступ
         * только к самому себе. Без allow-top-navigation и allow-popups: сайт не уводит вкладку и не открывает окна.
         */
        <iframe
          key={frame.reloadKey}
          class="ui-computer__frame"
          src={frameSrc}
          title={frame.title}
          // oxlint-disable-next-line react/iframe-missing-sandbox
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
          referrerpolicy="no-referrer"
        />
      ) : (
        <>
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
              onJumpToLive && (
                <Button variant="ghost" size="xs" icon={Play} onClick={onJumpToLive}>
                  Jump to live
                </Button>
              )
            )}
          </div>
        </>
      )}
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
  // Без деления: сравнение «десять частей против всего» не копит ошибку округления.
  const low = total !== undefined && total > 0 && value * 10 <= total;
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
