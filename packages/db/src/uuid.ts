const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Проверка формата перед запросом к uuid-колонке: иначе Postgres бросает 22P02,
 * а по контракту портов кривой id ведёт себя как неизвестный.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
