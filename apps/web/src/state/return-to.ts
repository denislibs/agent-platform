/** Параметр адреса /sign-in: страница, на которую вернуть после входа. */
export const RETURN_PARAM = 'next';

const MAX_LENGTH = 2000;

/**
 * Страница возврата после входа — только путь этого же приложения. Адрес приходит из строки запроса, то есть от
 * кого угодно (ссылка в письме, чужой сайт), поэтому пропускается лишь «/путь»: не «//хост» и не «/\хост»
 * (браузер читает их как чужой адрес), без схемы, пробелов и управляющих символов, не /api/ (его ведёт браузер,
 * а не роутер) и не сам вход (петля). Всё остальное — null, и приложение идёт на главную.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return null;
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return null;
  // eslint-disable-next-line no-control-regex -- управляющие символы и пробелы как раз и отбрасываются
  if (/[\s\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  if (url.pathname === '/sign-in' || url.pathname.startsWith('/api/')) return null;
  return raw;
}

/** Адрес входа с памяткой, куда вернуться; с главной возвращаться незачем. */
export function signInPath(from: string): string {
  const target = safeReturnPath(from);
  return target && target !== '/' ? `/sign-in?${RETURN_PARAM}=${encodeURIComponent(target)}` : '/sign-in';
}
