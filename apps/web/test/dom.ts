// Preload только для `bun run test:web`: happy-dom подменяет fetch, Request, Response и другие глобальные объекты,
// поэтому в одном процессе с тестами бэкенда его регистрировать нельзя (как test:ui ui-kit).
import { afterEach } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Фреймы не загружаются: тестам нужен сам элемент, а не сеть.
GlobalRegistrator.register({ url: 'http://localhost/', settings: { disableIframePageLoading: true } });

// Автоочистка @testing-library/preact подписывается на afterEach только в первом файле процесса — хук из preload
// глобальный. Библиотека импортируется после регистрации: @testing-library/dom читает document при загрузке.
const { cleanup } = await import('@testing-library/preact');
afterEach(() => cleanup());
