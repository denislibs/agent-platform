import { useEffect, useRef } from 'preact/hooks';
import { cx } from '../lib/cx.ts';
import { useReducedMotion } from '../lib/media.ts';
import { mountDotField } from './dot-field.ts';

export interface DotFieldProps {
  class?: string;
}

/**
 * Анимированный фон входа. Canvas занимает родителя (родителю — `position: relative`), следует
 * теме, при reduced motion рисует один кадр, вне экрана и на скрытой вкладке стоит,
 * при размонтировании снимает обработчики.
 */
export function DotField({ class: className }: DotFieldProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!canvas.current) return;
    const field = mountDotField(canvas.current, { reducedMotion: reduced });
    return () => field?.destroy();
  }, [reduced]);
  return <canvas ref={canvas} class={cx('ui-dot-field', className)} aria-hidden="true" />;
}
