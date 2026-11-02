import { buildContainer } from '@agent/composition';
import { errorMessage, NotFoundError } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { deleteUserData } from './admin/delete-user';
import { registerAuth } from './auth/better-auth';

// Точка входа CLI: нужен BETTER_AUTH_SECRET (пользователей ведёт Better Auth), LITELLM_* — нет.
const container = registerAuth(buildContainer(loadConfig()));
try {
  console.log(await deleteUserData(container.cradle, process.argv.slice(2)));
} catch (err) {
  console.error(err instanceof NotFoundError ? 'no user with this email' : errorMessage(err));
  process.exitCode = 1;
} finally {
  await container.dispose();
}
