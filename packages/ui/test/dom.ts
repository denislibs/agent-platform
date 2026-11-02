// Preload только для `bun run test:ui`: happy-dom подменяет fetch, Request, Response и другие
// глобальные объекты, поэтому в одном процессе с тестами бэкенда его регистрировать нельзя.
import { afterEach } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });

// Автоочистка @testing-library/preact подписывается на afterEach только в первом файле,
// который её импортировал (модуль грузится один раз на процесс). Хук из preload — глобальный.
// Библиотека импортируется после регистрации: @testing-library/dom читает document при загрузке.
const { cleanup } = await import('@testing-library/preact');
afterEach(() => cleanup());
