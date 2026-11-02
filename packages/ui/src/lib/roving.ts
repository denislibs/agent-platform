export type Orientation = 'horizontal' | 'vertical';

/**
 * Индекс элемента, на который переходит фокус по клавише (WAI-ARIA: стрелки по кругу, Home, End),
 * пропуская недоступные. `null` — клавиша не навигационная или доступных элементов нет.
 */
export function nextIndex(
  key: string,
  current: number,
  count: number,
  isDisabled: (index: number) => boolean,
  orientation: Orientation,
): number | null {
  const forward = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const backward = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  let start: number;
  let step: number;
  if (key === forward) [start, step] = [current + 1, 1];
  // current < 0 — ничего не выбрано (фокус на контейнере): «назад» начинает с последнего.
  else if (key === backward) [start, step] = [current < 0 ? count - 1 : current - 1, -1];
  else if (key === 'Home') [start, step] = [0, 1];
  else if (key === 'End') [start, step] = [count - 1, -1];
  else return null;
  for (let n = 0; n < count; n++) {
    const index = (((start + step * n) % count) + count) % count;
    if (!isDisabled(index)) return index;
  }
  return null;
}

/** Alt, Ctrl или Meta зажаты: стрелки и Home/End тогда принадлежат браузеру и ОС, их не перехватываем. */
export function hasModifier(event: KeyboardEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey;
}
