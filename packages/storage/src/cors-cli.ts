import { errorMessage } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { allowBrowserUploads } from './cors';

/**
 * bun run s3:cors [origin…] — разрешить загрузки из браузера в бакет. Без аргументов: адрес приложения
 * (BETTER_AUTH_URL) и локальный Vite http://localhost:5173. В compose — разовый сервис s3-cors.
 */
const config = loadConfig();
const args = process.argv.slice(2);
const origins = args.length > 0 ? args : [new URL(config.auth.baseUrl).origin, 'http://localhost:5173'];

// Garage в compose стартует без healthcheck: даём ему до 30 с.
for (let attempt = 1; ; attempt++) {
  try {
    const allowed = await allowBrowserUploads(config.s3, origins);
    console.log(`S3 bucket ${config.s3.bucket}: browser uploads allowed from ${allowed.join(', ')}`);
    break;
  } catch (err) {
    if (attempt >= 30) {
      console.error(`could not set CORS on ${config.s3.bucket}: ${errorMessage(err)}`);
      process.exit(1);
    }
    await Bun.sleep(1000);
  }
}
