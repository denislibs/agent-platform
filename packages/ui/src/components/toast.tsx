import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-preact';
import { cx } from '../lib/cx.ts';
import { useReducedMotion } from '../lib/media.ts';
import { DURATION_MS, TOAST_DURATION_MS } from '../tokens.ts';
import type { StatusTone } from './display.tsx';
import { IconButton } from './button.tsx';

export interface ToastOptions {
  tone: StatusTone;
  title: string;
  description?: string;
  /** Миллисекунды до автоматического закрытия; `Infinity` — только вручную. */
  duration?: number;
}

export interface ToastApi {
  show(options: ToastOptions): string;
  dismiss(id: string): void;
}

interface ToastEntry extends ToastOptions {
  id: string;
  closing: boolean;
}

const ICONS = { success: CircleCheck, info: Info, warning: TriangleAlert, danger: CircleX };
const ToastContext = createContext<ToastApi | null>(null);
let nextId = 0;

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast() needs a <ToastProvider> above it');
  return api;
}

export interface ToastProviderProps {
  children: ComponentChildren;
  /** По умолчанию 4,5 с (дизайн-система, «Оверлеи»). */
  duration?: number;
  /** Длительность анимации закрытия, после неё тост удаляется из DOM. */
  exitMs?: number;
  label?: string;
}

export function ToastProvider({
  children,
  duration = TOAST_DURATION_MS,
  exitMs = DURATION_MS.base,
  label = 'Notifications',
}: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reduced = useReducedMotion();
  const exit = reduced ? 0 : exitMs;

  const dismiss = useCallback(
    (id: string) => {
      clearTimeout(timers.current.get(id));
      setToasts(list => list.map(t => (t.id === id ? { ...t, closing: true } : t)));
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          setToasts(list => list.filter(t => t.id !== id));
        }, exit),
      );
    },
    [exit],
  );

  const show = useCallback(
    (options: ToastOptions) => {
      const id = `ui-toast-${++nextId}`;
      setToasts(list => [...list, { ...options, id, closing: false }]);
      const ms = options.duration ?? duration;
      if (Number.isFinite(ms))
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), ms),
        );
      return id;
    },
    [duration, dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <section class="ui-toast-region" aria-label={label} aria-live="polite">
        {toasts.map(toast => {
          const Icon = ICONS[toast.tone];
          return (
            <div
              key={toast.id}
              class={cx('ui-toast', `ui-toast--${toast.tone}`)}
              data-state={toast.closing ? 'closed' : undefined}
              role={toast.tone === 'danger' ? 'alert' : 'status'}
            >
              <span class="ui-toast__icon">
                <Icon aria-hidden="true" />
              </span>
              <div class="ui-toast__body">
                <span class="ui-toast__title">{toast.title}</span>
                {toast.description && <span class="ui-toast__desc">{toast.description}</span>}
              </div>
              <IconButton icon={X} label="Dismiss" size="xs" onClick={() => dismiss(toast.id)} />
            </div>
          );
        })}
      </section>
    </ToastContext.Provider>
  );
}
