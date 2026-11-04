import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const CONTROL = 'http://127.0.0.1:5197/__e2e';

test('sign in with a magic link, run a task that asks a question, read the answer and download the file', async ({
  page,
  request,
}) => {
  // Нарушения CSP собираются на странице: тест падает, если политика что-то заблокировала (тема, шрифты, HMR, S3).
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { cspViolations: seen });
    document.addEventListener('securitypolicyviolation', e => seen.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  // Ошибки страницы и её фреймов: сайт агента не должен падать на модульном скрипте или таблице стилей.
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const email = `${crypto.randomUUID()}@web-e2e.test.dev`;

  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByRole('textbox', { name: 'Email address' }).fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText(email);

  const link = await (await request.get(`${CONTROL}/link?email=${encodeURIComponent(email)}`)).text();
  expect(link).toMatch(/^http:\/\/localhost:5199\/api\/auth\/magic-link\/verify\?token=/);
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'What should your agent do?' })).toBeVisible();
  // Пользователь появился при переходе по ссылке: теперь ему можно начислить кредиты (как admin:grant).
  expect((await request.post(`${CONTROL}/grant?email=${encodeURIComponent(email)}`)).ok()).toBe(true);
  await page.reload();
  await expect(page.getByText('You are out of credits')).toHaveCount(0);
  await expect(page).toHaveTitle('New task · agent');

  // Вложение уходит прямо в S3 по presigned PUT (CORS бакета ставит web-stack.ts).
  await page.locator('input[type=file]').setInputFiles({
    name: 'names.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name\nAda\n'),
  });
  await expect(page.getByText('Spreadsheet · 9 B')).toBeVisible();

  const composer = page.getByRole('textbox', { name: 'Task' });
  await composer.fill('Write a greeting to hello.md');
  await composer.press('Enter');
  await expect(page).toHaveURL(/\/tasks\/[\w-]+$/);
  await expect(page.getByRole('link', { name: /names\.csv/ })).toBeVisible();

  const ask = page.getByRole('region', { name: 'Your agent needs an answer' });
  await expect(ask).toContainText('Which greeting?');
  await ask.getByRole('textbox').fill('A markdown heading');
  await ask.getByRole('textbox').press('Enter');

  await expect(page.getByText('Task completed')).toBeVisible();
  await expect(page.getByText('your file')).toHaveJSProperty('tagName', 'STRONG');
  await expect(page.getByRole('list', { name: 'Plan' }).getByRole('listitem')).toHaveAttribute('data-status', 'done');
  await expect(
    page.getByRole('navigation', { name: 'Tasks' }).getByRole('link', { name: /Write a greeting/ }),
  ).toContainText('completed');

  // Первый цикл сайта не выдал: переключателя нет.
  const computer = page.getByRole('region', { name: "Agent's computer" });
  await expect(computer.getByRole('button', { name: 'Preview' })).toHaveCount(0);

  /** Скачивание по ссылке файла: /api/files/:id → redirect на presigned GET (attachment). */
  const downloadText = async (name: RegExp, filename: string) => {
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(filename);
    return readFile(await file.path(), 'utf8');
  };
  expect(await downloadText(/^hello\.md Document/, 'hello.md')).toBe('# Hello');
  // Вложение действительно лежит в S3 байт в байт (недогруженный файл API отдал бы 409 upload_incomplete).
  expect(await downloadText(/^names\.csv/, 'names.csv')).toBe('name\nAda\n');

  // Продолжение беседы: та же задача, новый план, тот же файл в новой версии; прошлый ответ остаётся в ленте.
  const followUp = page.getByRole('textbox', { name: 'Message' });
  await followUp.fill('Make it shorter');
  await followUp.press('Enter');
  await expect(page.getByText('Make it shorter')).toBeVisible();
  await expect(page.getByText('shorter', { exact: true })).toHaveJSProperty('tagName', 'STRONG');
  await expect(page.getByText('your file')).toBeVisible();
  await expect(page.getByText('Task completed')).toHaveCount(1);
  await expect(page.getByRole('list', { name: 'Plan' }).getByRole('listitem')).toContainText('Shorten the greeting');
  const nav = page.getByRole('navigation', { name: 'Tasks' });
  await expect(nav.getByRole('link', { name: /Write a greeting/ })).toContainText('completed');
  const latest = page.waitForEvent('download');
  await page
    .getByRole('link', { name: /^hello\.md Document/ })
    .last()
    .click();
  expect(await readFile(await (await latest).path(), 'utf8')).toBe('# Hi');

  // Превью: второй цикл выдал outputs/index.html, панель открыла сайт сама.
  await expect(computer.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.frameLocator('iframe[title="Site preview"]').getByText('Site ready')).toBeVisible();
  await expect(computer).toContainText('preview.localhost');
  await expect(computer).toContainText('Built by the agent. Not part of this app. Do not enter passwords.');
  const site = () => page.frames().find(f => f.url().includes('.preview.localhost:5197/'));
  // Скрипт выполнился, localStorage работает, окно приложения недоступно (его origin чужой).
  await expect.poll(() => site()?.title()).toBe('visits-1:top-blocked');
  expect(await site()?.evaluate(() => document.cookie)).toBe('');
  // Модульный скрипт и таблица стилей по абсолютным адресам /assets/…: стиль из style.css применён.
  expect(await site()?.evaluate(() => getComputedStyle(document.querySelector('p')!).color)).toBe('rgb(1, 2, 3)');
  // Сайт на другом хосте, чем приложение: это и держит его origin чужим.
  expect(new URL(site()!.url()).host).not.toBe(new URL(page.url()).host);
  // Хранилище сайта — своё: в приложение его запись не попала, а между загрузками сайта она живёт.
  expect(await page.evaluate(() => localStorage.getItem('visits'))).toBeNull();
  const newTab = computer.getByRole('link', { name: 'Open in new tab' });
  await expect(newTab).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await newTab.getAttribute('href')).toBe(site()?.url());
  await computer.getByRole('button', { name: 'Activity' }).click();
  await expect(computer.locator('iframe')).toHaveCount(0);
  await computer.getByRole('button', { name: 'Preview' }).click();
  await expect.poll(() => site()?.title()).toBe('visits-2:top-blocked');

  // Library показывает результат задачи; удаление задачи возвращает на главную и убирает его файлы.
  await page.getByRole('link', { name: 'Library' }).click();
  await expect(page.getByRole('link', { name: 'Download hello.md' })).toBeVisible();
  await page.getByRole('link', { name: 'Open task of hello.md' }).click();
  await expect(page).toHaveURL(/\/tasks\/[\w-]+$/);
  await page.getByRole('button', { name: /^Delete task Write a greeting/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('link', { name: 'Library' }).click();
  await expect(page.getByText('No files yet')).toBeVisible();

  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
  expect(pageErrors).toEqual([]);
});
