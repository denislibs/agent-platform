import { buildContainer } from '@agent/composition';
import { errorMessage } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { createApp } from './app';
import { registerAuth } from './auth/better-auth';
import { OpenStreams } from './open-streams';
import { idleTimeoutSec, SHUTDOWN_GRACE_MS, stopServer, warnIfMailIsLogged, withJsonErrors } from './serve';

const config = loadConfig();
const container = registerAuth(buildContainer(config));
const { logger, mailer } = container.cradle;
// Сразу, а не на первом запросе: без BETTER_AUTH_SECRET API не должен стартовать.
void container.cradle.auth;
warnIfMailIsLogged({ mailer, logger }, process.env.NODE_ENV);

const streams = new OpenStreams();
const app = createApp(container.cradle, { streams });
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
    // Открытые SSE-потоки закрываются явно: иначе server.stop() ждал бы их вечно.
    await stopServer(server, streams, { graceMs: SHUTDOWN_GRACE_MS, logger });
    await container.dispose();
  } catch (err) {
    logger.error('api shutdown failed', { error: errorMessage(err) });
    process.exit(1);
  }
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
