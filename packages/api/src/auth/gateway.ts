/** Пользователь сессии — то, что API знает о нём из авторизации. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
}

/** Авторизация за интерфейсом: в бою Better Auth, в юнит-тестах маршрутов — FakeAuth. */
export interface AuthGateway {
  /** Обработчик /api/auth/* (вход, колбэки OAuth, magic link, выход). */
  handler(req: Request): Promise<Response>;
  /** Пользователь сессии из cookie запроса; undefined — сессии нет или она истекла. */
  session(headers: Headers): Promise<SessionUser | undefined>;
}
