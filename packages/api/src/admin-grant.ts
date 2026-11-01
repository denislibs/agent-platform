import { buildContainer } from '@agent/composition';
import { errorMessage, NotFoundError } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { grantCredits } from './admin/grant';

// Точка входа CLI: без LITELLM_* (они нужны только воркеру), контейнер закрывается, чтобы процесс завершился.
const container = buildContainer(loadConfig());
try {
  console.log(await grantCredits(container.cradle, process.argv.slice(2)));
} catch (err) {
  console.error(
    err instanceof NotFoundError ? 'no user with this email: they need to sign in once first' : errorMessage(err),
  );
  process.exitCode = 1;
} finally {
  await container.dispose();
}
