import { loadConfig, type Config } from '@agent/shared';

/**
 * Конфиг для юнит-тестов: лимиты и цены — значения по умолчанию из loadConfig,
 * адреса инфраструктуры — заглушки (юнит-тесты ходят только в in-memory двойники).
 */
export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: 'postgres://unused:unused@localhost:1/unused_test',
    VALKEY_URL: 'redis://localhost:1',
    S3_ENDPOINT: 'http://localhost:1',
    S3_REGION: 'test',
    S3_BUCKET: 'test',
    S3_ACCESS_KEY_ID: 'test',
    S3_SECRET_ACCESS_KEY: 'test',
    LITELLM_BASE_URL: 'http://localhost:1/v1',
    LITELLM_API_KEY: 'test',
    PLANNER_MODEL: 'scripted-planner',
    EXECUTOR_MODEL: 'scripted-executor',
    ...env,
  });
}
