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

/**
 * Кредиты из строки (CLI admin:grant, спецификация 11) в милликредиты без плавающей точки:
 * целая часть ×1000 плюс до трёх знаков дроби. "10" → 10000, "0.5" → 500.
 * Только десятичная запись: без знака, экспоненты, запятой и пустой целой части.
 */
export function parseCredits(text: string): number {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (!match) throw new RangeError(`"${text}" is not an amount of credits with at most 3 decimals`);
  const millicredits = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
  if (!Number.isSafeInteger(millicredits) || millicredits <= 0)
    throw new RangeError(`"${text}" must be a positive amount of credits`);
  return millicredits;
}
