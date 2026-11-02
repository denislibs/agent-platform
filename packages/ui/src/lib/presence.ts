import { useEffect, useState } from 'preact/hooks';
import { useReducedMotion } from './media.ts';

export type PresenceState = 'open' | 'closed';

/**
 * Слой с анимацией появления и исчезновения через `data-state`: при открытии первый кадр
 * рисуется в `closed`, затем `open` (CSS-переход играет); при закрытии слой живёт ещё `exitMs`.
 */
export function usePresence(open: boolean, exitMs: number): { mounted: boolean; state: PresenceState } {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<PresenceState>(open ? 'open' : 'closed');
  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setState('open'));
      return () => cancelAnimationFrame(frame);
    }
    setState('closed');
    const timer = setTimeout(() => setMounted(false), reduced ? 0 : exitMs);
    return () => clearTimeout(timer);
  }, [open, exitMs, reduced]);
  return { mounted: open || mounted, state: open ? state : 'closed' };
}
