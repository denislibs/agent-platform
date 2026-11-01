/** Милликредиты → кредиты строкой без плавающей точки (спецификация 11): 12345 → "12.345", -250 → "-0.25". */
export function formatCredits(millicredits: number): string {
  if (!Number.isSafeInteger(millicredits))
    throw new RangeError(`millicredits must be a safe integer, got ${millicredits}`);
  const sign = millicredits < 0 ? '-' : '';
  const abs = Math.abs(millicredits);
  const fraction = String(abs % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${sign}${Math.floor(abs / 1000)}${fraction ? `.${fraction}` : ''}`;
}
