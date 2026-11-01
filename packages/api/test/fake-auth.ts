import type { AuthGateway, SessionUser } from '../src';

/** Сессии без Better Auth: cookie `session=<token>`, выданный signIn. Только для тестов. */
export class FakeAuth implements AuthGateway {
  private readonly sessions = new Map<string, SessionUser>();

  signIn(user: SessionUser): string {
    const token = crypto.randomUUID();
    this.sessions.set(token, user);
    return token;
  }

  async handler(req: Request): Promise<Response> {
    return new Response(`fake auth: ${new URL(req.url).pathname}`, { status: 200 });
  }

  async session(headers: Headers): Promise<SessionUser | undefined> {
    const token = /(?:^|;\s*)session=([^;]+)/.exec(headers.get('cookie') ?? '')?.[1];
    return token ? this.sessions.get(token) : undefined;
  }
}
