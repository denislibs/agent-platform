import type { RefObject } from 'preact';
import { useLayoutEffect } from 'preact/hooks';
import { autoUpdate, computePosition, flip, offset, shift, size, type Placement } from '@floating-ui/dom';

export type { Placement };

export interface FloatingOptions {
  open: boolean;
  anchor: RefObject<HTMLElement>;
  floating: RefObject<HTMLElement>;
  placement?: Placement;
  /** Отступ от якоря, px (в прототипе — 6). */
  gap?: number;
  /** Ширина как у якоря (кастомный select). */
  matchWidth?: boolean;
}

/**
 * Позиционирует слой рядом с якорем (Floating UI, strategy fixed): переворачивается у края
 * экрана, сдвигается внутрь, следит за прокруткой и размером. Координаты — inline-стилем,
 * фактическая сторона — в `data-placement` (от неё зависит transform-origin в CSS).
 */
export function useFloating({
  open,
  anchor,
  floating,
  placement = 'bottom-start',
  gap = 6,
  matchWidth = false,
}: FloatingOptions): void {
  useLayoutEffect(() => {
    const reference = anchor.current;
    const layer = floating.current;
    if (!open || !reference || !layer) return;
    const update = () => {
      void computePosition(reference, layer, {
        strategy: 'fixed',
        placement,
        middleware: [
          offset(gap),
          flip({ padding: 8 }),
          shift({ padding: 8 }),
          ...(matchWidth
            ? [
                size({
                  apply({ rects }) {
                    layer.style.width = `${rects.reference.width}px`;
                  },
                }),
              ]
            : []),
        ],
      }).then(({ x, y, placement: actual }) => {
        layer.style.left = `${x}px`;
        layer.style.top = `${y}px`;
        layer.dataset.placement = actual;
      });
    };
    return autoUpdate(reference, layer, update);
  }, [open, anchor, floating, placement, gap, matchWidth]);
}

/** Начальный стиль слоя до первого расчёта: вне потока и в углу, пока он прозрачен (data-state=closed). */
export const FLOATING_STYLE = { position: 'fixed', left: '0px', top: '0px' } as const;
