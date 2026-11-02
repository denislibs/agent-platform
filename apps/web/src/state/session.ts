import { batch, signal } from '@preact/signals';
import { setTheme } from '@agent/ui';
import type { ClientConfig, MeResponse, ProfileTheme } from '@agent/shared';
import { ApiRequestError, type Api } from '../api/client.ts';

export type SessionStatus = 'loading' | 'signed_in' | 'signed_out' | 'unreachable';

/**
 * Сессия: профиль и баланс (GET /api/me), публичные настройки (GET /api/config). Тема из профиля применяется
 * при входе (спецификация 12); localStorage ui-kit — только кэш для первой отрисовки.
 */
export function createSession(api: Api) {
  const status = signal<SessionStatus>('loading');
  const me = signal<MeResponse | null>(null);
  const config = signal<ClientConfig | null>(null);

  const applyProfile = (profile: MeResponse) => {
    batch(() => {
      me.value = profile;
      status.value = 'signed_in';
    });
    setTheme(profile.user.theme);
  };

  return {
    status,
    me,
    config,
    async load(): Promise<void> {
      const [cfg, profile] = await Promise.allSettled([api.config(), api.me()]);
      if (cfg.status === 'fulfilled') config.value = cfg.value;
      if (profile.status === 'fulfilled') return applyProfile(profile.value);
      const err = profile.reason;
      status.value = err instanceof ApiRequestError && err.status === 401 ? 'signed_out' : 'unreachable';
    },
    /** Баланс после задачи: тихо, без смены статуса при сбое. */
    async refresh(): Promise<void> {
      try {
        applyProfile(await api.me());
      } catch {
        // 401 уже перевёл сессию в signed_out через onUnauthorized; прочее — покажем старый баланс.
      }
    },
    /** Тема сразу на экране, затем в профиле; ошибка сохранения возвращает прежнюю и пробрасывается. */
    async saveTheme(theme: ProfileTheme): Promise<void> {
      const previous = me.value?.user.theme;
      setTheme(theme);
      try {
        me.value = await api.setTheme(theme);
      } catch (err) {
        if (previous) setTheme(previous);
        throw err;
      }
    },
    async signOut(): Promise<void> {
      await api.signOut();
      this.signedOut();
    },
    signedOut(): void {
      batch(() => {
        me.value = null;
        status.value = 'signed_out';
      });
    },
  };
}

export type Session = ReturnType<typeof createSession>;
