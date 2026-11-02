/**
 * Клавиша принадлежит методу ввода (IME): идёт композиция. Safari отдаёт keydown, завершающий
 * композицию, с `isComposing = false`, но с keyCode 229 — поэтому проверяются оба признака.
 */
export function isComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}
