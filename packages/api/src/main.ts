import { buildContainer } from '@agent/composition';
import { errorMessage } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { createApp } from './app';
import { registerAuth } from './auth/better-auth';
import { idleTimeoutSec, warnIfMailIsLogged, withJsonErrors } from './serve';

const config = loadConfig();
const container = registerAuth(buildContainer(config));
const { logger, mailer } = container.cradle;
// Сразу, а не на первом запросе: без BETTER_AUTH_SECRET API не должен стартовать.
void container.cradle.auth;
warnIfMailIsLogged({ mailer, logger }, process.env.NODE_ENV);

const app = createApp(container.cradle);
const idleTimeout = idleTimeoutSec(config.api.sseHeartbeatMs);
const server = Bun.serve({
  hostname: config.api.host,
  port: config.api.port,
  fetch: withJsonErrors(app.fetch, logger),
  idleTimeout,
});
// Только порт и тайм-аут: конфиг целиком в журнал не пишем — в нём секреты.
logger.info('api listening', { host: config.api.host, port: server.port, idleTimeout });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  logger.info('api shutting down', { signal });
  try {
    await server.stop();
    await container.dispose();
  } catch (err) {
    logger.error('api shutdown failed', { error: errorMessage(err) });
    process.exit(1);
  }
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
