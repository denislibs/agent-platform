import { createHmac, timingSafeEqual } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** 1 января 1970 — четверг: сдвиг на три дня начинает неделю с понедельника, как в ISO. */
const MONDAY_OFFSET_MS = 3 * DAY_MS;
/** Длина MAC в шестнадцатеричных символах: 96 бит; вся метка остаётся короче 63 символов одной метки DNS. */
const MAC_HEX = 24;
const LABEL = new RegExp(`^([0-9a-f]{32})-([0-9a-z]{1,4})-([0-9a-f]{${MAC_HEX}})$`);
const UUID_HEX = /^[0-9a-f]{32}$/;
/** Метка вывода ключа: ключ превью не совпадает с BETTER_AUTH_SECRET ни одним байтом. */
const KEY_LABEL = 'agent-platform/preview-key/v1';

/** Номер недели (ISO-подобной, с понедельника) от эпохи. */
export const previewWeek = (now: Date): number => Math.floor((now.getTime() + MONDAY_OFFSET_MS) / WEEK_MS);

/** Ключ подписи: PREVIEW_SECRET или HMAC от BETTER_AUTH_SECRET с постоянной меткой. */
export function previewSigningKey(preview: { secret: string | null }, authSecret: string | null): Uint8Array {
  if (preview.secret) return new TextEncoder().encode(preview.secret);
  if (!authSecret) throw new Error('preview signing key: neither PREVIEW_SECRET nor BETTER_AUTH_SECRET is set');
  return new Uint8Array(createHmac('sha256', authSecret).update(KEY_LABEL).digest());
}

const macOf = (hex: string, week: number, key: Uint8Array): string =>
  createHmac('sha256', key).update(`${hex}:${week}`).digest('hex').slice(0, MAC_HEX);

/**
 * Метка хоста превью: <32 hex id задачи>-<неделя в base-36>-<MAC>. Доступ несёт сам хост: ни токена в адресе, ни cookie.
 * Origin постоянен неделю, поэтому localStorage сайта живёт между открытиями. id не UUID — null.
 */
export function previewLabel(taskId: string, now: Date, key: Uint8Array): string | null {
  const hex = taskId.replaceAll('-', '').toLowerCase();
  if (!UUID_HEX.test(hex)) return null;
  const week = previewWeek(now);
  return `${hex}-${week.toString(36)}-${macOf(hex, week, key)}`;
}

/**
 * id задачи из метки или null. Действуют текущая и прошлая неделя: адрес живёт не дольше двух недель и не годится как
 * бесплатный хостинг. Другая запись той же недели (0 впереди) — другой origin, поэтому отказ.
 */
export function verifyPreviewLabel(label: string, now: Date, key: Uint8Array): string | null {
  const match = LABEL.exec(label.toLowerCase());
  if (!match) return null;
  const [, hex, weekText, mac] = match as unknown as [string, string, string, string];
  const week = Number.parseInt(weekText, 36);
  const current = previewWeek(now);
  const fresh = week.toString(36) === weekText && (week === current || week === current - 1);
  const valid = timingSafeEqual(Buffer.from(mac), Buffer.from(macOf(hex, week, key)));
  if (!fresh || !valid) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
