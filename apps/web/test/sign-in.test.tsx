import { expect, test } from 'bun:test';
import { screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { SignIn } from '../src/routes/sign-in.tsx';
import { json } from './fixtures.ts';
import { setup } from './render.tsx';

const signedOut = (providers: string[]) => ({
  'GET /api/config': json({ providers, uploadMaxBytes: 1024 }),
  'GET /api/me': json({ error: { code: 'unauthorized', message: 'sign in to continue' } }, 401),
});

test('magic link: the email is sent to Better Auth and the card says to check the inbox', async () => {
  const { view, calls, state } = setup(
    { ...signedOut([]), 'POST /api/auth/sign-in/magic-link': json({ status: true }) },
    '/sign-in',
  );
  await state.session.load();
  view(<SignIn />);
  expect(document.title).toBe('Sign in · agent');
  expect(screen.getByRole('main')).toBeTruthy();
  const send = screen.getByRole('button', { name: 'Email me a sign-in link' });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  await userEvent.type(screen.getByRole('textbox', { name: 'Email address' }), 'ada@example.com{Enter}');
  expect((await screen.findByRole('status')).textContent).toContain('ada@example.com');
  // Форма исчезла вместе с фокусом: он переходит на заголовок нового состояния.
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Check your email.' }));
  expect(calls.at(-1)?.body).toEqual({ email: 'ada@example.com', callbackURL: '/', errorCallbackURL: '/sign-in' });
  await userEvent.click(screen.getByRole('button', { name: 'Use a different email' }));
  expect(screen.getByRole('textbox', { name: 'Email address' })).toBeTruthy();
});

test('OAuth buttons appear only for configured providers and send the browser to the provider', async () => {
  const { view, assigned, state } = setup(
    {
      ...signedOut(['github']),
      'POST /api/auth/sign-in/social': json({
        url: 'https://github.com/login/oauth/authorize?state=s',
        redirect: true,
      }),
    },
    '/sign-in',
  );
  await state.session.load();
  view(<SignIn />);
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Continue with GitHub' }));
  expect(assigned).toEqual(['https://github.com/login/oauth/authorize?state=s']);
});

test('without OAuth apps there are no provider buttons and no divider', async () => {
  const { view, state } = setup(signedOut([]), '/sign-in');
  await state.session.load();
  const { container } = view(<SignIn />);
  expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull();
  expect(container.querySelector('.ui-divider')).toBeNull();
});

test('a Better Auth error is shown in its own words; a bad link brings a readable alert', async () => {
  const { view, state } = setup(
    {
      ...signedOut([]),
      'POST /api/auth/sign-in/magic-link': json({ message: 'Too many requests. Please try again later.' }, 429),
    },
    '/sign-in?error=INVALID_TOKEN',
  );
  await state.session.load();
  view(<SignIn />);
  expect(screen.getByRole('alert').textContent).toContain('invalid or was already used');
  await userEvent.type(screen.getByRole('textbox', { name: 'Email address' }), 'ada@example.com{Enter}');
  await screen.findByText('Too many requests. Please try again later.');
});

test('a send error is tied to the email field for screen readers', async () => {
  const { view, state } = setup(
    {
      ...signedOut([]),
      'POST /api/auth/sign-in/magic-link': json({ message: 'Invalid email', code: 'INVALID_EMAIL' }, 400),
    },
    '/sign-in',
  );
  await state.session.load();
  view(<SignIn />);
  const field = screen.getByRole('textbox', { name: 'Email address' });
  await userEvent.type(field, 'ada@example.com{Enter}');
  const message = await screen.findByText('Invalid email');
  expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById(field.getAttribute('aria-describedby') ?? '')).toBe(message.closest('.ui-error'));
});

test('a server failure is not echoed: the user sees a generic message', async () => {
  const { view, state } = setup(
    {
      ...signedOut([]),
      'POST /api/auth/sign-in/magic-link': json({ message: 'relation "verification" does not exist' }, 500),
    },
    '/sign-in',
  );
  await state.session.load();
  view(<SignIn />);
  await userEvent.type(screen.getByRole('textbox', { name: 'Email address' }), 'ada@example.com{Enter}');
  await screen.findByText('Something went wrong on our side. Try again.');
  expect(screen.queryByText(/relation/)).toBeNull();
});

test('the rate limit without a readable body says to try again later', async () => {
  const { view, state } = setup({ ...signedOut([]), 'POST /api/auth/sign-in/magic-link': json({}, 429) }, '/sign-in');
  await state.session.load();
  view(<SignIn />);
  await userEvent.type(screen.getByRole('textbox', { name: 'Email address' }), 'ada@example.com{Enter}');
  await screen.findByText('Too many attempts. Try again later.');
});

test('a provider answer that is not an http(s) address never navigates the browser', async () => {
  const { view, assigned, state } = setup(
    {
      ...signedOut(['github']),
      'POST /api/auth/sign-in/social': json({ url: 'javascript:alert(1)', redirect: true }),
    },
    '/sign-in',
  );
  await state.session.load();
  view(<SignIn />);
  await userEvent.click(screen.getByRole('button', { name: 'Continue with GitHub' }));
  await screen.findByRole('alert');
  expect(assigned).toEqual([]);
  // Кнопка снова доступна.
  expect((screen.getByRole('button', { name: 'Continue with GitHub' }) as HTMLButtonElement).disabled).toBe(false);
});

test('an unknown link error code still gets a readable alert', async () => {
  const { view, state } = setup(signedOut([]), '/sign-in?error=SOMETHING_ELSE');
  await state.session.load();
  view(<SignIn />);
  expect(screen.getByRole('alert').textContent).toContain('Sign-in did not work');
});
