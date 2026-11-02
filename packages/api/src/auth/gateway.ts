import type { ProfileTheme } from '@agent/shared';

/** Пользователь сессии — то, что API знает о нём из авторизации. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  /** Тема интерфейса из профиля (спецификация 12). */
  theme: ProfileTheme;
}

/** Авторизация за интерфейсом: в бою Better Auth, в юнит-тестах маршрутов — FakeAuth. */
export interface AuthGateway {
  /** Обработчик /api/auth/* (вход, колбэки OAuth, magic link, выход). */
  handler(req: Request): Promise<Response>;
  /** Пользователь сессии из cookie запроса; undefined — сессии нет или она истекла. */
  session(headers: Headers): Promise<SessionUser | undefined>;
  /** Сохраняет тему в профиле пользователя. */
  setTheme(userId: string, theme: ProfileTheme): Promise<void>;
  /** Id пользователя по email; undefined — такого нет. Для admin:delete-user. */
  findUserId(email: string): Promise<string | undefined>;
  /** Отзывает все сессии пользователя: следующий его запрос — 401. Для admin:delete-user. */
  deleteSessions(userId: string): Promise<void>;
  /** Удаляет пользователя: сессии, аккаунты OAuth и все его данные приложения уходят каскадом. */
  deleteUser(userId: string): Promise<void>;
}
