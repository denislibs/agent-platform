/** Цена модели в кредитах за 1M токенов. */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Стоимость вызова в милликредитах (1 кредит = 1000), округление вверх:
 * даже короткий вызов стоит хотя бы 1 милликредит, если цена ненулевая.
 */
export function costMillicredits(usage: { inputTokens: number; outputTokens: number }, price: ModelPrice): number {
  // кредиты/1M токенов · 1000 милликредитов = милликредиты на 1000 токенов
  return Math.ceil((usage.inputTokens * price.inputPerMillion + usage.outputTokens * price.outputPerMillion) / 1000);
}
