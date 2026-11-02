import { expect, test } from '@playwright/test';

test('the production build works under its CSP: sign-in renders, the theme script runs, the API answers', async ({
  page,
}) => {
  // Нарушения CSP и ошибки страницы собираются с первой строки: тест падает на любом из них.
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { cspViolations: seen });
    document.addEventListener('securitypolicyviolation', e => seen.push(`${e.violatedDirective} ${e.blockedURI}`));
    localStorage.setItem('ui-theme', 'light');
  });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('heading', { name: 'Hand it off.' })).toBeVisible();
  // Скрипт темы (inline, разрешён по хэшу) успел до отрисовки.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('textbox', { name: 'Email address' }).fill('smoke@example.com');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('smoke@example.com');

  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
  expect(errors).toEqual([]);
});
