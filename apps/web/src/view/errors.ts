import { ApiRequestError } from '../api/client.ts';

/**
 * Текст ошибки для тоста или алерта: у ошибок API он уже человеческий, остальное — общий.
 * Сообщения при 5xx не показываем: там могут быть внутренности сервера (имена таблиц, трассировки).
 */
export const errorText = (err: unknown): string => {
  if (!(err instanceof ApiRequestError)) return 'Something went wrong. Try again.';
  return err.status >= 500 ? 'Something went wrong on our side. Try again.' : err.message;
};
