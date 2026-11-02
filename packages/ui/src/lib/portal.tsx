import { createContext, type ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useContext } from 'preact/hooks';

/**
 * Куда рендерить поповеры. По умолчанию — document.body; Dialog и Sheet подставляют свой
 * слой, чтобы меню внутри модалки не оказалось под её затемнением (z-index 40 < 50).
 */
export const PortalContext = createContext<HTMLElement | null>(null);

export function Portal({ children }: { children: ComponentChildren }) {
  const container = useContext(PortalContext);
  return createPortal(children, container ?? document.body);
}
