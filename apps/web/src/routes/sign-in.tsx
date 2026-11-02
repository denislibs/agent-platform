import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Monitor, Moon, Sun } from 'lucide-preact';
import { Alert, Button, DotField, Field, Input, SegmentedControl, useTheme } from '@agent/ui';
import type { AuthProvider } from '@agent/shared';
import { MAIN_ID, usePage } from '../layout/page.ts';
import { useApp } from '../state/app.ts';
import { RETURN_PARAM, safeReturnPath } from '../state/return-to.ts';
import { errorText } from '../view/errors.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PROVIDER_NAMES: Record<AuthProvider, string> = { google: 'Google', github: 'GitHub' };

/** Коды, с которыми Better Auth возвращает на /sign-in после ссылки (errorCallbackURL). */
const LINK_ERRORS: Record<string, string> = {
  INVALID_TOKEN: 'This sign-in link is invalid or was already used. Request a new one.',
  EXPIRED_TOKEN: 'This sign-in link has expired. Request a new one.',
};

/** Вход (спецификация 12): фон «поле точек», OAuth — только настроенные провайдеры (GET /api/config), magic link. */
export function SignIn() {
  usePage('Sign in');
  const { api, session, assign } = useApp();
  const { query } = useLocation();
  const { theme, setTheme } = useTheme();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<'email' | AuthProvider | null>(null);
  // Алерт — про вход в целом (битая ссылка, сбой провайдера); ошибка отправки письма привязана к полю.
  const [notice, setNotice] = useState<string | null>(() =>
    query.error ? (LINK_ERRORS[query.error] ?? 'Sign-in did not work. Try again.') : null,
  );
  const [emailError, setEmailError] = useState<string | null>(null);
  // Куда вернуть после входа: страница, с которой охрана увела сюда (только путь этого приложения).
  const returnTo = safeReturnPath(query[RETURN_PARAM]) ?? '/';
  const providers = session.config.value?.providers ?? [];
  const address = email.trim();

  const sendLink = async (event: Event) => {
    event.preventDefault();
    if (!EMAIL.test(address) || busy) return;
    setBusy('email');
    setNotice(null);
    setEmailError(null);
    try {
      await api.sendMagicLink(address, returnTo);
      // Экран один и тот же, есть такой адрес или нет: наличие аккаунта не раскрываем.
      setSentTo(address);
    } catch (err) {
      setEmailError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const continueWith = async (provider: AuthProvider) => {
    setBusy(provider);
    setNotice(null);
    setEmailError(null);
    try {
      // Better Auth отдаёт адрес провайдера (клиент пропускает только http(s)); браузер уходит туда
      // и вернётся на страницу возврата с cookie сессии.
      assign(await api.socialSignIn(provider, returnTo));
    } catch (err) {
      setNotice(errorText(err));
      setBusy(null);
    }
  };

  return (
    <main id={MAIN_ID} class="ui-auth" tabIndex={-1}>
      <DotField />
      <div class="ui-brand ui-auth__brand">
        <span class="ui-mark" />
        agent
      </div>
      <div class="ui-auth__theme">
        <SegmentedControl
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'light', icon: Sun, ariaLabel: 'Light theme' },
            { value: 'dark', icon: Moon, ariaLabel: 'Dark theme' },
            { value: 'auto', icon: Monitor, ariaLabel: 'System theme' },
          ]}
        />
      </div>
      {sentTo ? (
        <div class="ui-auth__card">
          <h1 class="ui-display">
            Check your <em>email.</em>
          </h1>
          <p class="ui-auth__lead" role="status">
            We sent a sign-in link to {sentTo}. It works once and expires in 15 minutes.
          </p>
          <Button block onClick={() => setSentTo(null)}>
            Use a different email
          </Button>
        </div>
      ) : (
        <form class="ui-auth__card" onSubmit={event => void sendLink(event)} noValidate>
          <h1 class="ui-display">
            Hand it <em>off.</em>
          </h1>
          <p class="ui-auth__lead">Sign in to give your agent its first task.</p>
          {notice && (
            <Alert tone="danger" live>
              {notice}
            </Alert>
          )}
          {providers.map(provider => (
            <Button
              key={provider}
              block
              loading={busy === provider}
              disabled={busy !== null && busy !== provider}
              onClick={() => void continueWith(provider)}
            >
              Continue with {PROVIDER_NAMES[provider]}
            </Button>
          ))}
          {providers.length > 0 && <div class="ui-divider ui-divider--label">or</div>}
          <Field label="Email address" error={emailError}>
            <Input
              type="email"
              autocomplete="email"
              placeholder="you@company.com"
              value={email}
              onInput={event => setEmail(event.currentTarget.value)}
            />
          </Field>
          <Button type="submit" variant="primary" block disabled={!EMAIL.test(address)} loading={busy === 'email'}>
            Email me a sign-in link
          </Button>
        </form>
      )}
    </main>
  );
}
