import { buildContainer } from '@agent/composition';
import { loadConfig } from '@agent/shared';
import { startWorker } from './worker';

const config = loadConfig();
const container = buildContainer(config);
const worker = await startWorker(container.cradle);
console.log(`[worker] ready: queue prefix ${config.worker.queuePrefix}, concurrency ${config.worker.concurrency}`);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[worker] ${signal}: finishing current jobs`);
  try {
    await worker.close();
    await container.dispose();
  } catch (err) {
    console.error('[worker] shutdown failed:', err);
    process.exit(1);
  }
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
