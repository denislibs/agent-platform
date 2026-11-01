/**
 * Локальный запуск — только явные NODE_ENV=test и NODE_ENV=development. Всё остальное, включая пустой
 * NODE_ENV, считается боевым: защиты (rate limiting, предупреждения) по умолчанию включены.
 */
export function isLocalRuntime(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'test' || nodeEnv === 'development';
}
