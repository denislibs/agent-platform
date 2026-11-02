import { useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';

export const MAIN_ID = 'main';

/**
 * Какие ссылки ведёт роутер (preact-iso, LocationProvider scope): все свои, кроме /api/ — скачивание файла
 * (/api/files/:id, redirect на presigned GET) должно уйти браузеру, а не в маршрутизатор.
 */
export const APP_LINKS = /^\/(?!api\/)/;
const PRODUCT = 'agent';

let firstPage = true;

/** Для тестов: следующая страница считается первой загрузкой (фокус не переносится). */
export function resetPageFocus(): void {
  firstPage = true;
}

/**
 * Заголовок вкладки и фокус при переходе (доступность): после перехода внутри приложения фокус уходит в <main>,
 * а не остаётся на ссылке сайдбара или пропадает вместе с отправленным композером — скринридер читает новую
 * страницу с начала. При первой загрузке фокус не трогается.
 */
export function usePage(title: string): void {
  const { url } = useLocation();
  useEffect(() => {
    document.title = title ? `${title} · ${PRODUCT}` : PRODUCT;
  }, [title]);
  useEffect(() => {
    if (firstPage) {
      firstPage = false;
      return;
    }
    document.getElementById(MAIN_ID)?.focus({ preventScroll: true });
  }, [url]);
}
