import type { RefObject } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export type DismissReason = 'escape' | 'outside';

// Открытые слои по порядку открытия: Esc и клик снаружи получает только верхний,
// поэтому Esc в меню внутри диалога закрывает меню, а не диалог.
const layers: object[] = [];

export interface DismissOptions {
  open: boolean;
  onDismiss(reason: DismissReason): void;
  /** Элементы слоя (сам слой, его триггер): нажатие в них не закрывает. */
  inside: ReadonlyArray<RefObject<HTMLElement>>;
  /** false — не закрывать по клику снаружи (alertdialog). */
  outsidePress?: boolean;
}

export function useDismiss({ open, onDismiss, inside, outsidePress = true }: DismissOptions): void {
  const [token] = useState(() => ({}));
  // Место в стеке — на всё время, пока слой открыт.
  useEffect(() => {
    if (!open) return;
    layers.push(token);
    return () => {
      layers.splice(layers.indexOf(token), 1);
    };
  }, [open, token]);
  // Слушатели переподписываются на каждый рендер, чтобы видеть свежие onDismiss и inside.
  useEffect(() => {
    if (!open) return;
    const isTop = () => layers.at(-1) === token;
    const onKeyDown = (event: KeyboardEvent) => {
      // Esc во время набора через IME отменяет композицию, а не закрывает слой.
      if (event.key !== 'Escape' || event.isComposing || !isTop() || event.defaultPrevented) return;
      event.preventDefault();
      onDismiss('escape');
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!outsidePress || !isTop()) return;
      const target = event.target as Node | null;
      if (target && inside.some(ref => ref.current?.contains(target))) return;
      onDismiss('outside');
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  });
}
