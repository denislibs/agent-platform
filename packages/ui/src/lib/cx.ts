/**
 * Склеивает классы, пропуская пустые значения: `cx('ui-btn', busy && 'is-busy', props.class)`.
 * Принимает unknown, потому что `class` у Preact может быть сигналом — такие значения пропускаются.
 */
export function cx(...parts: unknown[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
}
