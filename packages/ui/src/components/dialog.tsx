import type { ComponentChildren } from 'preact';
import { useId, useMemo, useState } from 'preact/hooks';
import { Trash2, X, type LucideIcon } from 'lucide-preact';
import { cx } from '../lib/cx.ts';
import { useDismiss } from '../lib/dismiss.ts';
import { useFocusTrap, useScrollLock } from '../lib/focus.ts';
import { Portal, PortalContext } from '../lib/portal.tsx';
import { usePresence } from '../lib/presence.ts';
import { DURATION_MS } from '../tokens.ts';
import { Button, IconButton } from './button.tsx';

/** Элемент-слой: state, а не ref — он нужен PortalContext при рендере детей. */
function useLayer() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const ref = useMemo(() => ({ current: element }), [element]);
  return [ref, setElement] as const;
}

export interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ComponentChildren;
  description?: ComponentChildren;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** Заголовок шрифтом Instrument Serif (тарифы, промо). */
  serifTitle?: boolean;
  /** alertdialog — подтверждение: без крестика, клик снаружи не закрывает. */
  role?: 'dialog' | 'alertdialog';
  /** Над заголовком, например иконка опасного действия. */
  icon?: ComponentChildren;
  footer?: ComponentChildren;
  children?: ComponentChildren;
}

/**
 * Модальный диалог: фокус внутрь (элемент с `data-autofocus` или первый фокусируемый), Tab по кругу,
 * Esc и клик по затемнению закрывают, фокус возвращается на элемент, открывший диалог.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  serifTitle = false,
  role = 'dialog',
  icon,
  footer,
  children,
}: DialogProps) {
  const base = useId();
  const titleId = `${base}-title`;
  const descriptionId = `${base}-description`;
  const [panel, setPanel] = useLayer();
  const [overlay, setOverlay] = useLayer();
  const { mounted, state } = usePresence(open, DURATION_MS.base);
  // Поповеры и меню внутри диалога рендерятся в overlay рядом с панелью — фокус в них остаётся «внутри».
  useFocusTrap(panel, open, overlay);
  useScrollLock(open);
  useDismiss({ open, onDismiss: () => onOpenChange(false), inside: [panel], outsidePress: role === 'dialog' });
  if (!mounted) return null;
  return (
    <Portal>
      <div ref={setOverlay} class="ui-overlay" data-state={state}>
        <PortalContext.Provider value={overlay.current}>
          <div
            ref={setPanel}
            role={role}
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
            class={cx('ui-dialog', size !== 'md' && `ui-dialog--${size}`)}
          >
            <div class="ui-dialog__header">
              {icon}
              <h2 id={titleId} class={cx('ui-dialog__title', serifTitle && 'ui-dialog__title--serif')}>
                {title}
              </h2>
              {description && (
                <p id={descriptionId} class="ui-dialog__desc">
                  {description}
                </p>
              )}
            </div>
            {children && <div class="ui-dialog__body">{children}</div>}
            {footer && <div class="ui-dialog__footer">{footer}</div>}
            {/* Крестик последним в DOM: Tab сначала проходит по содержимому. */}
            {role === 'dialog' && (
              <IconButton icon={X} label="Close" class="ui-dialog__close" onClick={() => onOpenChange(false)} />
            )}
          </div>
        </PortalContext.Provider>
      </div>
    </Portal>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ComponentChildren;
  description?: ComponentChildren;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm(): void;
  /** Необратимое действие: красная кнопка и иконка (по умолчанию). */
  danger?: boolean;
  icon?: LucideIcon;
  /** Действие выполняется: кнопка подтверждения со спиннером, «Cancel» и Esc не работают. */
  busy?: boolean;
}

/** Подтверждение (alertdialog): фокус на «Cancel», деструктивная кнопка справа. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  danger = true,
  icon: Icon = Trash2,
  busy = false,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      // Пока действие выполняется, Esc не закрывает: результат некуда было бы показать.
      onOpenChange={next => busy || onOpenChange(next)}
      role="alertdialog"
      size="sm"
      title={title}
      description={description}
      icon={
        danger && (
          <span class="ui-dialog__icon ui-dialog__icon--danger">
            <Icon aria-hidden="true" />
          </span>
        )
      }
      footer={
        <>
          {/* Отменить начатое нельзя; без data-autofocus открытый сразу занятым диалог фокусирует подтверждение. */}
          <Button
            variant="secondary"
            data-autofocus={busy ? undefined : true}
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

export interface SheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ComponentChildren;
  footer?: ComponentChildren;
  children?: ComponentChildren;
}

/** Боковая панель справа: модальная, поведение как у Dialog. */
export function Sheet({ open, onOpenChange, title, footer, children }: SheetProps) {
  const titleId = `${useId()}-title`;
  const [panel, setPanel] = useLayer();
  const { mounted, state } = usePresence(open, DURATION_MS.base);
  useFocusTrap(panel, open);
  useScrollLock(open);
  useDismiss({ open, onDismiss: () => onOpenChange(false), inside: [panel] });
  if (!mounted) return null;
  return (
    <Portal>
      <div class="ui-overlay" data-state={state} aria-hidden="true" />
      <aside
        ref={setPanel}
        class="ui-sheet"
        data-state={state}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <PortalContext.Provider value={panel.current}>
          <div class="ui-sheet__header">
            <b id={titleId}>{title}</b>
            <IconButton icon={X} label="Close" onClick={() => onOpenChange(false)} />
          </div>
          <div class="ui-sheet__body">{children}</div>
          {footer && <div class="ui-sheet__footer">{footer}</div>}
        </PortalContext.Provider>
      </aside>
    </Portal>
  );
}
