import type { CreditLedger } from '@agent/core';
import { formatCredits, parseCredits } from '@agent/shared';

export const GRANT_USAGE = 'usage: bun run admin:grant <email> <credits>   (credits: up to 3 decimals, e.g. 10 or 0.5)';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Начисление кредитов в бете (спецификация 11): пользователь должен хотя бы раз войти. */
export async function grantCredits(deps: { ledger: CreditLedger }, args: readonly string[]): Promise<string> {
  const [rawEmail, amount, ...rest] = args;
  if (!rawEmail || !amount || rest.length > 0) throw new UsageError(GRANT_USAGE);
  // Better Auth хранит email в нижнем регистре.
  const email = rawEmail.trim().toLowerCase();
  // Сумма проверяется до обращения к базе.
  const millicredits = parseCredits(amount);
  const { balance } = await deps.ledger.grant(email, millicredits);
  return `granted ${formatCredits(millicredits)} credits to ${email}; balance ${formatCredits(balance)} credits`;
}
