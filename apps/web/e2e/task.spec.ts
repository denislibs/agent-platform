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

  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
});
