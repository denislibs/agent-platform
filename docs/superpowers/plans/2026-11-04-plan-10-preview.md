# План 10: превью сайта

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собранный агентом статический сайт открывается прямо в панели «Agent's computer» с отдельного хоста и кликается там, не получая доступа к приложению и сессии пользователя.

**Architecture:** Файлы отдаются из S3, а не через порт песочницы, поэтому превью переживает её удаление и не ходит в её сеть. Доступ несёт сам хост: `<id задачи>-<неделя>-<MAC>.<PREVIEW_HOST>`. Проверка в самом начале `createApp` отправляет любой запрос на такой хост в один обработчик, и маршруты приложения там недостижимы. nginx ведёт эти хосты в API отдельным server-блоком только для чтения, CSP приложения получает `frame-src` на них, а `ComputerPanel` показывает сайт во фрейме с переключателем Preview / Activity.

**Tech Stack:** Bun 1.4.2, TypeScript 7, bun:test, Hono, zod, `node:crypto`, nginx 1.28, Docker Compose, Preact, `@preact/signals`, ui-kit `@agent/ui`, Playwright.

Дорожная карта: [2026-10-31-roadmap.md](2026-10-31-roadmap.md). Спецификация: [2026-10-31-agent-platform-design.md](../specs/2026-10-31-agent-platform-design.md), разделы 10, 12, 15.

## Global Constraints

- Перед каждым коммитом — `bun run format` и `bun run check` без ошибок и предупреждений.
- `bun run test:unit` не требует Docker и сети и зелёный в конце каждой задачи.
- Команды с инфраструктурой (`bun run test`, `bun test` без путей, `bun run test:e2e:web`, `bun run prod:smoke`, `stack:*`, `infra:*`) — только из основного checkout, где есть `.env.test`. Копия без этого файла уйдёт на стек разработки. `.env` и `.env.test` не менять.
- Комментарии в коде и документы — на русском; тексты интерфейса, имена тестов, сообщения API и тексты для моделей — на английском.
- Внешний вид — только из ui-kit: своего CSS в `apps/web` нет.
- Новых зависимостей и миграций нет, новых опубликованных портов нет: предположения `packages/sandbox/test/docker-security.test.ts` не меняются.
- Сообщение коммита заканчивается строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Правки существующих файлов даны в виде diff (номера строк — после предыдущей задачи).
- Вне плана: публичная публикация (план 11), свои домены, приложения с сервером, живое превью во время работы, кнопка «поделиться».

## Решения

- **Метка хоста.** `<32 hex id задачи>-<неделя в base-36>-<24 hex MAC>`, 61 символ при трёхзначной неделе, предел DNS — 63. Неделя начинается в понедельник: `floor((ms + 3 дня) / 7 дней)` по порту `Clock`. MAC — HMAC-SHA256 по `<hex>:<неделя>`, сравнение через `timingSafeEqual`. Действуют текущая и прошлая неделя, будущая нет, поэтому ссылка живёт не дольше двух недель. Запись недели с нулём впереди отклоняется: это был бы другой origin с тем же MAC. Токена в адресе и cookie нет: cookie третьей стороны блокируется во фрейме, а префикс пути сломал бы абсолютные `/assets/...` сборки Vite.
- **Ключ.** `PREVIEW_SECRET` или HMAC от `BETTER_AUTH_SECRET` с постоянной меткой, поэтому байты секрета входа не используются. `node:crypto` — только в `packages/api`: `@agent/shared` попадает в бандл браузера. `PREVIEW_HOST` без обоих секретов — ошибка `loadConfig`.
- **Проверка в `loadConfig`.** Приложение на `PREVIEW_HOST` или под ним, а равно `PREVIEW_HOST` под приложением, — ошибка. Иначе API отдавал бы превью вместо приложения или cookie родительского домена дошли бы до кода агента. Исключение — `localhost`: у него и нужен `preview.localhost`, а host-only cookie на поддомены не уходят. Соседа на том же домене (`preview.example.com` при `app.example.com`) без списка публичных суффиксов не отличить: это проверка в `docs/beta-checklist.md`. Бриф этого не требовал, но без неё опечатка отключает приложение.
- **Изоляция.** `app.use` первым после `onError` и `notFound`, и только если `PREVIEW_HOST` задан. Сравнивается имя: нижний регистр, без порта и завершающей точки, потому что nginx передаёт `Host $host` без порта, а прямой запрос к API — с портом. Сам `PREVIEW_HOST` без метки тоже попадает в обработчик. Заголовок `Host` не подделать через nginx: чужое имя получает 444.
- **`/api/*` на хосте превью и маршрутизация на клиенте.** Запрет `/api/*` и «неизвестный путь без расширения — точка входа» противоречат друг другу: `/api/me` стал бы главной страницей. Поэтому `api` и `api/...` из этого правила исключены и дают 404. Файл, выданный как `dist/api/data.json`, отдаётся: это сам сайт, а не маршрут приложения.
- **Какие файлы.** Строки `output` задачи; удалённая задача — просто сайт без файлов, каскад их уже убрал, отдельное чтение `tasks` не нужно. Совпадение точное: `about/index.html` на `/about/` не отдаётся, многостраничному сайту это нужно — пункт в `backlog.md`. Путь берётся из сырого `req.url`: разбор через `URL` склеил бы `..` раньше проверки.
- **Ответы.** Любая неудача — один и тот же 404 с теми же заголовками, в том числе не GET и не HEAD: nginx их до API не пускает (403), но API не полагается на это. HEAD и 304 не читают объект: размер и ETag есть в строке. ETag из id файла и `createdAt` надёжен: `upsertOutput` обновляет `createdAt` при новой версии. `If-None-Match` сравнивается слабо, потому что `gzip on` в prod-nginx превращает ETag в `W/"…"`. Сбой S3 идёт в общий `onError`: 500 без подробностей и запись в журнал без имени хоста.
- **Файлы целиком в память.** В порту `FileStore` потока нет: `getBytes` делает `arrayBuffer()`. Предел — `UPLOAD_MAX_BYTES` (50 МиБ, тот же, что у чтения из песочницы), больший файл — 404. Новый метод порта с контрактным тестом ради беты не окупается: нагрузку держит `limit_req`, остальное в `backlog.md`.
- **nginx.** Отдельный server-блок с регулярным `server_name`, `limit_except GET`, своя зона `preview` на 50 r/s с запасом 200: одна страница тянет десятки файлов. Тела нет: `client_max_body_size 1` и `proxy_pass_request_body off`. Cookie и `Authorization` срезаются ещё здесь. `add_header` нет, поэтому CSP приложения не ложится поверх. Формат access-лога хост не пишет, и тест это держит: в хосте MAC. В prod имя и `frame-src` выводит `preview-host.envsh` из `PREVIEW_HOST` и схемы `APP_ORIGIN`; без `PREVIEW_HOST` имя `previews-are-off\.invalid` ничему не совпадает, а `frame-src 'none'`.
- **CSP приложения.** `frame-src` теперь указан всегда: раньше фреймы подчинялись `default-src 'self'`. `prod:smoke` получает `PREVIEW_HOST` и проверяет хост превью через сокет.
- **Панель.** Сайт открывается сам, когда цикл закончился (`isTerminalTask`) и есть `preview`; новый цикл возвращает к Activity. Эффект зависит только от этих двух условий, поэтому перечитывание карточки не отменяет выбор пользователя, а сайт, появившийся на `finalizing`, не отвлекает. Фрейм снимается при переключении на Activity: возврат загружает сайт заново, `localStorage` при этом остаётся. Ключ перезагрузки — цикл, число файлов и самое новое `createdAt`: адрес постоянен неделю, по нему перезагрузку не поймать.
- **Узкие экраны.** Ниже 900 пикселей панель стоит под диалогом, и фрейм получает `min-height: 70svh`. От 901 до 1100 панель скрыта (`display: none` в `layout.css`), поэтому в строке результата есть ссылка `Open preview`.
- **`allow-same-origin`.** Намеренное отличие от прежнего текста дорожной карты: без него `localStorage` бросает исключение и обычное React-приложение падает. Безопасно, потому что origin превью никогда не совпадает с origin приложения. oxlint считает это сочетание ошибкой (`react/iframe-missing-sandbox`), поэтому строка отключена с объяснением в комментарии.
- **Промпт и `outputs/`.** Бриф говорит «выдать собранную папку вроде `dist/`», но `finish` принимает только пути файлов, а целиком композер обходит только `outputs/`. Поэтому промпт просит копировать сборку в `outputs/`, например `outputs/dist/`: она придёт со всеми файлами, сколько бы их ни было в подсказке модели (`WORKSPACE_HINT_FILES` = 200). `MAX_DELIVERED_FILES` = 500 хватает: сборка Vite — это десятки файлов, а превышение помечается как потеря, не тихо. `node_modules` пропускается, `dist` выдаётся, как и раньше; тест композера это закрепляет.
- **Тесты с фреймами.** В happy-dom `disableIframePageLoading`: иначе юнит-тест пошёл бы в сеть за `src` фрейма.
- **Сквозной тест.** `web-stack.ts` сам задаёт `PREVIEW_HOST=preview.localhost:<порт API>` и тестовый `PREVIEW_SECRET`: браузер идёт на этот процесс напрямую, без nginx, Chromium резолвит `*.localhost` сам. Vite получает то же значение из `playwright.config.ts` для `frame-src`. `.env.test` не меняется. Safari может не резолвить `*.localhost`: это только разработка, в продакшене домен настоящий.
- **Evals.** Промпт меняется на три строки, evals в этом плане не запускаются, поэтому статус в дорожной карте это говорит прямо, как у планов 8 и 9.

---

### Task 1: Настройки и подпись хоста

**Files:**

- Create: `packages/api/src/preview/token.ts`
- Modify: `packages/shared/src/config.ts`
- Modify: `packages/api/src/index.ts`
- Test: `packages/shared/test/config.test.ts`, `packages/api/test/unit/preview-token.test.ts`

**Interfaces:**

- Consumes: `loadConfig`, `Config` из `@agent/shared`.
- Produces: `Config['preview']: { host: string; hostname: string; secret: string | null } | null` (`host` с портом, `hostname` без него, оба в нижнем регистре); из `packages/api/src`: `previewWeek(now: Date): number`, `previewSigningKey(preview: { secret: string | null }, authSecret: string | null): Uint8Array`, `previewLabel(taskId: string, now: Date, key: Uint8Array): string | null`, `verifyPreviewLabel(label: string, now: Date, key: Uint8Array): string | null` (возвращает id задачи с дефисами).
- Result: метку можно выдать и проверить; приложение пока её не использует.

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/config.test.ts`:

```diff
@@ -252,2 +252,41 @@ describe('blank values', () => {
   });
 });
+
+const secret = 'p'.repeat(32);
+const authSecret = 'a'.repeat(32);
+const previewApp = (url: string, host: string) => () =>
+  loadConfig({ ...base, PREVIEW_SECRET: secret, BETTER_AUTH_URL: url, PREVIEW_HOST: host });
+
+describe('preview settings', () => {
+  test('previews are off without PREVIEW_HOST; a blank value is unset', () => {
+    expect(loadConfig(base).preview).toBeNull();
+    expect(loadConfig({ ...base, PREVIEW_HOST: ' ', BETTER_AUTH_SECRET: authSecret }).preview).toBeNull();
+  });
+
+  test('PREVIEW_HOST keeps the port for links and lowercases the name', () => {
+    const c = loadConfig({ ...base, PREVIEW_HOST: 'Preview.LOCALHOST:8080', BETTER_AUTH_SECRET: authSecret });
+    expect(c.preview).toEqual({ host: 'preview.localhost:8080', hostname: 'preview.localhost', secret: null });
+  });
+
+  test('PREVIEW_HOST is a bare host[:port]: no scheme, path or wildcard', () => {
+    for (const host of ['http://preview.localhost', 'preview.localhost/x', '*.preview.localhost', 'a b', 'host:port'])
+      expect(() => loadConfig({ ...base, PREVIEW_HOST: host, PREVIEW_SECRET: secret })).toThrow(/PREVIEW_HOST/);
+  });
+
+  test('previews need a key: PREVIEW_SECRET or BETTER_AUTH_SECRET', () => {
+    expect(() => loadConfig({ ...base, PREVIEW_HOST: 'preview.localhost' })).toThrow(
+      /PREVIEW_HOST needs PREVIEW_SECRET or BETTER_AUTH_SECRET/,
+    );
+    const c = loadConfig({ ...base, PREVIEW_HOST: 'preview.localhost', PREVIEW_SECRET: secret });
+    expect(c.preview?.secret).toBe(secret);
+    expect(() => loadConfig({ ...base, PREVIEW_SECRET: 'short' })).toThrow(/PREVIEW_SECRET/);
+  });
+
+  test('the app can live neither under the preview host nor above it; localhost is the one exception', () => {
+    expect(previewApp('https://app.example.com', 'app.example.com')).toThrow(/same host/);
+    expect(previewApp('https://app.example.com', 'example.com')).toThrow(/same host/);
+    expect(previewApp('https://app.example.com', 'preview.app.example.com')).toThrow(/same host/);
+    expect(previewApp('http://localhost:8080', 'preview.localhost:8080')).not.toThrow();
+    expect(previewApp('https://app.example.com', 'example-usercontent.net')).not.toThrow();
+  });
+});
```

`packages/api/test/unit/preview-token.test.ts` (новый файл):

```ts
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { previewLabel, previewSigningKey, previewWeek, verifyPreviewLabel } from '../../src';

const TASK = '0190f5a2-7b1c-7def-8123-456789abcdef';
const OTHER = '0190f5a2-7b1c-7def-8123-456789abcde0';
const KEY = new TextEncoder().encode('k'.repeat(32));
const NOW = new Date('2026-11-04T12:00:00.000Z');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const weeksLater = (n: number) => new Date(NOW.getTime() + n * WEEK_MS);
const label = (taskId = TASK, at = NOW) => previewLabel(taskId, at, KEY)!;

describe('preview label', () => {
  test('is one lowercase DNS label: 32 hex of the task id, the week, a 24-hex MAC', () => {
    const l = label();
    expect(l).toMatch(/^0190f5a27b1c7def8123456789abcdef-[0-9a-z]+-[0-9a-f]{24}$/);
    expect(l.length).toBeLessThanOrEqual(63);
    expect(l.split('-')[1]).toBe(previewWeek(NOW).toString(36));
  });

  test('a task id that is not a UUID gets no label', () => {
    expect(previewLabel('task-1', NOW, KEY)).toBeNull();
  });

  test('the origin stays the same within a week and changes on Monday', () => {
    expect(label(TASK, new Date('2026-11-02T00:00:00.000Z'))).toBe(label(TASK, new Date('2026-11-08T23:59:59.000Z')));
    expect(label(TASK, new Date('2026-11-08T23:59:59.000Z'))).not.toBe(
      label(TASK, new Date('2026-11-09T00:00:00.000Z')),
    );
  });

  test('valid: returns the dashed task id', () => {
    expect(verifyPreviewLabel(label(), NOW, KEY)).toBe(TASK);
  });

  test('the previous week still validates; two weeks back and the future do not', () => {
    expect(verifyPreviewLabel(label(), weeksLater(1), KEY)).toBe(TASK);
    expect(verifyPreviewLabel(label(), weeksLater(2), KEY)).toBeNull();
    expect(verifyPreviewLabel(label(TASK, weeksLater(1)), NOW, KEY)).toBeNull();
  });

  test('a wrong MAC or the MAC of another task is rejected', () => {
    const [hex, week, mac] = label().split('-') as [string, string, string];
    const flipped = `${mac[0] === '0' ? '1' : '0'}${mac.slice(1)}`;
    expect(verifyPreviewLabel(`${hex}-${week}-${flipped}`, NOW, KEY)).toBeNull();
    const otherMac = label(OTHER).split('-')[2];
    expect(verifyPreviewLabel(`${hex}-${week}-${otherMac}`, NOW, KEY)).toBeNull();
  });

  test('a label signed with another key is rejected', () => {
    expect(verifyPreviewLabel(previewLabel(TASK, NOW, new TextEncoder().encode('x'.repeat(32)))!, NOW, KEY)).toBeNull();
  });

  test('an uppercase host is the same host', () => {
    expect(verifyPreviewLabel(label().toUpperCase(), NOW, KEY)).toBe(TASK);
  });

  test('a label too long or malformed is rejected', () => {
    const l = label();
    for (const bad of [`${l}0`, `${l}-0`, l.slice(1), '', 'x', `${'0'.repeat(32)}--${'0'.repeat(24)}`, `a.${l}`])
      expect(verifyPreviewLabel(bad, NOW, KEY)).toBeNull();
    expect(verifyPreviewLabel('0'.repeat(64), NOW, KEY)).toBeNull();
  });

  test('another spelling of the week is another origin and is rejected', () => {
    const [hex, week] = label().split('-') as [string, string];
    const spelled = `0${week}`;
    const mac = createHmac('sha256', KEY)
      .update(`${hex}:${previewWeek(NOW)}`)
      .digest('hex')
      .slice(0, 24);
    expect(verifyPreviewLabel(`${hex}-${spelled}-${mac}`, NOW, KEY)).toBeNull();
  });
});

describe('previewSigningKey', () => {
  const secret = 'p'.repeat(32);
  const authSecret = 'a'.repeat(32);

  test('PREVIEW_SECRET is used when set', () => {
    expect(previewSigningKey({ secret }, authSecret)).toEqual(new TextEncoder().encode(secret));
  });

  test('the fallback is derived: never the bytes of the auth secret, and stable', () => {
    const key = previewSigningKey({ secret: null }, authSecret);
    expect(Buffer.from(key).equals(Buffer.from(authSecret))).toBe(false);
    expect(key).toEqual(previewSigningKey({ secret: null }, authSecret));
    expect(key).not.toEqual(previewSigningKey({ secret: null }, 'b'.repeat(32)));
  });

  test('without any secret it throws: loadConfig should have refused this', () => {
    expect(() => previewSigningKey({ secret: null }, null)).toThrow(/preview/i);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test packages/shared/test/config.test.ts packages/api/test/unit/preview-token.test.ts`

Expected: FAIL. `preview-token.test.ts` не загружается: `SyntaxError: Export named 'previewLabel' not found`. В `config.test.ts` падают все пять тестов `preview settings`.

- [ ] **Step 3: Implement**

`packages/shared/src/config.ts`:

```diff
@@ -16,4 +16,31 @@ function oauthApp(name: string, clientId: string | undefined, clientSecret: stri
 }
 
+/** host[:port] без схемы и пути; регистр не важен (имена хостов его не различают). */
+const PREVIEW_HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;
+
+const isUnder = (name: string, parent: string) => name === parent || name.endsWith(`.${parent}`);
+
+/**
+ * Превью сайтов включены, только если задан PREVIEW_HOST и есть из чего вывести ключ подписи. Приложение не может жить
+ * на этом хосте или под ним: API отдал бы превью вместо приложения. Поддомен приложения тоже отказ: cookie родительского
+ * домена дошли бы до чужого кода. localhost — исключение для разработки: *.localhost не видит cookie хоста localhost.
+ */
+function previewConfig(
+  host: string | undefined,
+  secret: string | undefined,
+  authSecret: string | undefined,
+  appUrl: string,
+) {
+  if (!host) return null;
+  if (!secret && !authSecret)
+    throw new Error('Invalid environment: PREVIEW_HOST needs PREVIEW_SECRET or BETTER_AUTH_SECRET');
+  const lower = host.toLowerCase();
+  const hostname = lower.split(':', 1)[0]!;
+  const app = new URL(appUrl).hostname;
+  if (isUnder(app, hostname) || (app !== 'localhost' && isUnder(hostname, app)))
+    throw new Error('Invalid environment: PREVIEW_HOST and BETTER_AUTH_URL must not share the same host');
+  return { host: lower, hostname, secret: secret ?? null };
+}
+
 const EnvSchema = z.object({
   DATABASE_URL: required,
@@ -97,4 +124,11 @@ const EnvSchema = z.object({
   GITHUB_CLIENT_ID: optionalText,
   GITHUB_CLIENT_SECRET: optionalText,
+  /** Хост превью сайтов: host[:port], задача открывается на <метка>.<хост>, схема — как у BETTER_AUTH_URL. Пусто — выключено. */
+  PREVIEW_HOST: z.preprocess(blankAsUnset, z.string().regex(PREVIEW_HOST_PATTERN, 'expected host[:port]').optional()),
+  /** Ключ подписи адресов превью; не задан — выводится из BETTER_AUTH_SECRET (packages/api/src/preview/token.ts). */
+  PREVIEW_SECRET: z.preprocess(
+    blankAsUnset,
+    z.string().min(32, 'at least 32 characters (openssl rand -hex 32)').optional(),
+  ),
   /** Почта magic link: smtp(s)://user:password@host:port. Без него письма пишутся в журнал API (LogMailer). */
   SMTP_URL: z.preprocess(blankAsUnset, z.url({ protocol: /^smtps?$/ }).optional()),
@@ -190,4 +224,5 @@ export function loadConfig(env: Record<string, string | undefined> = process.env
       github: oauthApp('GITHUB', e.GITHUB_CLIENT_ID, e.GITHUB_CLIENT_SECRET),
     },
+    preview: previewConfig(e.PREVIEW_HOST, e.PREVIEW_SECRET, e.BETTER_AUTH_SECRET, e.BETTER_AUTH_URL),
     mail: mailConfig(e.SMTP_URL, e.MAIL_FROM),
   };
```

`packages/api/src/preview/token.ts` (новый файл):

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** 1 января 1970 — четверг: сдвиг на три дня начинает неделю с понедельника, как в ISO. */
const MONDAY_OFFSET_MS = 3 * DAY_MS;
/** Длина MAC в шестнадцатеричных символах: 96 бит; вся метка остаётся короче 63 символов одной метки DNS. */
const MAC_HEX = 24;
const LABEL = new RegExp(`^([0-9a-f]{32})-([0-9a-z]{1,4})-([0-9a-f]{${MAC_HEX}})$`);
const UUID_HEX = /^[0-9a-f]{32}$/;
/** Метка вывода ключа: ключ превью не совпадает с BETTER_AUTH_SECRET ни одним байтом. */
const KEY_LABEL = 'agent-platform/preview-key/v1';

/** Номер недели (ISO-подобной, с понедельника) от эпохи. */
export const previewWeek = (now: Date): number => Math.floor((now.getTime() + MONDAY_OFFSET_MS) / WEEK_MS);

/** Ключ подписи: PREVIEW_SECRET или HMAC от BETTER_AUTH_SECRET с постоянной меткой. */
export function previewSigningKey(preview: { secret: string | null }, authSecret: string | null): Uint8Array {
  if (preview.secret) return new TextEncoder().encode(preview.secret);
  if (!authSecret) throw new Error('preview signing key: neither PREVIEW_SECRET nor BETTER_AUTH_SECRET is set');
  return new Uint8Array(createHmac('sha256', authSecret).update(KEY_LABEL).digest());
}

const macOf = (hex: string, week: number, key: Uint8Array): string =>
  createHmac('sha256', key).update(`${hex}:${week}`).digest('hex').slice(0, MAC_HEX);

/**
 * Метка хоста превью: <32 hex id задачи>-<неделя в base-36>-<MAC>. Доступ несёт сам хост: ни токена в адресе, ни cookie.
 * Origin постоянен неделю, поэтому localStorage сайта живёт между открытиями. id не UUID — null.
 */
export function previewLabel(taskId: string, now: Date, key: Uint8Array): string | null {
  const hex = taskId.replaceAll('-', '').toLowerCase();
  if (!UUID_HEX.test(hex)) return null;
  const week = previewWeek(now);
  return `${hex}-${week.toString(36)}-${macOf(hex, week, key)}`;
}

/**
 * id задачи из метки или null. Действуют текущая и прошлая неделя: адрес живёт не дольше двух недель и не годится как
 * бесплатный хостинг. Другая запись той же недели (0 впереди) — другой origin, поэтому отказ.
 */
export function verifyPreviewLabel(label: string, now: Date, key: Uint8Array): string | null {
  const match = LABEL.exec(label.toLowerCase());
  if (!match) return null;
  const [, hex, weekText, mac] = match as unknown as [string, string, string, string];
  const week = Number.parseInt(weekText, 36);
  const current = previewWeek(now);
  const fresh = week.toString(36) === weekText && (week === current || week === current - 1);
  const valid = timingSafeEqual(Buffer.from(mac), Buffer.from(macOf(hex, week, key)));
  if (!fresh || !valid) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
```

`packages/api/src/index.ts`:

```diff
@@ -18,2 +18,3 @@ export * from './account-deletion';
 export * from './admin/grant';
 export * from './admin/delete-user';
+export * from './preview/token';
```

- [ ] **Step 4: Run them and see them pass**

Run:

```bash
bun test packages/shared/test/config.test.ts packages/api/test/unit/preview-token.test.ts
bun run format && bun run check
bun run test:unit
```

Expected: PASS, без предупреждений.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add packages/shared/test/config.test.ts packages/api/test/unit/preview-token.test.ts packages/shared/src/config.ts packages/api/src/preview/token.ts packages/api/src/index.ts
git commit -m "feat: preview settings and signed hostnames

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Хост превью в API и адрес в карточке задачи

**Files:**

- Create: `packages/api/src/preview/site.ts`
- Create: `packages/api/src/preview/handler.ts`
- Modify: `packages/shared/src/api.ts`
- Modify: `packages/api/src/app.ts`
- Modify: `packages/api/src/routes/tasks.ts`
- Modify: `packages/api/src/index.ts`
- Test: `packages/api/test/unit/preview.test.ts`, `apps/web/test/app.test.tsx`, `apps/web/test/fixtures.ts`

**Interfaces:**

- Consumes: `Config['preview']`, `previewLabel`, `previewSigningKey`, `verifyPreviewLabel` (задача 1); `FileRepository.listForTask(taskId, kind?)`, `FileStore.getBytes(key)`.
- Produces: `TaskResponse.preview: { url: string } | null`; `findPreviewSite(files: readonly FileRecord[]): PreviewSite | null`, `previewRequestPath(url: string): string | null`, `resolvePreviewFile(site: PreviewSite, path: string): FileRecord | null`, `previewContentType(path: string): string`, `isPreviewRequest(preview: { hostname: string }, host: string | undefined): boolean`, `taskPreview(config: Config, taskId: string, files: readonly FileRecord[], now: Date): TaskResponse['preview']`, `servePreview(deps: ApiDeps, req: Request): Promise<Response>`.
- Result: API отдаёт сайт задачи на её хосте и ничего больше; владелец видит адрес в `GET /api/tasks/:id`.

- [ ] **Step 1: Write the failing tests**

`packages/api/test/unit/preview.test.ts` (новый файл):

```ts
import { describe, expect, test } from 'bun:test';
import { TaskResponseSchema } from '@agent/shared';
import { previewLabel, previewRequestPath, previewSigningKey } from '../../src';
import { setupApi } from './helpers';

const SECRET = 'p'.repeat(32);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type Files = Record<string, string>;

/** Разбор сырого адреса: Request склеил бы «..» раньше, поэтому формы проверяются и без него. */
const at = (target: string) => previewRequestPath(`http://h${target}`);

/** API с включёнными превью; addTask создаёт задачу с выданными файлами. */
async function setup(env: Record<string, string> = {}) {
  const t = setupApi({
    PREVIEW_HOST: 'preview.test:8080',
    PREVIEW_SECRET: SECRET,
    MAX_ACTIVE_TASKS_PER_USER: '100',
    ...env,
  });
  const owner = await t.signIn();
  const { c } = t;

  async function addTask(files: Files) {
    const task = await c.intake.create({ userId: owner.user.id, prompt: 'Build a site' });
    for (const [path, content] of Object.entries(files)) {
      const storageKey = `tasks/${task.id}/${path}`;
      await c.fileStore.put(storageKey, content);
      await c.files.upsertOutput({
        userId: owner.user.id,
        taskId: task.id,
        path,
        storageKey,
        size: new TextEncoder().encode(content).length,
        mime: 'application/octet-stream',
      });
    }
    return task;
  }

  const hostOf = (taskId: string) =>
    `${previewLabel(taskId, c.clock.now(), previewSigningKey(c.config.preview!, null))}.preview.test`;

  /** Запрос на хост превью задачи, как его передаёт nginx (без порта). */
  const get = (taskId: string, path = '/', init: { method?: string; headers?: Record<string, string> } = {}) =>
    t.app.request(path, { method: init.method ?? 'GET', headers: { host: hostOf(taskId), ...init.headers } });

  return { ...t, owner, addTask, hostOf, get };
}

const SITE: Files = {
  'dist/index.html': '<h1>Home</h1>',
  'dist/assets/app.js': 'console.log(1)',
  'dist/assets/app.css': 'body{}',
  'dist/logo.png': 'png',
  'outputs/report.csv': 'a,b',
};

describe('the preview host is isolated', () => {
  test('/api/* on a preview host is 404 and no session is ever read', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    let sessions = 0;
    const real = t.auth.session.bind(t.auth);
    t.auth.session = headers => {
      sessions++;
      return real(headers);
    };
    const cookie = t.owner.headers.cookie;
    for (const path of ['/api/me', '/api/health', '/api/config', '/api/tasks', '/api', '/api/auth/session']) {
      const res = await t.get(task.id, path, { headers: { cookie } });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(sessions).toBe(0);
  });

  test('a delivered file under api/ is still the site: only the app routes are out of reach', async () => {
    const t = await setup();
    const task = await t.addTask({ ...SITE, 'dist/api/data.json': '{"a":1}' });
    expect(await (await t.get(task.id, '/api/data.json')).text()).toBe('{"a":1}');
  });

  test('any host under PREVIEW_HOST goes to the handler: the bare host, a bad label, another case, with a port', async () => {
    const t = await setup();
    for (const host of [
      'preview.test',
      'preview.test:8080',
      'nope.preview.test',
      'PREVIEW.TEST',
      'a.b.preview.test.',
    ]) {
      const res = await t.app.request('/api/health', { headers: { host } });
      expect({ host, status: res.status }).toEqual({ host, status: 404 });
    }
  });

  test('the host with a port and in uppercase serves the same site', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const host = t.hostOf(task.id);
    for (const form of [`${host}:8080`, host.toUpperCase(), `${host}.`]) {
      const res = await t.app.request('/', { headers: { host: form } });
      expect({ form, body: await res.text() }).toEqual({ form, body: '<h1>Home</h1>' });
    }
  });

  test('the hosts of the app never reach the handler', async () => {
    const t = await setup();
    for (const host of ['localhost:8080', '[::1]:8080', 'notpreview.test', 'preview.test.evil.example']) {
      const res = await t.app.request('/api/health', { headers: { host } });
      expect({ host, status: res.status }).toEqual({ host, status: 200 });
    }
  });

  test('with previews off a preview host is an ordinary request', async () => {
    const t = setupApi();
    expect(t.c.config.preview).toBeNull();
    expect((await t.app.request('/api/health', { headers: { host: 'x.preview.test' } })).status).toBe(200);
  });
});

const failure = async (res: Response) => ({
  status: res.status,
  body: await res.text(),
  type: res.headers.get('content-type'),
});

describe('every failure is the same 404', () => {
  test('bad MAC, another task, expired week, no entry, deleted task, unknown file: identical answers', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const other = await t.addTask(SITE);
    const noEntry = await t.addTask({ 'outputs/report.csv': 'a,b' });
    const expected = await failure(await t.get(task.id, '/missing.js'));
    expect(expected.status).toBe(404);
    expect(expected.body).toBe('Not found');

    const [hex, week, mac] = t.hostOf(task.id).split('.')[0]!.split('-') as [string, string, string];
    const otherMac = t.hostOf(other.id).split('.')[0]!.split('-')[2];
    const flipped = `${mac[0] === '0' ? '1' : '0'}${mac.slice(1)}`;
    for (const host of [`${hex}-${week}-${flipped}.preview.test`, `${hex}-${week}-${otherMac}.preview.test`])
      expect(await failure(await t.app.request('/', { headers: { host } }))).toEqual(expected);

    expect(await failure(await t.get(noEntry.id))).toEqual(expected);

    const stale = t.hostOf(task.id);
    t.c.clock.advance(2 * WEEK_MS);
    expect(await failure(await t.app.request('/', { headers: { host: stale } }))).toEqual(expected);
    t.c.clock.advance(-2 * WEEK_MS);

    await t.c.tasks.delete(other.id);
    expect(await failure(await t.get(other.id))).toEqual(expected);
  });

  test('a link of the previous week still works', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const host = t.hostOf(task.id);
    t.c.clock.advance(WEEK_MS);
    expect((await t.app.request('/', { headers: { host } })).status).toBe(200);
  });

  test('a row whose object is gone is the same 404', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    await t.c.fileStore.delete(`tasks/${task.id}/dist/logo.png`);
    expect((await t.get(task.id, '/logo.png')).status).toBe(404);
  });

  test('a file above the size limit is not read', async () => {
    const t = await setup({ UPLOAD_MAX_BYTES: '4' });
    const task = await t.addTask({ 'index.html': '<p>home</p>', 'big.js': '12345' });
    expect((await t.get(task.id, '/big.js')).status).toBe(404);
  });

  test('only GET and HEAD: other methods are 404 even on a valid host', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
      expect({ method, status: (await t.get(task.id, '/', { method })).status }).toEqual({ method, status: 404 });
  });
});

describe('which files', () => {
  test('entry order: dist, outputs/dist, build, outputs/build, outputs, the workspace root', async () => {
    const t = await setup();
    const order = [
      'dist/index.html',
      'outputs/dist/index.html',
      'build/index.html',
      'outputs/build/index.html',
      'outputs/index.html',
      'index.html',
    ];
    for (let i = 0; i < order.length; i++) {
      const files = Object.fromEntries(order.slice(i).map(path => [path, path]));
      const task = await t.addTask(files);
      expect(await (await t.get(task.id)).text()).toBe(order[i]!);
    }
  });

  test('the folder of the entry is the root: absolute asset paths work, files outside it do not', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    expect(await (await t.get(task.id, '/assets/app.js')).text()).toBe('console.log(1)');
    expect((await t.get(task.id, '/outputs/report.csv')).status).toBe(404);
    expect((await t.get(task.id, '/dist/index.html')).status).toBe(404);
  });

  test('an input file is not a site', async () => {
    const t = await setup();
    const task = await t.addTask({});
    await t.c.files.insert({
      userId: t.owner.user.id,
      taskId: task.id,
      kind: 'input',
      path: 'index.html',
      storageKey: `inputs/${t.owner.user.id}/x/index.html`,
      size: 1,
      mime: 'text/html',
    });
    expect((await t.get(task.id)).status).toBe(404);
  });

  test('client-side routing: an unknown path without an extension is the entry, with one is 404', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    for (const path of ['/todos', '/todos/42', '/about/'])
      expect(await (await t.get(task.id, path)).text()).toBe('<h1>Home</h1>');
    expect((await t.get(task.id, '/todos/app.js')).status).toBe(404);
    expect((await t.get(task.id, '/favicon.ico')).status).toBe(404);
  });

  test('a running task still serves what was delivered', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    await t.c.tasks.transition(task.id, 'planning', { currentKind: 'plan' });
    expect((await t.get(task.id)).status).toBe(200);
  });

  test('the query string is not part of the path', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    expect(await (await t.get(task.id, '/assets/app.js?v=1#x')).text()).toBe('console.log(1)');
  });

  test('a name with spaces and non-ASCII characters is matched after one decoding', async () => {
    const t = await setup();
    const task = await t.addTask({ 'index.html': 'home', 'my file ж.txt': 'text', '100%25.txt': 'literal' });
    expect(await (await t.get(task.id, '/my%20file%20%D0%B6.txt')).text()).toBe('text');
    // Декодируется один раз: %2525 — это буквальное имя 100%25.txt.
    expect(await (await t.get(task.id, '/100%2525.txt')).text()).toBe('literal');
  });
});

describe('a path can never escape', () => {
  test('previewRequestPath takes the raw target and rejects every escaping form', () => {
    expect(at('/')).toBe('');
    expect(at('/a/b.js?x=1')).toBe('a/b.js');
    expect(at('/a/b/')).toBe('a/b');
    expect(at('/a%20b')).toBe('a b');
    for (const bad of [
      '/../secret.txt',
      '/a/../../secret.txt',
      '/./a',
      '/a//b',
      '//a',
      '/%2e%2e/secret.txt',
      '/%2E%2E%2Fsecret.txt',
      '/a%2fb',
      '/a%2Fb',
      '/a%5cb',
      '/a\\b',
      '/..\\secret.txt',
      '/a%00.js',
      '/%zz',
    ])
      expect({ bad, path: at(bad) }).toEqual({ bad, path: null });
  });

  test('through the app: traversal and encoded forms never reach a file outside the root', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    for (const path of [
      '/%2e%2e/outputs/report.csv',
      '/..%2foutputs/report.csv',
      '/..%2Foutputs%2Freport.csv',
      '/..%5coutputs%5creport.csv',
      '/assets%2fapp.js',
      '/app.js%00.png',
      '/%252e%252e%252foutputs%252freport.csv',
    ]) {
      const res = await t.get(task.id, path);
      expect({ path, body: await res.text() }).not.toEqual({ path, body: 'a,b' });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
  });
});

describe('response headers', () => {
  test('content type comes from the extension, not from the stored mime', async () => {
    const t = await setup();
    const types: Record<string, string> = {
      'a.html': 'text/html; charset=utf-8',
      'a.js': 'text/javascript; charset=utf-8',
      'a.mjs': 'text/javascript; charset=utf-8',
      'a.css': 'text/css; charset=utf-8',
      'a.json': 'application/json',
      'a.svg': 'image/svg+xml',
      'a.png': 'image/png',
      'a.jpg': 'image/jpeg',
      'a.jpeg': 'image/jpeg',
      'a.gif': 'image/gif',
      'a.webp': 'image/webp',
      'a.ico': 'image/x-icon',
      'a.woff': 'font/woff',
      'a.woff2': 'font/woff2',
      'a.ttf': 'font/ttf',
      'a.wasm': 'application/wasm',
      'a.map': 'application/json',
      'a.txt': 'text/plain; charset=utf-8',
      'a.xml': 'application/xml',
      'a.bin': 'application/octet-stream',
      'A.JS': 'text/javascript; charset=utf-8',
    };
    const files = Object.fromEntries(Object.keys(types).map(path => [path, 'x']));
    const task = await t.addTask({ 'index.html': 'home', ...files });
    for (const [path, type] of Object.entries(types)) {
      const res = await t.get(task.id, `/${path}`);
      expect({ path, type: res.headers.get('content-type') }).toEqual({ path, type });
    }
  });

  test('security headers on a file and on a 404; no cookies, no HSTS', async () => {
    const t = await setup({ BETTER_AUTH_URL: 'https://app.example.com' });
    const task = await t.addTask(SITE);
    for (const res of [await t.get(task.id), await t.get(task.id, '/missing.js')]) {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(res.headers.get('strict-transport-security')).toBeNull();
      expect(res.headers.get('x-frame-options')).toBeNull();
      expect(res.headers.get('content-security-policy')).toBe(
        "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' https:; " +
          'frame-ancestors https://app.example.com; ' +
          "form-action 'none'; base-uri 'self'",
      );
    }
  });

  test('a strong ETag from the file id and created-at answers 304, and a new version changes it', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const first = await t.get(task.id, '/assets/app.js');
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^"[\w-]+"$/);

    const again = await t.get(task.id, '/assets/app.js', { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
    expect(again.headers.get('content-security-policy')).toContain('frame-ancestors');

    // nginx со сжатием ослабляет ETag: W/ в If-None-Match — тот же файл. Список значений и * — тоже по RFC 9110.
    for (const header of [`W/${etag}`, `"other", ${etag}`, '*'])
      expect((await t.get(task.id, '/assets/app.js', { headers: { 'if-none-match': header } })).status).toBe(304);
    expect((await t.get(task.id, '/assets/app.js', { headers: { 'if-none-match': '"other"' } })).status).toBe(200);

    t.c.clock.advance(1000);
    await t.c.files.upsertOutput({
      userId: t.owner.user.id,
      taskId: task.id,
      path: 'dist/assets/app.js',
      storageKey: `tasks/${task.id}/dist/assets/app.js`,
      size: 2,
      mime: 'application/octet-stream',
    });
    const updated = await t.get(task.id, '/assets/app.js', { headers: { 'if-none-match': etag } });
    expect(updated.status).toBe(200);
    expect(updated.headers.get('etag')).not.toBe(etag);
  });

  test('HEAD: the headers of GET and the size, without reading the object', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const read = t.c.fileStore.getBytes.bind(t.c.fileStore);
    let reads = 0;
    t.c.fileStore.getBytes = key => {
      reads++;
      return read(key);
    };
    const res = await t.get(task.id, '/assets/app.js', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('content-length')).toBe(String('console.log(1)'.length));
    expect(res.headers.get('etag')).toBeTruthy();
    expect(reads).toBe(0);
    expect((await t.get(task.id, '/missing.js', { method: 'HEAD' })).status).toBe(404);
  });

  test('a file of the size limit is served', async () => {
    const t = await setup({ UPLOAD_MAX_BYTES: '5' });
    const task = await t.addTask({ 'index.html': '<p/>', 'ok.js': '12345' });
    expect((await t.get(task.id, '/ok.js')).status).toBe(200);
  });
});

describe('GET /api/tasks/:id', () => {
  test('the owner gets the URL with the scheme of the app and the port of PREVIEW_HOST', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const res = await t.call('GET', `/api/tasks/${task.id}`, { headers: t.owner.headers });
    const body = TaskResponseSchema.parse(await res.json());
    expect(body.preview).toEqual({ url: `http://${t.hostOf(task.id)}:8080/` });
  });

  test('the scheme follows BETTER_AUTH_URL', async () => {
    const t = await setup({ BETTER_AUTH_URL: 'https://app.example.com', PREVIEW_HOST: 'previews.example.net' });
    const task = await t.addTask(SITE);
    const res = await t.call('GET', `/api/tasks/${task.id}`, {
      headers: { ...t.owner.headers, origin: 'https://app.example.com' },
    });
    const url = TaskResponseSchema.parse(await res.json()).preview!.url;
    expect(url).toStartWith('https://');
    expect(url).toEndWith('.previews.example.net/');
  });

  test('another user gets 404 on the task and never the URL', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const stranger = await t.signIn();
    const res = await t.call('GET', `/api/tasks/${task.id}`, { headers: stranger.headers });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('preview.test');
  });

  test('no entry among the outputs, or previews off: preview is null', async () => {
    const t = await setup();
    const task = await t.addTask({ 'outputs/report.csv': 'a,b' });
    const body = await t.call('GET', `/api/tasks/${task.id}`, { headers: t.owner.headers });
    expect(TaskResponseSchema.parse(await body.json()).preview).toBeNull();

    const off = setupApi();
    const owner = await off.signIn();
    const offTask = await off.c.intake.create({ userId: owner.user.id, prompt: 'Build a site' });
    await off.c.files.upsertOutput({
      userId: owner.user.id,
      taskId: offTask.id,
      path: 'index.html',
      storageKey: `tasks/${offTask.id}/index.html`,
      size: 1,
      mime: 'text/html',
    });
    const res = await off.call('GET', `/api/tasks/${offTask.id}`, { headers: owner.headers });
    expect(TaskResponseSchema.parse(await res.json()).preview).toBeNull();
  });

  test('the URL it gives opens the site', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const res = await t.call('GET', `/api/tasks/${task.id}`, { headers: t.owner.headers });
    const { url } = TaskResponseSchema.parse(await res.json()).preview!;
    const page = await t.app.request('/', { headers: { host: new URL(url).host } });
    expect(await page.text()).toBe('<h1>Home</h1>');
  });
});
```

`apps/web/test/app.test.tsx`:

```diff
@@ -36,4 +36,5 @@ const taskRoutes = (...ids: string[]) =>
         subtasks: [],
         files: [],
+        preview: null,
       }),
     ]),
@@ -107,4 +108,5 @@ test('the task route opens the task screen; an unknown path is a not-found page
         subtasks: [],
         files: [],
+        preview: null,
       }),
     },
@@ -228,4 +230,5 @@ const waiting = (id: string) =>
     subtasks: [],
     files: [],
+    preview: null,
   });
 /** Шаги из потока последней открытой задачи. */
```

`apps/web/test/fixtures.ts`:

```diff
@@ -87,5 +87,5 @@ export function fileDto(overrides: Partial<FileDto> = {}): FileDto {
 
 export function taskResponse(overrides: Partial<TaskResponse> = {}): TaskResponse {
-  return { task: taskDetail(), subtasks: [], files: [], ...overrides };
+  return { task: taskDetail(), subtasks: [], files: [], preview: null, ...overrides };
 }
 
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test packages/api/test/unit/preview.test.ts`

Expected: FAIL. Файл не загружается: `SyntaxError: Export named 'previewRequestPath' not found`.

- [ ] **Step 3: Implement**

`packages/shared/src/api.ts`:

```diff
@@ -199,4 +199,6 @@ export const TaskResponseSchema = z.object({
   subtasks: z.array(SubtaskDtoSchema),
   files: z.array(FileDtoSchema),
+  /** Адрес превью сайта (план 10); null — нет точки входа среди выданных файлов или превью выключены. */
+  preview: z.object({ url: z.string() }).nullable(),
 });
 export const TaskListResponseSchema = z.object({
```

`packages/api/src/preview/site.ts` (новый файл):

```ts
import type { FileRecord } from '@agent/core';

/** Где искать точку входа сайта: собранная папка раньше исходников, поэтому исходный index.html Vite не откроется. */
const ENTRY_PATHS = [
  'dist/index.html',
  'outputs/dist/index.html',
  'build/index.html',
  'outputs/build/index.html',
  'outputs/index.html',
  'index.html',
];
const ENTRY_NAME = 'index.html';

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  wasm: 'application/wasm',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
};

/** Тип по расширению. Сохранённому mime верить нельзя: mimeOf финализатора пишет octet-stream для .js. */
export function previewContentType(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return (dot > 0 && CONTENT_TYPES[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

export interface PreviewSite {
  entry: FileRecord;
  /** Папка точки входа с косой на конце (или пусто): корень хоста превью. */
  root: string;
  /** Выданные файлы задачи по пути. */
  files: ReadonlyMap<string, FileRecord>;
}

/** Сайт среди файлов задачи: только результаты (kind output), входной файл сайтом не считается. Нет точки входа — null. */
export function findPreviewSite(files: readonly FileRecord[]): PreviewSite | null {
  const outputs = new Map(files.filter(f => f.kind === 'output').map(f => [f.path, f]));
  for (const path of ENTRY_PATHS) {
    const entry = outputs.get(path);
    if (entry) return { entry, root: path.slice(0, -ENTRY_NAME.length), files: outputs };
  }
  return null;
}

/**
 * Путь запроса без начальной косой, декодированный один раз, или null, если форма запрещена: «..» и «.», пустые сегменты,
 * обратная косая, NUL, закодированная косая. Берётся из сырого адреса: разбор через URL склеил бы «..» раньше проверки.
 */
export function previewRequestPath(url: string): string | null {
  const raw = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0] ?? '';
  if (!raw.startsWith('/') || /%(?:2f|5c)/i.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.slice(1));
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  const segments = decoded.split('/');
  // Косая на конце (/about/) — маршрут сайта; пустым может быть только этот последний сегмент.
  if (segments.at(-1) === '') segments.pop();
  if (segments.some(s => s === '' || s === '.' || s === '..')) return null;
  return segments.join('/');
}

const hasExtension = (path: string) => /\.[^./]+$/.test(path);
/** Запрос к несуществующему API сайта не должен получить HTML: приложение ждёт JSON и упадёт непонятно. */
const isApiPath = (path: string) => path === 'api' || path.startsWith('api/');

/**
 * Файл для пути: точное совпадение под корнем сайта. Неизвестный путь без расширения — точка входа (маршрутизация на
 * клиенте), с расширением или под api/ — нет файла.
 */
export function resolvePreviewFile(site: PreviewSite, path: string): FileRecord | null {
  if (path === '') return site.entry;
  const file = site.files.get(site.root + path);
  if (file) return file;
  return hasExtension(path) || isApiPath(path) ? null : site.entry;
}
```

`packages/api/src/preview/handler.ts` (новый файл):

```ts
import { NotFoundError, type FileRecord } from '@agent/core';
import type { Config, TaskResponse } from '@agent/shared';
import type { ApiDeps } from '../deps';
import { findPreviewSite, previewContentType, previewRequestPath, resolvePreviewFile } from './site';
import { previewLabel, previewSigningKey, verifyPreviewLabel } from './token';

/** Имя хоста из заголовка Host: нижний регистр, без порта и завершающей точки. */
export function previewHostname(host: string): string {
  const lower = host.trim().toLowerCase();
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':', 1)[0]!;
  return name.replace(/\.$/, '');
}

/** Запрос пришёл на хост превью: на сам PREVIEW_HOST или под него. Домен с тем же окончанием (notpreview.test) не считается. */
export function isPreviewRequest(preview: { hostname: string }, host: string | undefined): boolean {
  if (!host) return false;
  const name = previewHostname(host);
  return name === preview.hostname || name.endsWith(`.${preview.hostname}`);
}

/** Адрес превью для карточки задачи: есть точка входа среди выданных файлов и превью включены; иначе null. */
export function taskPreview(
  config: Config,
  taskId: string,
  files: readonly FileRecord[],
  now: Date,
): TaskResponse['preview'] {
  if (!config.preview || !findPreviewSite(files)) return null;
  const label = previewLabel(taskId, now, previewSigningKey(config.preview, config.auth.secret));
  if (!label) return null;
  return { url: `${new URL(config.auth.baseUrl).protocol}//${label}.${config.preview.host}/` };
}

/** Заголовки каждого ответа хоста превью, в том числе 404. CSP разрешает сайту почти всё, кроме встраивания чужими и отправки форм. */
const baseHeaders = (appOrigin: string): Record<string, string> => ({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-cache',
  'content-security-policy':
    "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' https:; " +
    `frame-ancestors ${appOrigin}; form-action 'none'; base-uri 'self'`,
});

/** If-None-Match сравнивается слабо (RFC 9110): nginx со сжатием превращает ETag в W/"…". */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some(tag => {
    const value = tag.trim();
    return value === '*' || value.replace(/^W\//, '') === etag;
  });
}

/**
 * Единственный обработчик хоста превью (createApp отправляет сюда раньше охраны и маршрутов). Доступ несёт метка хоста;
 * cookie и другие заголовки авторизации не читаются. Любая неудача — один и тот же 404: и плохая подпись, и нет файла.
 */
export async function servePreview(deps: ApiDeps, req: Request): Promise<Response> {
  const { config } = deps;
  const preview = config.preview!;
  const base = baseHeaders(new URL(config.auth.baseUrl).origin);
  const notFound = () =>
    new Response('Not found', { status: 404, headers: { ...base, 'content-type': 'text/plain; charset=utf-8' } });

  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound();
  const hostname = previewHostname(req.headers.get('host') ?? '');
  const label = hostname.slice(0, -`.${preview.hostname}`.length);
  const key = previewSigningKey(preview, config.auth.secret);
  const taskId = verifyPreviewLabel(label, deps.clock.now(), key);
  const path = previewRequestPath(req.url);
  if (!taskId || path === null) return notFound();

  // Файлы удаляются вместе с задачей: удалённая задача — это просто сайт без файлов.
  const site = findPreviewSite(await deps.files.listForTask(taskId, 'output'));
  const file = site && resolvePreviewFile(site, path);
  if (!file || file.size > config.api.uploadMaxBytes) return notFound();

  const etag = `"${file.id}-${file.createdAt.getTime()}"`;
  const headers = { ...base, 'content-type': previewContentType(file.path), etag };
  if (matchesEtag(req.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
  if (req.method === 'HEAD') {
    return new Response(null, { headers: { ...headers, 'content-length': String(file.size) } });
  }
  try {
    const bytes = await deps.fileStore.getBytes(file.storageKey);
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers });
  } catch (err) {
    if (err instanceof NotFoundError) return notFound();
    throw err;
  }
}
```

`packages/api/src/app.ts`:

```diff
@@ -6,4 +6,5 @@ import type { ApiDeps, ApiEnv } from './deps';
 import { errorLogFields, mapError } from './errors';
 import { OpenStreams } from './open-streams';
+import { isPreviewRequest, servePreview } from './preview/handler';
 import { configRoutes } from './routes/config';
 import { eventRoutes } from './routes/events';
@@ -42,4 +43,13 @@ export function createApp(deps: ApiDeps, opts: { streams?: OpenStreams } = {}):
   app.notFound(c => c.json({ error: { code: 'not_found', message: 'no such route' } }, 404));
 
+  /*
+   * Хост превью изолирован раньше всего остального: на нём выполняется код агента, поэтому ни охрана, ни маршруты
+   * приложения там недостижимы, cookie не читаются. Без PREVIEW_HOST ветки нет.
+   */
+  const { preview } = deps.config;
+  if (preview) {
+    app.use((c, next) => (isPreviewRequest(preview, c.req.header('host')) ? servePreview(deps, c.req.raw) : next()));
+  }
+
   // Охрана регистрируется раньше всех маршрутов: маршрут, добавленный позже, не окажется без неё.
   const authenticated = requireUser(deps.auth);
```

`packages/api/src/routes/tasks.ts`:

```diff
@@ -13,4 +13,5 @@ import { ApiError } from '../errors';
 import { parseJson, parseQuery } from '../http';
 import { ownTask } from '../ownership';
+import { taskPreview } from '../preview/handler';
 
 export function taskRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
@@ -62,4 +63,6 @@ export function taskRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
       subtasks: subtasks.map(toSubtaskDto),
       files: files.map(toFileDto),
+      // Адрес несёт доступ к сайту, поэтому он только здесь: ownTask уже отказал всем, кроме владельца.
+      preview: taskPreview(deps.config, task.id, files, deps.clock.now()),
     };
     return c.json(response);
```

`packages/api/src/index.ts`:

```diff
@@ -18,3 +18,5 @@ export * from './account-deletion';
 export * from './admin/grant';
 export * from './admin/delete-user';
+export * from './preview/handler';
+export * from './preview/site';
 export * from './preview/token';
```

- [ ] **Step 4: Run them and see them pass**

Run:

```bash
bun test packages/api/test/unit/preview.test.ts
bun run format && bun run check
bun run test:unit
```

Expected: PASS, без предупреждений. Схема теперь требует `preview`, поэтому поправленные фикстуры веб-тестов нужны уже здесь.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add packages/api/test/unit/preview.test.ts apps/web/test/app.test.tsx apps/web/test/fixtures.ts packages/shared/src/api.ts packages/api/src/preview/site.ts packages/api/src/preview/handler.ts packages/api/src/app.ts packages/api/src/routes/tasks.ts packages/api/src/index.ts
git commit -m "feat: the preview host serves delivered files, isolated from the app

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: nginx и CSP приложения

**Files:**

- Create: `docker/nginx/prod/preview-host.envsh`
- Modify: `apps/web/csp.ts`
- Modify: `apps/web/vite.config.ts`
- Modify: `docker/nginx/nginx.conf`
- Modify: `docker/nginx/prod/nginx.conf`
- Modify: `docker/nginx/prod/app.conf.template`
- Modify: `docker/nginx/Dockerfile`
- Modify: `docker/compose.yml`
- Modify: `docker/compose.prod.yml`
- Modify: `.env.example`
- Modify: `.env.prod.example`
- Modify: `scripts/prod-smoke.ts`
- Test: `apps/web/test/csp.test.ts`, `apps/web/test/nginx.test.ts`

**Interfaces:**

- Consumes: `PREVIEW_HOST` как в задаче 1; ответ API на хосте превью из задачи 2.
- Produces: `previewFrameSource(previewHost: string | undefined, appOrigin: string): string`; `CspOptions.frames?: string`; `productionContentSecurityPolicy(s3Origin: string, frames?: string): string`; `PREVIEW_FRAMES_VARIABLE`; переменные шаблона nginx `PREVIEW_FRAME_SRC` и `PREVIEW_SERVER_NAME`.
- Result: браузер доходит до хоста превью через nginx в dev и prod, страница приложения разрешает такой фрейм.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/csp.test.ts`:

```diff
@@ -4,4 +4,5 @@ import {
   contentSecurityPolicy,
   nginxCspTemplate,
+  previewFrameSource,
   productionContentSecurityPolicy,
   scriptHash,
@@ -69,2 +70,22 @@ test('the nginx template carries the hash of the theme script and leaves the S3
   expect(template.match(/"/g)).toHaveLength(2);
 });
+
+test('frames: only the preview hosts, with the scheme of the app; without previews no frames at all', () => {
+  expect(directive('frame-src')).toBe("frame-src 'none'");
+  expect(previewFrameSource(undefined, 'http://localhost:8080')).toBe("'none'");
+  expect(previewFrameSource('', 'http://localhost:8080')).toBe("'none'");
+  expect(previewFrameSource('Preview.Localhost:8080', 'http://localhost:8080')).toBe('http://*.preview.localhost:8080');
+  expect(previewFrameSource('previews.example.net', 'https://app.example.com')).toBe('https://*.previews.example.net');
+  const dev = contentSecurityPolicy({
+    s3Endpoint: 'http://localhost:53900',
+    hmrOrigin: 'ws://localhost:8080',
+    frames: 'http://*.preview.localhost:8080',
+  });
+  expect(dev).toContain('frame-src http://*.preview.localhost:8080;');
+  // Сама страница приложения по-прежнему не встраивается никуда.
+  expect(dev).toContain("frame-ancestors 'none'");
+});
+
+test('the nginx template leaves the frame sources to envsubst', () => {
+  expect(nginxCspTemplate()).toContain('frame-src ${PREVIEW_FRAME_SRC};');
+});
```

`apps/web/test/nginx.test.ts`:

```diff
@@ -33,4 +33,63 @@ test('prod: both app locations carry the generated CSP and the security headers;
 });
 
+/** Server-блок превью: от его server_name до закрывающей скобки в начале строки или с тем же отступом. */
+function previewBlock(conf: string, indent: string): string {
+  const at = conf.indexOf('server_name ~^[0-9a-z-]+');
+  return conf.slice(at, conf.indexOf(`\n${indent}}\n`, conf.indexOf(`\n${indent}  location /`, at)));
+}
+
+test('a preview server block in dev and prod: GET and HEAD only, its own limit, no bodies, no cookies, no app headers', () => {
+  expect(dev).toContain(String.raw`server_name ~^[0-9a-z-]+\.preview\.localhost$;`);
+  expect(app).toContain(String.raw`server_name ~^[0-9a-z-]+\.${'$'}{PREVIEW_SERVER_NAME}$;`);
+  for (const [conf, block] of [
+    [dev, previewBlock(dev, '  ')],
+    [prod, previewBlock(app, '')],
+  ] as const) {
+    expect(conf).toContain('limit_req_zone $binary_remote_addr zone=preview:');
+    expect(conf).toContain('limit_req_status 429;');
+    expect(block).toContain('limit_except GET {');
+    expect(block).toContain('deny all;');
+    expect(block).toContain('limit_req zone=preview');
+    expect(block).toContain('client_max_body_size 1;');
+    expect(block).toContain('proxy_pass_request_body off;');
+    expect(block).toContain("proxy_set_header Content-Length '';");
+    expect(block).toContain("proxy_set_header Cookie '';");
+    expect(block).toContain('proxy_set_header Host $host;');
+    expect(block).toContain('proxy_pass http://api;');
+    // Заголовки безопасности сайта ставит API: CSP приложения поверх них сломала бы сайт.
+    expect(block).not.toContain('add_header');
+    expect(block).not.toContain('include');
+  }
+});
+
+test('the access log does not carry the host: the MAC of a preview stays out of it', () => {
+  for (const conf of [dev, prod]) {
+    const format = conf.match(/log_format app ([^;]+);/)?.[1] ?? '';
+    for (const leak of ['$host', '$http_host', '$server_name']) expect(format).not.toContain(leak);
+  }
+});
+
+const root = new URL('../../../', import.meta.url);
+const text = (path: string) => Bun.file(new URL(path, root)).text();
+
+test('the stacks pass PREVIEW_HOST: to the API for links and to the page for its CSP', async () => {
+  const composeDev = await text('docker/compose.yml');
+  expect(composeDev.match(/PREVIEW_HOST: preview\.localhost:8080/g)).toHaveLength(2);
+  const composeProd = await text('docker/compose.prod.yml');
+  expect(composeProd.match(/PREVIEW_HOST: \$\{PREVIEW_HOST:-\}/g)).toHaveLength(2);
+  expect(composeProd).toContain('PREVIEW_SECRET: ${PREVIEW_SECRET:-}');
+  for (const file of ['.env.example', '.env.prod.example']) {
+    const env = await text(file);
+    expect(env).toContain('# PREVIEW_HOST=');
+    expect(env).toContain('# PREVIEW_SECRET=');
+  }
+});
+
+test('the image installs the preview script before envsubst and substitutes its two variables', async () => {
+  const dockerfile = await text('docker/nginx/Dockerfile');
+  expect(dockerfile).toContain('/docker-entrypoint.d/19-preview-host.envsh');
+  expect(dockerfile).toContain('(APP_HOST|S3_PUBLIC_ORIGIN|PREVIEW_FRAME_SRC|PREVIEW_SERVER_NAME)');
+});
+
 test('prod: real_ip for a TLS load balancer is a commented placeholder, not a guess', () => {
   expect(prod).toMatch(/^\s*# set_real_ip_from /m);
@@ -75,2 +134,51 @@ test('prod: nginx refuses to start on an S3_PUBLIC_ENDPOINT that is not scheme:/
   }
 });
+
+const previewScript = new URL('../../../docker/nginx/prod/preview-host.envsh', import.meta.url).pathname;
+function previewVars(host: string | undefined, appOrigin: string | undefined) {
+  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
+  if (host !== undefined) env.PREVIEW_HOST = host;
+  if (appOrigin !== undefined) env.APP_ORIGIN = appOrigin;
+  const r = Bun.spawnSync(
+    ['sh', '-c', `set -e; . "$0"; printf '%s\\n%s' "$PREVIEW_FRAME_SRC" "$PREVIEW_SERVER_NAME"`, previewScript],
+    { env },
+  );
+  const [frames, serverName] = r.stdout.toString().split('\n');
+  return { code: r.exitCode, frames, serverName };
+}
+
+test('prod: frame sources and the server name come from PREVIEW_HOST and the scheme of APP_ORIGIN', () => {
+  expect(previewVars('previews.example.net', 'https://app.example.com')).toEqual({
+    code: 0,
+    frames: 'https://*.previews.example.net',
+    serverName: String.raw`previews\.example\.net`,
+  });
+  expect(previewVars('Preview.Localhost:58080', 'http://localhost:58080')).toEqual({
+    code: 0,
+    frames: 'http://*.preview.localhost:58080',
+    serverName: String.raw`preview\.localhost`,
+  });
+});
+
+test('prod: without PREVIEW_HOST no frames and a server name that matches nothing', () => {
+  for (const host of [undefined, '']) {
+    expect(previewVars(host, 'https://app.example.com')).toEqual({
+      code: 0,
+      frames: "'none'",
+      serverName: String.raw`previews-are-off\.invalid`,
+    });
+  }
+});
+
+test('prod: nginx refuses to start on a PREVIEW_HOST that is not host[:port], or without an http(s) APP_ORIGIN', () => {
+  for (const host of [
+    'https://previews.example.net',
+    'previews.example.net/x',
+    '*.example.net',
+    'a b',
+    "x;add_header 'y'",
+  ])
+    expect({ host, code: previewVars(host, 'https://app.example.com').code }).toEqual({ host, code: 1 });
+  for (const origin of [undefined, '', 'app.example.com', 'ftp://app.example.com'])
+    expect({ origin, code: previewVars('previews.example.net', origin).code }).toEqual({ origin, code: 1 });
+});
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test/csp.test.ts apps/web/test/nginx.test.ts`

Expected: FAIL. `csp.test.ts` не загружается: `SyntaxError: Export named 'previewFrameSource' not found`. В `nginx.test.ts` падают `a preview server block in dev and prod…`, `the stacks pass PREVIEW_HOST…`, `the image installs the preview script…` и тесты `prod: frame sources…`, `prod: without PREVIEW_HOST…`.

- [ ] **Step 3: Implement**

`apps/web/csp.ts`:

```diff
@@ -21,8 +21,26 @@ export interface CspOptions {
   /** WebSocket HMR dev-сервера, как его видит браузер: ws://localhost:5173 или ws://localhost:8080 за nginx. */
   hmrOrigin: string;
+  /** Источник frame-src: previewFrameSource; не задан — фреймов нет. */
+  frames?: string;
 }
 
-/** Общие директивы CSP приложения; отличаются только соединения и inline-стили. */
-function policy({ connect, inlineStyles }: { connect: readonly string[]; inlineStyles: boolean }): string {
+/**
+ * Источник frame-src для превью сайтов: все хосты задач под PREVIEW_HOST со схемой приложения. Сам PREVIEW_HOST не нужен:
+ * задача всегда открывается на своём хосте. Без PREVIEW_HOST — 'none': встраивать нечего.
+ */
+export function previewFrameSource(previewHost: string | undefined, appOrigin: string): string {
+  return previewHost ? `${new URL(appOrigin).protocol}//*.${previewHost.toLowerCase()}` : "'none'";
+}
+
+/** Общие директивы CSP приложения; отличаются только соединения, inline-стили и фреймы превью. */
+function policy({
+  connect,
+  inlineStyles,
+  frames,
+}: {
+  connect: readonly string[];
+  inlineStyles: boolean;
+  frames: string;
+}): string {
   return [
     "default-src 'self'",
@@ -32,4 +50,5 @@ function policy({ connect, inlineStyles }: { connect: readonly string[]; inlineS
     "font-src 'self'",
     `connect-src 'self' ${connect.join(' ')}`,
+    `frame-src ${frames}`,
     "object-src 'none'",
     "base-uri 'none'",
@@ -44,18 +63,20 @@ function policy({ connect, inlineStyles }: { connect: readonly string[]; inlineS
  * <style>); стили, которые ставят Floating UI и Preact через element.style, CSP не ограничивает.
  */
-export function contentSecurityPolicy({ s3Endpoint, hmrOrigin }: CspOptions): string {
-  return policy({ connect: [new URL(s3Endpoint).origin, hmrOrigin], inlineStyles: true });
+export function contentSecurityPolicy({ s3Endpoint, hmrOrigin, frames = "'none'" }: CspOptions): string {
+  return policy({ connect: [new URL(s3Endpoint).origin, hmrOrigin], inlineStyles: true, frames });
 }
 
 /**
  * CSP продакшен-сборки (nginx, план 7): сборка отдаёт CSS файлами, поэтому без 'unsafe-inline'; HMR нет.
- * s3Origin — origin S3 для браузера или переменная шаблона nginx (S3_ORIGIN_VARIABLE).
+ * s3Origin и frames — значения или переменные шаблона nginx (S3_ORIGIN_VARIABLE, PREVIEW_FRAMES_VARIABLE).
  */
-export function productionContentSecurityPolicy(s3Origin: string): string {
-  return policy({ connect: [s3Origin], inlineStyles: false });
+export function productionContentSecurityPolicy(s3Origin: string, frames = "'none'"): string {
+  return policy({ connect: [s3Origin], inlineStyles: false, frames });
 }
 
 /** Переменная шаблона nginx: origin S3 подставляет envsubst при старте контейнера (docker/nginx/Dockerfile). */
 export const S3_ORIGIN_VARIABLE = '${S3_PUBLIC_ORIGIN}';
+/** Переменная шаблона nginx: источник frame-src выводит docker/nginx/prod/preview-host.envsh. */
+export const PREVIEW_FRAMES_VARIABLE = '${PREVIEW_FRAME_SRC}';
 
 /**
@@ -66,5 +87,5 @@ export function nginxCspTemplate(): string {
   return [
     '# Сгенерировано apps/web/nginx-csp.ts при сборке образа: хэш скрипта темы — из его текста.',
-    `add_header Content-Security-Policy "${productionContentSecurityPolicy(S3_ORIGIN_VARIABLE)}" always;`,
+    `add_header Content-Security-Policy "${productionContentSecurityPolicy(S3_ORIGIN_VARIABLE, PREVIEW_FRAMES_VARIABLE)}" always;`,
     '',
   ].join('\n');
```

`apps/web/vite.config.ts`:

```diff
@@ -1,5 +1,5 @@
 import { preact } from '@preact/preset-vite';
 import { defineConfig } from 'vite';
-import { contentSecurityPolicy, themeBoot } from './csp.ts';
+import { contentSecurityPolicy, previewFrameSource, themeBoot } from './csp.ts';
 
 // Веб-приложение: `bun run web:dev` (http://localhost:5173, /api → API на :3000) или сервис web в Docker за nginx
@@ -30,4 +30,5 @@ export default defineConfig({
         s3Endpoint: env.S3_PUBLIC_ENDPOINT || 'http://localhost:53900',
         hmrOrigin,
+        frames: previewFrameSource(env.PREVIEW_HOST, publicOrigin.origin),
       }),
     },
```

`docker/nginx/nginx.conf`:

```diff
@@ -26,4 +26,8 @@ http {
   scgi_temp_path /tmp/scgi_temp;
 
+  # Превью сайтов: одна страница тянет десятки файлов, поэтому предел свой и с запасом.
+  limit_req_zone $binary_remote_addr zone=preview:10m rate=50r/s;
+  limit_req_status 429;
+
   # WebSocket HMR dev-сервера Vite: Upgrade проходит к web, обычные запросы идут с пустым Connection (keepalive).
   map $http_upgrade $connection_upgrade {
@@ -50,4 +54,30 @@ http {
   }
 
+  # Превью сайтов (план 10): *.preview.localhost резолвят Chrome и Firefox, Safari может не резолвить. Только чтение: файлы
+  # отдаёт API, он же ставит все заголовки, поэтому add_header здесь нет. Host без порта: API сравнивает только имя.
+  server {
+    listen 8080;
+    server_name ~^[0-9a-z-]+\.preview\.localhost$;
+    # Тело не нужно никому: большое отклоняется, остальное не уходит в API.
+    client_max_body_size 1;
+
+    location / {
+      limit_except GET {
+        deny all;
+      }
+      limit_req zone=preview burst=200 nodelay;
+      proxy_pass http://api;
+      proxy_http_version 1.1;
+      proxy_set_header Connection '';
+      proxy_set_header Host $host;
+      proxy_set_header Cookie '';
+      proxy_set_header Authorization '';
+      proxy_pass_request_body off;
+      proxy_set_header Content-Length '';
+      # Файл до 50 МиБ идёт клиенту потоком, а не через tmpfs.
+      proxy_buffering off;
+    }
+  }
+
   server {
     listen 8080;
```

`docker/nginx/prod/nginx.conf`:

```diff
@@ -1,6 +1,7 @@
 # Продакшен-вариант (docker/compose.prod.yml): статика веб-приложения и /api/ → api. Образ nginx-unprivileged, корень
 # только для чтения: pid, временные файлы и сгенерированные из шаблонов конфиги — в /tmp (tmpfs).
-# Серверы — в /etc/nginx/templates/nginx/app.conf.template: при старте envsubst подставляет APP_HOST и
-# S3_PUBLIC_ORIGIN (origin из S3_PUBLIC_ENDPOINT, docker/nginx/prod/s3-public-origin.envsh) и пишет /tmp/nginx/app.conf
+# Серверы — в /etc/nginx/templates/nginx/app.conf.template: при старте envsubst подставляет APP_HOST,
+# S3_PUBLIC_ORIGIN (origin из S3_PUBLIC_ENDPOINT, docker/nginx/prod/s3-public-origin.envsh), PREVIEW_FRAME_SRC и
+# PREVIEW_SERVER_NAME (из PREVIEW_HOST, docker/nginx/prod/preview-host.envsh) и пишет /tmp/nginx/app.conf
 # (NGINX_ENVSUBST_OUTPUT_DIR в docker/nginx/Dockerfile).
 worker_processes auto;
@@ -44,4 +45,6 @@ http {
   limit_req_zone $binary_remote_addr zone=api:10m rate=20r/s;
   limit_req_status 429;
+  # Превью сайтов: одна страница тянет десятки файлов, поэтому предел свой и с запасом.
+  limit_req_zone $binary_remote_addr zone=preview:10m rate=50r/s;
 
   upstream api {
```

`docker/nginx/prod/app.conf.template`:

```diff
@@ -1,4 +1,5 @@
 # Шаблон: envsubst подставляет ${APP_HOST} (публичное имя приложения). CSP страниц — /tmp/nginx/csp.conf из
-# csp.conf.template, который пишет сборка образа (хэш скрипта темы) с ${S3_PUBLIC_ORIGIN} в connect-src.
+# csp.conf.template, который пишет сборка образа (хэш скрипта темы) с ${S3_PUBLIC_ORIGIN} в connect-src и
+# ${PREVIEW_FRAME_SRC} во frame-src.
 
 # Чужой Host (DNS rebinding, сканеры по IP) — соединение закрывается без ответа. /healthz — для healthcheck
@@ -17,4 +18,30 @@ server {
 }
 
+# Превью сайтов (план 10): без PREVIEW_HOST имя ничему не совпадает. Только чтение: файлы отдаёт API, он же ставит все
+# заголовки, поэтому add_header здесь нет. Host без порта: API сравнивает только имя.
+server {
+  listen 8080;
+  server_name ~^[0-9a-z-]+\.${PREVIEW_SERVER_NAME}$;
+  # Тело не нужно никому: большое отклоняется, остальное не уходит в API.
+  client_max_body_size 1;
+
+  location / {
+    limit_except GET {
+      deny all;
+    }
+    limit_req zone=preview burst=200 nodelay;
+    proxy_pass http://api;
+    proxy_http_version 1.1;
+    proxy_set_header Connection '';
+    proxy_set_header Host $host;
+    proxy_set_header Cookie '';
+    proxy_set_header Authorization '';
+    proxy_pass_request_body off;
+    proxy_set_header Content-Length '';
+    # Файл до 50 МиБ идёт клиенту потоком, а не через tmpfs.
+    proxy_buffering off;
+  }
+}
+
 server {
   listen 8080;
```

`docker/nginx/prod/preview-host.envsh` (новый файл):

```sh
#!/bin/sh
# Переменные шаблонов для превью сайтов (план 10), из PREVIEW_HOST и схемы APP_ORIGIN: PREVIEW_FRAME_SRC — источник
# frame-src в CSP приложения, PREVIEW_SERVER_NAME — имя для регулярного server_name, с экранированными точками и без порта.
# Образ подключает файл (.envsh) до 20-envsubst-on-templates.sh; неверное значение — выход с ошибкой, nginx не стартует.
# Символы ограничены: значения попадают в конфиг nginx как есть. Без PREVIEW_HOST фреймов нет, а имя ничему не совпадает.

preview_host=$(printf %s "${PREVIEW_HOST:-}" | tr 'A-Z' 'a-z')
if [ -z "$preview_host" ]; then
  PREVIEW_FRAME_SRC="'none'"
  PREVIEW_SERVER_NAME='previews-are-off\.invalid'
else
  case "$preview_host" in
    *[!a-z0-9.:-]*)
      echo "PREVIEW_HOST must be host[:port], got '$PREVIEW_HOST'" >&2
      exit 1
      ;;
  esac
  case "${APP_ORIGIN:-}" in
    https://*) preview_scheme=https ;;
    http://*) preview_scheme=http ;;
    *)
      echo "APP_ORIGIN must be an http(s) URL, got '${APP_ORIGIN:-}'" >&2
      exit 1
      ;;
  esac
  PREVIEW_FRAME_SRC="$preview_scheme://*.$preview_host"
  PREVIEW_SERVER_NAME=$(printf %s "${preview_host%%:*}" | sed 's/\./\\./g')
fi
export PREVIEW_FRAME_SRC PREVIEW_SERVER_NAME
```

`docker/nginx/Dockerfile`:

```diff
@@ -11,9 +11,11 @@ RUN bun run --cwd apps/web build \
 
 FROM nginxinc/nginx-unprivileged:1.28-alpine
-# Шаблоны → /tmp/nginx/*.conf при старте (корень только для чтения); подставляются только эти две переменные.
-# S3_PUBLIC_ORIGIN выводит из S3_PUBLIC_ENDPOINT 18-s3-public-origin.envsh (до envsubst; неверный адрес — отказ старта).
+# Шаблоны → /tmp/nginx/*.conf при старте (корень только для чтения); подставляются только эти переменные.
+# S3_PUBLIC_ORIGIN выводит из S3_PUBLIC_ENDPOINT 18-s3-public-origin.envsh (до envsubst; неверный адрес — отказ старта),
+# переменные превью из PREVIEW_HOST и APP_ORIGIN — 19-preview-host.envsh.
 ENV NGINX_ENVSUBST_OUTPUT_DIR=/tmp \
-    NGINX_ENVSUBST_FILTER='^(APP_HOST|S3_PUBLIC_ORIGIN)$'
+    NGINX_ENVSUBST_FILTER='^(APP_HOST|S3_PUBLIC_ORIGIN|PREVIEW_FRAME_SRC|PREVIEW_SERVER_NAME)$'
 COPY --chmod=755 docker/nginx/prod/s3-public-origin.envsh /docker-entrypoint.d/18-s3-public-origin.envsh
+COPY --chmod=755 docker/nginx/prod/preview-host.envsh /docker-entrypoint.d/19-preview-host.envsh
 COPY docker/nginx/prod/nginx.conf /etc/nginx/nginx.conf
 COPY docker/nginx/prod/headers.conf /etc/nginx/snippets/headers.conf
```

`docker/compose.yml`:

```diff
@@ -109,4 +109,6 @@ services:
       S3_PUBLIC_ENDPOINT: http://localhost:53900
       BETTER_AUTH_URL: http://localhost:8080
+      # Превью сайтов: хост под nginx; ключ подписи выводится из BETTER_AUTH_SECRET (.env).
+      PREVIEW_HOST: preview.localhost:8080
       # Внутри контейнера — на всех интерфейсах сети compose (по умолчанию API слушает только loopback).
       API_HOST: 0.0.0.0
@@ -170,4 +172,6 @@ services:
       WEB_PUBLIC_ORIGIN: http://localhost:8080
       S3_PUBLIC_ENDPOINT: http://localhost:53900
+      # Для frame-src в CSP страницы: тот же хост, что у API.
+      PREVIEW_HOST: preview.localhost:8080
       VITE_CACHE_DIR: /tmp/vite
       # WEB_WATCH_POLL: '1' # если правки не доходят до HMR через bind-mount (Docker Desktop)
```

`docker/compose.prod.yml`:

```diff
@@ -135,4 +135,7 @@ services:
       MAIL_FROM: ${MAIL_FROM:-}
       UPLOAD_MAX_BYTES: ${UPLOAD_MAX_BYTES:-}
+      # Превью сайтов: пусто — выключены. Хост — на отдельном регистрируемом домене (docs/beta-checklist.md).
+      PREVIEW_HOST: ${PREVIEW_HOST:-}
+      PREVIEW_SECRET: ${PREVIEW_SECRET:-}
     expose: ['3000']
     depends_on:
@@ -212,4 +215,7 @@ services:
       # Для connect-src CSP образ берёт только origin (scheme://host[:port]) — docker/nginx/prod/s3-public-origin.envsh.
       S3_PUBLIC_ENDPOINT: ${S3_PUBLIC_ENDPOINT:?set S3_PUBLIC_ENDPOINT}
+      # Для frame-src в CSP и server_name превью — docker/nginx/prod/preview-host.envsh.
+      PREVIEW_HOST: ${PREVIEW_HOST:-}
+      APP_ORIGIN: ${APP_ORIGIN:?set APP_ORIGIN}
     ports: ['127.0.0.1:${APP_PORT:-8080}:8080']
     depends_on:
```

`.env.example`:

```diff
@@ -63,4 +63,10 @@ BETTER_AUTH_SECRET=
 # GITHUB_CLIENT_ID=
 # GITHUB_CLIENT_SECRET=
+# Site previews: tasks open on <label>.<PREVIEW_HOST>, the scheme follows BETTER_AUTH_URL. Empty means off.
+# The Docker stack sets preview.localhost:8080 itself. Without Docker: preview.localhost:3000 here for bun run api, and
+# the same value in the environment of bun run web:dev for its CSP. Chrome and Firefox resolve *.localhost; Safari may not.
+# PREVIEW_HOST=preview.localhost:3000
+# Signing key of preview links (at least 32 characters); by default it is derived from BETTER_AUTH_SECRET
+# PREVIEW_SECRET=
 # Mail for magic links (SMTP of any provider: Resend, Postmark, SES, Mailgun…). Without both, links go to the API log
 # SMTP_URL=smtps://user:password@smtp.example.com:465
```

`.env.prod.example`:

```diff
@@ -34,4 +34,8 @@ BETTER_AUTH_SECRET=
 # GITHUB_CLIENT_ID=
 # GITHUB_CLIENT_SECRET=
+# Site previews: a registrable domain of its own, not a subdomain of the app, with wildcard DNS and a wildcard
+# certificate (docs/beta-checklist.md). Empty means off. The key is derived from BETTER_AUTH_SECRET by default.
+# PREVIEW_HOST=example-usercontent.net
+# PREVIEW_SECRET=
 # Mail for magic links; without both, links are written to the API log
 # SMTP_URL=smtps://user:password@smtp.example.com:465
```

`scripts/prod-smoke.ts`:

```diff
@@ -32,4 +32,5 @@ const env: Record<string, string> = {
   APP_HOST: 'localhost',
   APP_PORT: String(APP_PORT),
+  PREVIEW_HOST: `preview.localhost:${APP_PORT}`,
   BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
   LITELLM_BASE_URL: 'http://127.0.0.1:9/v1',
@@ -98,6 +99,6 @@ function check(name: string, ok: boolean, detail = ''): void {
 }
 
-/** Запрос с чужим Host напрямую в сокет: fetch Host не подменяет. true — nginx закрыл соединение без ответа (444). */
-async function closedWithoutResponse(host: string): Promise<boolean> {
+/** Запрос с любым Host напрямую в сокет (fetch Host не подменяет): весь ответ, пустая строка — соединение закрыто без него. */
+async function rawGet(host: string, path = '/'): Promise<string> {
   let received = '';
   await new Promise<void>((resolve, reject) => {
@@ -106,5 +107,5 @@ async function closedWithoutResponse(host: string): Promise<boolean> {
       port: APP_PORT,
       socket: {
-        open: s => void s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
+        open: s => void s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
         data: (_s, chunk) => void (received += new TextDecoder().decode(chunk)),
         close: () => resolve(),
@@ -113,5 +114,5 @@ async function closedWithoutResponse(host: string): Promise<boolean> {
     }).catch(reject);
   });
-  return received === '';
+  return received;
 }
 
@@ -173,5 +174,12 @@ try {
   );
 
-  check('a foreign Host gets no response (444)', await closedWithoutResponse('attacker.example'));
+  check('a foreign Host gets no response (444)', (await rawGet('attacker.example')) === '');
+
+  // Хост превью идёт в API, и там ему доступно только превью: ни маршрутов приложения, ни CSP приложения поверх.
+  const previewHost = `nope.preview.localhost:${APP_PORT}`;
+  const previewApi = await rawGet(previewHost, '/api/health');
+  check('/api/health on a preview host is 404', previewApi.startsWith('HTTP/1.1 404'), previewApi.slice(0, 80));
+  check('a preview host answers with the CSP of the API', previewApi.includes(`frame-ancestors ${ORIGIN}`));
+  check('a preview host carries no X-Frame-Options', !/x-frame-options/i.test(previewApi));
 
   await fetch(`${ORIGIN}/api/auth/magic-link/verify?token=SMOKE-SECRET-TOKEN`);
```

- [ ] **Step 4: Run them and see them pass**

Run:

```bash
bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test/csp.test.ts apps/web/test/nginx.test.ts
bun run format && bun run check
bun run test:unit
```

Expected: PASS, без предупреждений.

- [ ] **Step 5: Проверить настоящий nginx**

Нужен Docker; только из основного checkout. Конфиг и шаблон в тестах проверяются как текст, а синтаксис и `server_name` — только здесь.

Run:

```bash
bun run prod:smoke
```

Expected: `✓ /api/health on a preview host is 404`, `✓ a preview host answers with the CSP of the API`, `✓ a preview host carries no X-Frame-Options`, стек поднимается и убирается без ошибок.

- [ ] **Step 6: Commit**

```bash
bun run format && bun run check
git add apps/web/test/csp.test.ts apps/web/test/nginx.test.ts apps/web/csp.ts apps/web/vite.config.ts docker/nginx/nginx.conf docker/nginx/prod/nginx.conf docker/nginx/prod/app.conf.template docker/nginx/prod/preview-host.envsh docker/nginx/Dockerfile docker/compose.yml docker/compose.prod.yml .env.example .env.prod.example scripts/prod-smoke.ts
git commit -m "feat: preview hosts in nginx and frame-src in the app CSP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Панель: Preview и Activity

**Files:**

- Modify: `packages/ui/src/agent/computer.tsx`
- Modify: `packages/ui/styles/agent.css`
- Modify: `packages/ui/styles/layout.css`
- Modify: `packages/ui/showcase/src/sections/agent.tsx`
- Modify: `packages/ui/README.md`
- Modify: `apps/web/src/state/task.ts`
- Modify: `apps/web/src/routes/computer.tsx`
- Modify: `apps/web/src/routes/task.tsx`
- Test: `packages/ui/test/dom.ts`, `packages/ui/test/agent.test.tsx`, `packages/ui/test/styles.test.ts`, `apps/web/test/dom.ts`, `apps/web/test/task-screen.test.tsx`

**Interfaces:**

- Consumes: `TaskResponse.preview` (задача 2); `frame-src` (задача 3); `SegmentedControl`, `safeHref`.
- Produces: в `@agent/ui`: `ComputerFrame { src: string; title: string; reloadKey: string }`, `ComputerPanelProps.actions?: ComponentChildren`, `ComputerPanelProps.frame?: ComputerFrame`, `OpenInNewTab({ href: string; children?: ComponentChildren })`; в веб-приложении: `store.preview`, `TaskPreview { url: string; reloadKey: string }`, `previewReloadKey(cycle: number, outputs: readonly FileDto[]): string`, `TaskComputer({ entries, preview?, finished? })`.
- Result: законченная задача с сайтом показывает его в панели; проверяется на happy-dom, браузер — в задаче 5.

- [ ] **Step 1: Write the failing tests**

`packages/ui/test/dom.ts`:

```diff
@@ -4,5 +4,6 @@ import { afterEach } from 'bun:test';
 import { GlobalRegistrator } from '@happy-dom/global-registrator';
 
-GlobalRegistrator.register({ url: 'http://localhost/' });
+// Фреймы не загружаются: тестам нужен сам элемент, а не сеть.
+GlobalRegistrator.register({ url: 'http://localhost/', settings: { disableIframePageLoading: true } });
 
 // Автоочистка @testing-library/preact подписывается на afterEach только в первом файле,
```

`packages/ui/test/agent.test.tsx`:

```diff
@@ -12,4 +12,5 @@ import {
   Composer,
   ComputerPanel,
+  OpenInNewTab,
   CreditBalance,
   FileCard,
@@ -455,2 +456,62 @@ test('FileCard and TaskItem drop unsafe hrefs instead of rendering them as links
   expect(screen.getByText('Bad task')).toBeTruthy();
 });
+
+const FRAME = { src: 'https://site.preview.test/', title: 'Site preview', reloadKey: 'a' };
+
+test('ComputerPanel with a frame shows the site instead of the screen, the status and the replay', () => {
+  render(
+    <ComputerPanel activity="Using Browser" frame={FRAME} actions={<button type="button">Switch</button>}>
+      body
+    </ComputerPanel>,
+  );
+  const frame = screen.getByTitle('Site preview');
+  expect(frame.tagName).toBe('IFRAME');
+  expect(frame.getAttribute('src')).toBe(FRAME.src);
+  expect(frame.getAttribute('class')).toBe('ui-computer__frame');
+  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
+  expect(screen.queryByText('Using Browser')).toBeNull();
+  expect(screen.queryByRole('region', { name: "Agent's computer: screen" })).toBeNull();
+  expect(screen.queryByRole('progressbar')).toBeNull();
+  expect(screen.getByRole('button', { name: 'Switch' })).toBeTruthy();
+});
+
+test('the frame is sandboxed: scripts, its own origin, forms and modals; no top navigation, no popups', () => {
+  render(<ComputerPanel frame={FRAME} />);
+  expect(screen.getByTitle('Site preview').getAttribute('sandbox')).toBe(
+    'allow-scripts allow-same-origin allow-forms allow-modals',
+  );
+});
+
+test('a new reloadKey creates a new frame, the same key keeps it', () => {
+  const { rerender } = render(<ComputerPanel frame={FRAME} />);
+  const first = screen.getByTitle('Site preview');
+  rerender(<ComputerPanel frame={{ ...FRAME }} />);
+  expect(screen.getByTitle('Site preview')).toBe(first);
+  rerender(<ComputerPanel frame={{ ...FRAME, reloadKey: 'b' }} />);
+  expect(screen.getByTitle('Site preview')).not.toBe(first);
+});
+
+test('an unsafe frame address is dropped: the panel stays as it was', () => {
+  render(<ComputerPanel activity="Using Browser" frame={{ ...FRAME, src: 'javascript:alert(1)' }} />);
+  expect(screen.queryByTitle('Site preview')).toBeNull();
+  expect(screen.getByText('Using Browser')).toBeTruthy();
+});
+
+test('without a frame nothing changes, and actions sit in the head of the panel', () => {
+  render(<ComputerPanel activity="Using Browser" actions={<a href="/x">Open</a>} />);
+  expect(screen.getByRole('link', { name: 'Open' }).closest('.ui-computer__tabs')).toBeTruthy();
+  expect(document.querySelector('iframe')).toBeNull();
+  expect(screen.getByRole('progressbar')).toBeTruthy();
+});
+
+test('OpenInNewTab opens without an opener and a referrer; an unsafe address renders nothing', () => {
+  const { rerender } = render(<OpenInNewTab href="https://site.preview.test/" />);
+  const link = screen.getByRole('link', { name: 'Open in new tab' });
+  expect(link.getAttribute('href')).toBe('https://site.preview.test/');
+  expect(link.getAttribute('target')).toBe('_blank');
+  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
+  rerender(<OpenInNewTab href="https://site.preview.test/">Open preview</OpenInNewTab>);
+  expect(screen.getByRole('link', { name: 'Open preview' })).toBeTruthy();
+  rerender(<OpenInNewTab href="javascript:alert(1)" />);
+  expect(screen.queryByRole('link')).toBeNull();
+});
```

`packages/ui/test/styles.test.ts`:

```diff
@@ -65,2 +65,7 @@ test('a long unbroken row title wraps inside its row instead of running under th
   expect(block).toMatch(/overflow-wrap:\s*anywhere/);
 });
+
+test('the frame of a site fills the panel without a border and stays usable when the panel stacks under the chat', () => {
+  expect(styles).toMatch(/\.ui-computer__frame\s*\{[^}]*flex:\s*1[^}]*border:\s*0/);
+  expect(styles).toMatch(/@media \(max-width: 900px\)\s*\{[\s\S]*\.ui-computer__frame\s*\{[^}]*min-height:\s*70svh/);
+});
```

`apps/web/test/dom.ts`:

```diff
@@ -4,5 +4,6 @@ import { afterEach } from 'bun:test';
 import { GlobalRegistrator } from '@happy-dom/global-registrator';
 
-GlobalRegistrator.register({ url: 'http://localhost/' });
+// Фреймы не загружаются: тестам нужен сам элемент, а не сеть.
+GlobalRegistrator.register({ url: 'http://localhost/', settings: { disableIframePageLoading: true } });
 
 // Автоочистка @testing-library/preact подписывается на afterEach только в первом файле процесса — хук из preload
```

`apps/web/test/task-screen.test.tsx`:

```diff
@@ -793,2 +793,114 @@ test.each([
   expect(screen.queryByText(RECONNECTING)).toBeNull();
 });
+
+const PREVIEW = { url: 'https://site.preview.test/' };
+const panel = () => screen.getByRole('region', { name: "Agent's computer" });
+const switchTo = (name: string) => within(panel()).getByRole('button', { name });
+const pressed = (name: string) => switchTo(name).getAttribute('aria-pressed');
+const siteFile = (createdAt = '2026-11-02T10:00:00.000Z') =>
+  fileDto({ path: 'outputs/index.html', mime: 'text/html', createdAt });
+const donePreview = (overrides: Partial<ReturnType<typeof taskDetail>> = {}, files = [siteFile()]) =>
+  taskResponse({ task: { ...doneTask, ...overrides }, files, preview: PREVIEW });
+
+/** Экран задачи, чья карточка — текущее значение card; поток открыт, поэтому шаг status перечитывает карточку. */
+async function openCard(first: ReturnType<typeof taskResponse>) {
+  let card = first;
+  const env = await open([first], { 'GET /api/tasks/task-1': () => json(card) });
+  const reads = () => env.calls.filter(c => c.path === '/api/tasks/task-1').length;
+  let seq = 100;
+  /** Новая карточка: экран перечитал её и отрисовал. */
+  const update = async (next: ReturnType<typeof taskResponse>) => {
+    card = next;
+    const before = reads();
+    emit(status((seq += 1), 'running', 'finalizing'));
+    await until(() => reads() > before);
+    // Ответ чтения и отрисовка идут после вызова fetch.
+    await act(() => new Promise(resolve => setTimeout(resolve, 0)));
+  };
+  await until(() => document.title === 'Find three suppliers · agent');
+  return { update };
+}
+
+test('without a preview there is no switch and no frame', async () => {
+  await openCard(taskResponse({ task: doneTask }));
+  expect(within(panel()).queryByRole('button', { name: 'Preview' })).toBeNull();
+  expect(screen.queryByTitle('Site preview')).toBeNull();
+  expect(screen.queryByRole('link', { name: 'Open preview' })).toBeNull();
+});
+
+test('a finished task with a preview opens on it; the links open a new tab without an opener', async () => {
+  await openCard(donePreview());
+  const frame = await screen.findByTitle('Site preview');
+  expect(frame.getAttribute('src')).toBe(PREVIEW.url);
+  expect(pressed('Preview')).toBe('true');
+  const newTab = within(panel()).getByRole('link', { name: 'Open in new tab' });
+  expect(newTab.getAttribute('href')).toBe(PREVIEW.url);
+  expect(newTab.getAttribute('rel')).toBe('noopener noreferrer');
+  // Панель скрыта на средней ширине экрана: ссылка в ответе остаётся доступной.
+  expect(screen.getByRole('link', { name: 'Open preview' }).getAttribute('rel')).toBe('noopener noreferrer');
+});
+
+test('the switch moves between the site and the activity, and a reread does not move it back', async () => {
+  const { update } = await openCard(donePreview());
+  await userEvent.click(await screen.findByRole('button', { name: 'Activity' }));
+  expect(screen.queryByTitle('Site preview')).toBeNull();
+  expect(pressed('Activity')).toBe('true');
+  await update(donePreview());
+  expect(pressed('Activity')).toBe('true');
+  await userEvent.click(switchTo('Preview'));
+  expect(screen.getByTitle('Site preview')).toBeTruthy();
+});
+
+test('during a run the panel stays on Activity; when the cycle finishes it opens the preview by itself', async () => {
+  const running = taskResponse({
+    task: taskDetail({ status: 'running', cycle: 2 }),
+    files: [siteFile()],
+    preview: PREVIEW,
+  });
+  const { update } = await openCard(running);
+  // Сайт прошлого цикла можно открыть, но сам экран на него не переходит.
+  expect(pressed('Activity')).toBe('true');
+  expect(screen.queryByTitle('Site preview')).toBeNull();
+  await update(running);
+  expect(pressed('Activity')).toBe('true');
+  await update(donePreview({ cycle: 2 }, [siteFile('2026-11-02T10:05:00.000Z')]));
+  expect(screen.getByTitle('Site preview')).toBeTruthy();
+  expect(pressed('Preview')).toBe('true');
+});
+
+test('a preview that appears during the run does not interrupt it', async () => {
+  const { update } = await openCard(taskResponse({ task: taskDetail({ status: 'running' }) }));
+  expect(within(panel()).queryByRole('button', { name: 'Preview' })).toBeNull();
+  await update(taskResponse({ task: taskDetail({ status: 'finalizing' }), files: [siteFile()], preview: PREVIEW }));
+  expect(pressed('Activity')).toBe('true');
+  expect(screen.queryByTitle('Site preview')).toBeNull();
+});
+
+test('a new cycle goes back to Activity', async () => {
+  const { update } = await openCard(donePreview());
+  await screen.findByTitle('Site preview');
+  await update(taskResponse({ task: reopened, files: [siteFile()], preview: PREVIEW }));
+  expect(screen.queryByTitle('Site preview')).toBeNull();
+  expect(pressed('Activity')).toBe('true');
+});
+
+test('the frame reloads when the delivered files or the cycle change, and only then', async () => {
+  const { update } = await openCard(donePreview());
+  const later = '2026-11-02T10:05:00.000Z';
+  const first = await screen.findByTitle('Site preview');
+  await update(donePreview());
+  expect(screen.getByTitle('Site preview')).toBe(first);
+  await update(donePreview({}, [siteFile(later)]));
+  const second = screen.getByTitle('Site preview');
+  expect(second).not.toBe(first);
+  await update(donePreview({ cycle: 2 }, [siteFile(later)]));
+  expect(screen.getByTitle('Site preview')).not.toBe(second);
+});
+
+test('a preview that goes away takes the switch with it', async () => {
+  const { update } = await openCard(donePreview());
+  await screen.findByTitle('Site preview');
+  await update(taskResponse({ task: doneTask }));
+  expect(screen.queryByTitle('Site preview')).toBeNull();
+  expect(within(panel()).queryByRole('button', { name: 'Preview' })).toBeNull();
+});
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun run test:ui; bun run test:web`

Expected: FAIL. `agent.test.tsx` не загружается: `SyntaxError: Export named 'OpenInNewTab' not found`; `the frame of a site fills the panel…` падает. В `task-screen.test.tsx` падают `a finished task with a preview opens on it…` и остальные тесты превью, которые ждут фрейм или переключатель.

- [ ] **Step 3: Implement**

README правится одной строкой; таблицу выровняет `bun run format` на следующем шаге.

`packages/ui/src/agent/computer.tsx`:

```diff
@@ -1,6 +1,16 @@
 import type { ComponentChildren } from 'preact';
-import { Maximize2, Monitor, Play, SkipBack, SkipForward, Sparkles, X } from 'lucide-preact';
+import { ExternalLink, Maximize2, Monitor, Play, SkipBack, SkipForward, Sparkles, X } from 'lucide-preact';
 import { Button, IconButton } from '../components/button.tsx';
 import { Progress } from '../components/display.tsx';
+import { safeHref } from '../lib/url.ts';
+
+export interface ComputerFrame {
+  /** Адрес сайта; небезопасные схемы пакет отбрасывает (`safeHref`), и панель остаётся обычной. */
+  src: string;
+  /** Доступное имя фрейма. */
+  title: string;
+  /** Другой ключ — новый фрейм: сайт загружается заново. */
+  reloadKey: string;
+}
 
 export interface ComputerPanelProps {
@@ -21,4 +31,20 @@ export interface ComputerPanelProps {
   onExpand?(): void;
   onClose?(): void;
+  /** Содержимое шапки справа от заголовка: переключатель вида, ссылки. */
+  actions?: ComponentChildren;
+  /** Сайт во фрейме вместо снимка, строки состояния и таймлайна. */
+  frame?: ComputerFrame;
+}
+
+/** Ссылка на сайт агента: новая вкладка без opener и Referer, небезопасный адрес не показывается. */
+export function OpenInNewTab({ href, children = 'Open in new tab' }: { href: string; children?: ComponentChildren }) {
+  const safe = safeHref(href);
+  if (!safe) return null;
+  return (
+    <a class="ui-btn ui-btn--ghost ui-btn--xs" href={safe} target="_blank" rel="noopener noreferrer">
+      <ExternalLink aria-hidden="true" />
+      {children}
+    </a>
+  );
 }
 
@@ -36,7 +62,10 @@ export function ComputerPanel({
   onExpand,
   onClose,
+  actions,
+  frame,
 }: ComputerPanelProps) {
   // NaN — это «нет данных»: показываем конец ленты, а не ломаем aria-valuenow.
   const value = Number.isNaN(position) ? 100 : Math.min(Math.max(position, 0), 100);
+  const frameSrc = safeHref(frame?.src);
   return (
     <section class="ui-computer" aria-label={title}>
@@ -47,41 +76,61 @@ export function ComputerPanel({
         </div>
         <span class="ui-spacer" />
+        {actions}
         {onExpand && <IconButton icon={Maximize2} label="Expand" onClick={onExpand} />}
         {onClose && <IconButton icon={X} label="Close" onClick={onClose} />}
       </div>
-      {activity && (
-        <div class="ui-computer__status">
-          <b>{activity}</b>
-          {detail}
-        </div>
+      {frame && frameSrc ? (
+        /*
+         * allow-same-origin намеренно: без него localStorage бросает исключение, и обычное React-приложение падает. Здесь
+         * это безопасно: origin сайта — отдельный хост задачи и никогда не origin приложения, поэтому сайт получает доступ
+         * только к самому себе. Без allow-top-navigation и allow-popups: сайт не уводит вкладку и не открывает окна.
+         */
+        <iframe
+          key={frame.reloadKey}
+          class="ui-computer__frame"
+          src={frameSrc}
+          title={frame.title}
+          // oxlint-disable-next-line react/iframe-missing-sandbox
+          sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
+          referrerpolicy="no-referrer"
+        />
+      ) : (
+        <>
+          {activity && (
+            <div class="ui-computer__status">
+              <b>{activity}</b>
+              {detail}
+            </div>
+          )}
+          {/* Прокручиваемая область должна быть доступна с клавиатуры. */}
+          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
+          <div class="ui-computer__body" role="region" aria-label={`${title}: screen`} tabIndex={0}>
+            {children}
+          </div>
+          <div class="ui-computer__foot">
+            <IconButton icon={SkipBack} label="Previous step" size="xs" disabled={!onPrevious} onClick={onPrevious} />
+            <IconButton icon={SkipForward} label="Next step" size="xs" disabled={!onNext} onClick={onNext} />
+            <div
+              class="ui-timeline-bar"
+              role="progressbar"
+              aria-label="Replay position"
+              aria-valuemin={0}
+              aria-valuemax={100}
+              aria-valuenow={Math.round(value)}
+            >
+              <i style={{ '--val': `${value}%` }} />
+            </div>
+            {live ? (
+              <span class="ui-live">Live</span>
+            ) : (
+              onJumpToLive && (
+                <Button variant="ghost" size="xs" icon={Play} onClick={onJumpToLive}>
+                  Jump to live
+                </Button>
+              )
+            )}
+          </div>
+        </>
       )}
-      {/* Прокручиваемая область должна быть доступна с клавиатуры. */}
-      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
-      <div class="ui-computer__body" role="region" aria-label={`${title}: screen`} tabIndex={0}>
-        {children}
-      </div>
-      <div class="ui-computer__foot">
-        <IconButton icon={SkipBack} label="Previous step" size="xs" disabled={!onPrevious} onClick={onPrevious} />
-        <IconButton icon={SkipForward} label="Next step" size="xs" disabled={!onNext} onClick={onNext} />
-        <div
-          class="ui-timeline-bar"
-          role="progressbar"
-          aria-label="Replay position"
-          aria-valuemin={0}
-          aria-valuemax={100}
-          aria-valuenow={Math.round(value)}
-        >
-          <i style={{ '--val': `${value}%` }} />
-        </div>
-        {live ? (
-          <span class="ui-live">Live</span>
-        ) : (
-          onJumpToLive && (
-            <Button variant="ghost" size="xs" icon={Play} onClick={onJumpToLive}>
-              Jump to live
-            </Button>
-          )
-        )}
-      </div>
     </section>
   );
```

`packages/ui/styles/agent.css`:

```diff
@@ -451,9 +451,10 @@
 }
 .ui-computer__tabs {
-  height: var(--header-height);
+  min-height: var(--header-height);
   display: flex;
+  flex-wrap: wrap;
   align-items: center;
   gap: var(--space-1);
-  padding: 0 var(--space-2) 0 var(--space-3);
+  padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
   border-bottom: 1px solid var(--border-subtle);
 }
@@ -491,4 +492,12 @@
   white-space: pre-wrap;
 }
+/* Сайт агента во фрейме: белый фон, потому что страница без своего фона рассчитана на белый. */
+.ui-computer__frame {
+  flex: 1;
+  width: 100%;
+  min-height: 0;
+  border: 0;
+  background: #fff;
+}
 .ui-computer__foot {
   padding: var(--space-2) var(--space-3);
```

`packages/ui/styles/layout.css`:

```diff
@@ -234,3 +234,7 @@
     min-height: 360px;
   }
+  /* Панель под диалогом: сайт нужно видеть и прокручивать, а не только его верхнюю полоску. */
+  .ui-computer__frame {
+    min-height: 70svh;
+  }
 }
```

`packages/ui/showcase/src/sections/agent.tsx`:

```diff
@@ -11,4 +11,5 @@ import {
   Composer,
   ComputerPanel,
+  OpenInNewTab,
   FileCard,
   IconButton,
@@ -270,4 +271,5 @@ export function TaskScreenSection() {
             position={(Math.min(step + 1, SCRIPT.length) / SCRIPT.length) * 100}
             live
+            actions={<OpenInNewTab href="https://example.com/" />}
           >
             {current && step >= 0 ? current.body : ''}
```

`packages/ui/README.md`:

```diff
@@ -41,5 +41,5 @@ import { Button, ToastProvider, useTheme } from '@agent/ui';
 | Overlays          | `Menu`, `Popover`, `Tooltip`, `Dialog`, `ConfirmDialog`, `Sheet`, `CommandPalette` (with a status region), `ToastProvider` + `useToast`                                                                               |
 | Feedback and data | `Alert`, `Banner`, `Progress`, `Spinner`, `Skeleton`, `StatusDot`, `EmptyState`, `Badge`, `Avatar`, `AvatarGroup`, `Kbd`, `KbdCombo`                                                                                  |
-| Agent             | `Composer` (trims the text), `Attachment`, `UserMessage`, `AgentMessage`, `AgentText`, `Thinking`, `AskCard`, `FileCard`, `Suggestion`, `PlanList`, `StepGroup`, `Step`, `TaskItem`, `ComputerPanel`, `CreditBalance` |
+| Agent             | `Composer` (trims the text), `Attachment`, `UserMessage`, `AgentMessage`, `AgentText`, `Thinking`, `AskCard`, `FileCard`, `Suggestion`, `PlanList`, `StepGroup`, `Step`, `TaskItem`, `ComputerPanel`, `OpenInNewTab`, `CreditBalance` |
 | Effects           | `DotField` (`mountDotField` for plain DOM)                                                                                                                                                                            |
 | Hooks             | `useTheme`, `useHotkey` (`mod`, `shift`, `alt`), `useFloating`, `useDismiss`, `useFocusTrap`, `useScrollLock`, `usePresence`, `useReducedMotion`                                                                      |
```

`apps/web/src/state/task.ts`:

```diff
@@ -1,4 +1,11 @@
 import { batch, signal } from '@preact/signals';
-import { isTerminalTask, type FileDto, type StepDto, type SubtaskDto, type TaskDetail } from '@agent/shared';
+import {
+  isTerminalTask,
+  type FileDto,
+  type StepDto,
+  type SubtaskDto,
+  type TaskDetail,
+  type TaskResponse,
+} from '@agent/shared';
 import { ApiRequestError, type Api } from '../api/client.ts';
 import { openTaskEvents, type TaskEventsOptions } from '../api/events.ts';
@@ -53,4 +60,5 @@ export function createTaskStore(deps: TaskStoreDeps, taskId: string) {
   const subtasks = signal<SubtaskDto[]>([]);
   const files = signal<FileDto[]>([]);
+  const preview = signal<TaskResponse['preview']>(null);
   const steps = signal<StepDto[]>([]);
   /** Карточку не показать: первое чтение не удалось, сессии нет (401) или задачи нет (403, 404). */
@@ -110,4 +118,5 @@ export function createTaskStore(deps: TaskStoreDeps, taskId: string) {
       subtasks.value = res.subtasks;
       files.value = res.files;
+      preview.value = res.preview;
       error.value = null;
       stale.value = null;
@@ -211,4 +220,5 @@ export function createTaskStore(deps: TaskStoreDeps, taskId: string) {
     subtasks,
     files,
+    preview,
     steps,
     error,
```

`apps/web/src/routes/computer.tsx`:

```diff
@@ -1,12 +1,45 @@
-import { useState } from 'preact/hooks';
-import { ComputerPanel } from '@agent/ui';
+import { useEffect, useState } from 'preact/hooks';
+import { ComputerPanel, OpenInNewTab, SegmentedControl } from '@agent/ui';
+import type { FileDto } from '@agent/shared';
 import { Markdown } from '../view/markdown.tsx';
 import type { ToolEntry } from '../view/timeline.ts';
 
+export interface TaskPreview {
+  url: string;
+  /** Смена ключа загружает сайт заново: previewReloadKey. */
+  reloadKey: string;
+}
+
+/** Адрес сайта постоянен неделю, поэтому сайт перезагружается по циклу и выданным файлам, а не по адресу. */
+export function previewReloadKey(cycle: number, outputs: readonly FileDto[]): string {
+  const latest = outputs.reduce((max, f) => (f.createdAt > max ? f.createdAt : max), '');
+  return `${cycle}:${outputs.length}:${latest}`;
+}
+
+type PanelView = 'preview' | 'activity';
+
+const VIEWS = [
+  { value: 'preview', label: 'Preview' },
+  { value: 'activity', label: 'Activity' },
+] as const;
+
 /**
  * Панель компьютера: последний вызов инструмента (live) или выбранный кнопками перемотки. Снимок страницы — Markdown,
  * вывод терминала и файлов — текстом как есть (ComputerPanel моноширинный). Скриншотов нет: они остаются в песочнице.
+ * С выданным сайтом панель переключается между ним и шагами: законченный цикл открывает сайт сам, новый цикл возвращает
+ * к шагам, а пока идёт работа и пользователь смотрит на шаги, появившийся сайт его не отвлекает.
  */
-export function TaskComputer({ entries }: { entries: readonly ToolEntry[] }) {
+export function TaskComputer({
+  entries,
+  preview = null,
+  finished = false,
+}: {
+  entries: readonly ToolEntry[];
+  preview?: TaskPreview | null;
+  finished?: boolean;
+}) {
+  const hasPreview = preview !== null;
+  const [view, setView] = useState<PanelView>(hasPreview && finished ? 'preview' : 'activity');
+  useEffect(() => setView(hasPreview && finished ? 'preview' : 'activity'), [hasPreview, finished]);
   const [selected, setSelected] = useState<number | null>(null);
   const last = entries.length - 1;
@@ -23,4 +56,17 @@ export function TaskComputer({ entries }: { entries: readonly ToolEntry[] }) {
       {...(index >= 0 && index < last ? { onNext: () => setSelected(index + 1 === last ? null : index + 1) } : {})}
       onJumpToLive={() => setSelected(null)}
+      {...(preview
+        ? {
+            actions: (
+              <>
+                <SegmentedControl label="Panel view" value={view} onChange={setView} options={VIEWS} />
+                <OpenInNewTab href={preview.url} />
+              </>
+            ),
+          }
+        : {})}
+      {...(preview && view === 'preview'
+        ? { frame: { src: preview.url, title: 'Site preview', reloadKey: preview.reloadKey } }
+        : {})}
     >
       {entry ? entry.markdown ? <Markdown text={entry.output} /> : entry.output : null}
```

`apps/web/src/routes/task.tsx`:

```diff
@@ -12,4 +12,5 @@ import {
   EmptyState,
   FileCard,
+  OpenInNewTab,
   PlanList,
   Spinner,
@@ -44,5 +45,5 @@ import {
   toolEntries,
 } from '../view/timeline.ts';
-import { TaskComputer } from './computer.tsx';
+import { previewReloadKey, TaskComputer } from './computer.tsx';
 
 /** Секунды работы цикла: от его начала до конца (или до сейчас, пока задача жива), тикает раз в секунду. */
@@ -292,4 +293,6 @@ export function TaskScreen({ id }: { id: string }) {
   const result = answerStep?.text ?? task.result;
   const delivered = answerStep ? outputs.filter(f => answerStep.files.includes(f.path)) : outputs;
+  const site = store.preview.value;
+  const preview = site && { url: site.url, reloadKey: previewReloadKey(task.cycle, outputs) };
 
   const sendMessage = async (text: string) => {
@@ -357,5 +360,5 @@ export function TaskScreen({ id }: { id: string }) {
 
   return (
-    <Shell computer={<TaskComputer entries={computerEntries(allEntries)} />}>
+    <Shell computer={<TaskComputer entries={computerEntries(allEntries)} preview={preview} finished={finished} />}>
       {statusRegion}
       <div class="ui-shell__body" ref={feed}>
@@ -469,4 +472,6 @@ export function TaskScreen({ id }: { id: string }) {
                   </Badge>
                 )}
+                {/* Панель скрыта на средней ширине экрана: сайт остаётся доступен отсюда. */}
+                {preview && <OpenInNewTab href={preview.url}>Open preview</OpenInNewTab>}
               </div>
             </>
```

- [ ] **Step 4: Run them and see them pass**

Run:

```bash
bun run test:ui
bun run test:web
bun run format && bun run check
bun run test:unit
```

Expected: PASS, без предупреждений. Витрина держит `OpenInNewTab` в `ComputerPanel`: `showcase.test.tsx` требует каждый экспорт.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add packages/ui/test/dom.ts packages/ui/test/agent.test.tsx packages/ui/test/styles.test.ts apps/web/test/dom.ts apps/web/test/task-screen.test.tsx packages/ui/src/agent/computer.tsx packages/ui/styles/agent.css packages/ui/styles/layout.css packages/ui/showcase/src/sections/agent.tsx packages/ui/README.md apps/web/src/state/task.ts apps/web/src/routes/computer.tsx apps/web/src/routes/task.tsx
git commit -m "feat: the computer panel switches between the site and the activity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Промпты и сквозной тест

**Files:**

- Create: `packages/agent/test/agent/prompts.test.ts`
- Modify: `packages/agent/src/agent/prompts.ts`
- Modify: `packages/api/test/web-stack.ts`
- Modify: `apps/web/playwright.config.ts`
- Modify: `apps/web/e2e/task.spec.ts`
- Test: `packages/agent/test/agent/composer.test.ts`

**Interfaces:**

- Consumes: всё из задач 1–4; `walkFiles` композера обходит `outputs/`.
- Produces: строки в `PROMPTS.executorSystem`, `PROMPTS.plannerPlanSystem`, `PROMPTS.composerSystem`; `PREVIEW_HOST` и `PREVIEW_SECRET` в `web-stack.ts`; второй цикл сценария выдаёт `outputs/index.html`.
- Result: модель знает, как выдать сайт; настоящий браузер подтверждает изоляцию.

- [ ] **Step 1: Write the failing tests**

`packages/agent/test/agent/prompts.test.ts` (новый файл):

```ts
import { expect, test } from 'bun:test';
import { PROMPTS } from '../../src';

test('a website is built to open as static files and delivered as its built folder under outputs/', () => {
  expect(PROMPTS.executorSystem).toContain('opens as static files');
  expect(PROMPTS.executorSystem).toContain('outputs/dist/');
  expect(PROMPTS.plannerPlanSystem).toContain('outputs/dist/index.html');
  expect(PROMPTS.composerSystem).toContain('a built website there keeps all its assets');
});
```

`packages/agent/test/agent/composer.test.ts`:

```diff
@@ -67,4 +67,16 @@ async function finalizingWithReport(c: C, reportFiles: string[]) {
 
 describe('ResultComposer', () => {
+  test('a built site under outputs/ is delivered whole, without its dependency folders', async () => {
+    const c = setupAgent();
+    const task = await finalizing(c, { outputs: false });
+    const sandbox = await c.sandboxes.create(task.id);
+    await sandbox.writeFile('outputs/dist/index.html', '<script src="/assets/app.js"></script>');
+    await sandbox.writeFile('outputs/dist/assets/app.js', 'console.log(1)');
+    await sandbox.writeFile('outputs/dist/node_modules/x/index.js', 'x');
+    c.llm.push(calls(['finish', { answer: 'Your site is ready.', files: ['outputs/dist/index.html'] }]));
+    const { files } = await c.composer.compose(task.id);
+    expect(files.toSorted()).toEqual(['outputs/dist/assets/app.js', 'outputs/dist/index.html']);
+  });
+
   test('uses an earlier finish without calling the model, and adds outputs/', async () => {
     const c = setupAgent();
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test packages/agent/test/agent/prompts.test.ts packages/agent/test/agent/composer.test.ts`

Expected: FAIL только в `a website is built to open as static files…`: `expect(received).toContain(expected)`. Новый тест композера проходит сразу: он закрепляет поведение, на которое опирается промпт.

- [ ] **Step 3: Implement**

Скрипт сайта не объявляет глобальную переменную `top`: у `window` это неизменяемое свойство, и `let top` дал бы `SyntaxError`, а сайт бы молча не выполнился.

`packages/agent/src/agent/prompts.ts`:

```diff
@@ -6,4 +6,5 @@ export const PROMPTS = {
     'Work step by step with the tools. Prefer small, verifiable steps; inspect results before moving on.',
     'Put final deliverables under outputs/. If you built a project elsewhere in /workspace, copy it there before you report, without dependency folders such as node_modules. Input files from the user are under inputs/.',
+    'If the result is a website or web app, build it so that it opens as static files, and copy the built folder with its assets to outputs/, for example outputs/dist/.',
     'When the done criteria are met, call report with a summary, the files you produced and any open issues.',
     'If you cannot continue without the user, call ask_user with one clear question.',
@@ -13,4 +14,5 @@ export const PROMPTS = {
     'Each subtask is a contract: goal, context (what the executor must know), verifiable done_criteria and',
     'expected_outputs (files under outputs/). Keep the plan short: as few subtasks as the work needs.',
+    'For a website or web app, expect its built folder with all assets under outputs/, for example outputs/dist/index.html.',
     'Plan a follow-up to earlier work as the smallest change to the existing files: do not redo what is already done.',
     'Ask the user (ask_user) only if the request cannot be planned without their answer.',
@@ -24,4 +26,5 @@ export const PROMPTS = {
     'You are the planner writing the final answer for the user. Use the subtask reports below.',
     'Call finish with a clear, complete answer and the list of files to deliver: only paths from the list of files in the workspace below.',
+    'Everything under outputs/ is delivered without being named, so a built website there keeps all its assets.',
   ].join('\n'),
   summarySystem: [
```

`packages/api/test/web-stack.ts`:

```diff
@@ -28,4 +28,24 @@ function testDatabaseUrl(): string {
 }
 
+/**
+ * Сайт второго цикла: заголовок показывает, что скрипт выполнился, localStorage работает и живёт между загрузками,
+ * а окно приложения недоступно. window.top.document бросает исключение, потому что origin сайта чужой.
+ */
+const SITE = `<!doctype html>
+<title>loading</title>
+<p>Site ready</p>
+<script>
+  const visits = Number(localStorage.getItem('visits') ?? 0) + 1;
+  localStorage.setItem('visits', String(visits));
+  let app = 'top-open';
+  try {
+    void window.top.document.title;
+  } catch {
+    app = 'top-blocked';
+  }
+  document.title = 'visits-' + visits + ':' + app;
+</script>
+`;
+
 const calls = (...list: Array<[string, unknown]>): ScriptedTurn => ({
   toolCalls: list.map(([name, args]) => toolCall(name, args)),
@@ -41,4 +61,7 @@ const config = loadConfig({
   DATABASE_URL: testDatabaseUrl(),
   BETTER_AUTH_URL: webOrigin,
+  // Превью без nginx: браузер идёт на <метка>.preview.localhost:<порт этого процесса>, Chromium резолвит *.localhost сам.
+  PREVIEW_HOST: `preview.localhost:${port}`,
+  PREVIEW_SECRET: 'web-e2e-preview-secret-of-32-characters',
   QUEUE_PREFIX: `web-e2e-${crypto.randomUUID()}`,
   SWEEP_EVERY_MS: '3600000',
@@ -46,5 +69,5 @@ const config = loadConfig({
 });
 // Сценарий агента: план, вопрос пользователю, файл, отчёт, приёмка, ответ с файлом; затем продолжение беседы:
-// новый план, тот же файл в новой версии, второй ответ.
+// новый план, тот же файл в новой версии, сайт для превью, второй ответ.
 const llm = new ScriptedLlm([
   calls(['create_plan', { subtasks: [{ goal: 'Write the greeting', done_criteria: 'hello.md exists' }] }]),
@@ -56,7 +79,8 @@ const llm = new ScriptedLlm([
   calls(['create_plan', { subtasks: [{ goal: 'Shorten the greeting', done_criteria: 'hello.md is short' }] }]),
   calls(['file_write', { path: 'outputs/hello.md', content: '# Hi' }]),
-  calls(['report', { summary: 'shortened', files: ['outputs/hello.md'] }]),
+  calls(['file_write', { path: 'outputs/index.html', content: SITE }]),
+  calls(['report', { summary: 'shortened', files: ['outputs/hello.md', 'outputs/index.html'] }]),
   calls(['accept', {}]),
-  calls(['finish', { answer: 'Now it is **shorter**.', files: ['outputs/hello.md'] }]),
+  calls(['finish', { answer: 'Now it is **shorter**.', files: ['outputs/hello.md', 'outputs/index.html'] }]),
 ]);
 const mailer = new CapturingMailer();
```

`apps/web/playwright.config.ts`:

```diff
@@ -29,5 +29,10 @@ export default defineConfig({
       command: 'bunx --bun vite --configLoader native',
       url: webOrigin,
-      env: { WEB_PORT: String(WEB_PORT), API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
+      // PREVIEW_HOST — для frame-src в CSP страницы; бэкенд ставит то же значение сам (web-stack.ts).
+      env: {
+        WEB_PORT: String(WEB_PORT),
+        API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
+        PREVIEW_HOST: `preview.localhost:${API_PORT}`,
+      },
       timeout: 60_000,
       reuseExistingServer: false,
```

`apps/web/e2e/task.spec.ts`:

```diff
@@ -58,4 +58,8 @@ test('sign in with a magic link, run a task that asks a question, read the answe
   ).toContainText('completed');
 
+  // Первый цикл сайта не выдал: переключателя нет.
+  const computer = page.getByRole('region', { name: "Agent's computer" });
+  await expect(computer.getByRole('button', { name: 'Preview' })).toHaveCount(0);
+
   /** Скачивание по ссылке файла: /api/files/:id → redirect на presigned GET (attachment). */
   const downloadText = async (name: RegExp, filename: string) => {
@@ -88,4 +92,21 @@ test('sign in with a magic link, run a task that asks a question, read the answe
   expect(await readFile(await (await latest).path(), 'utf8')).toBe('# Hi');
 
+  // Превью: второй цикл выдал outputs/index.html, панель открыла сайт сама.
+  await expect(computer.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true');
+  await expect(page.frameLocator('iframe[title="Site preview"]').getByText('Site ready')).toBeVisible();
+  const site = () => page.frames().find(f => f.url().includes('.preview.localhost:5197/'));
+  // Скрипт выполнился, localStorage работает, окно приложения недоступно (его origin чужой).
+  await expect.poll(() => site()?.title()).toBe('visits-1:top-blocked');
+  expect(await site()?.evaluate(() => document.cookie)).toBe('');
+  // Хранилище сайта — своё: в приложение его запись не попала, а между загрузками сайта она живёт.
+  expect(await page.evaluate(() => localStorage.getItem('visits'))).toBeNull();
+  const newTab = computer.getByRole('link', { name: 'Open in new tab' });
+  await expect(newTab).toHaveAttribute('rel', 'noopener noreferrer');
+  expect(await newTab.getAttribute('href')).toBe(site()?.url());
+  await computer.getByRole('button', { name: 'Activity' }).click();
+  await expect(computer.locator('iframe')).toHaveCount(0);
+  await computer.getByRole('button', { name: 'Preview' }).click();
+  await expect.poll(() => site()?.title()).toBe('visits-2:top-blocked');
+
   // Library показывает результат задачи; удаление задачи возвращает на главную и убирает его файлы.
   await page.getByRole('link', { name: 'Library' }).click();
```

- [ ] **Step 4: Run them and see them pass**

Run:

```bash
bun test packages/agent/test/agent/prompts.test.ts packages/agent/test/agent/composer.test.ts
bun run format && bun run check
bun run test:unit
```

Expected: PASS, без предупреждений. `web-stack.ts` и `task.spec.ts` здесь только типизируются.

- [ ] **Step 5: Пройти сквозной тест в браузере**

Нужны Docker и Chromium Playwright; только из основного checkout, с `.env.test`.

Run:

```bash
bun run infra:up && bun run infra:wait
bun run test:e2e:web
```

Expected: PASS. Первый цикл без переключателя, второй открывает сайт сам, заголовок фрейма `visits-1:top-blocked`, после переключения на Activity и обратно `visits-2:top-blocked`, `cspViolations` пуст.

- [ ] **Step 6: Commit**

```bash
bun run format && bun run check
git add packages/agent/test/agent/prompts.test.ts packages/agent/test/agent/composer.test.ts packages/agent/src/agent/prompts.ts packages/api/test/web-stack.ts apps/web/playwright.config.ts apps/web/e2e/task.spec.ts
git commit -m "feat: prompts deliver built sites; the browser test opens a preview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Проверка и документы

**Files:**

- Modify: `docs/superpowers/plans/2026-10-31-roadmap.md`
- Modify: `docs/superpowers/specs/2026-10-31-agent-platform-design.md`
- Modify: `docs/beta-checklist.md`
- Modify: `backlog.md`

**Interfaces:**

- Consumes: всё из задач 1–5.
- Result: дорожная карта, спецификация, чек-лист и backlog говорят то же, что код; весь набор тестов зелёный.

- [ ] **Step 1: Обновить документы**

`docs/superpowers/plans/2026-10-31-roadmap.md`:

```diff
@@ -38,5 +38,5 @@ DI на awilix, TDD, контрактные тесты для каждого а
 | 8 | [Файлы задачи](2026-11-02-plan-8-task-files.md) | `finish` с несуществующим файлом отклоняется, запасной список файлов, `node_modules` не выгружается, предупреждение вместо «Task completed» | — | S | готово; на реальной модели не проверено, evals не запускались |
 | 9 | [Продолжение беседы](2026-11-03-plan-9-follow-ups.md) | сообщение в завершённой задаче запускает новый цикл над теми же файлами | 8 | L | готово; на реальной модели не проверено, evals не запускались |
-| 10 | Превью сайта | собранный статический сайт открывается в панели «Agent's computer» с отдельного домена | 8 | M | не начат |
+| 10 | [Превью сайта](2026-11-04-plan-10-preview.md) | собранный статический сайт открывается в панели «Agent's computer» с отдельного домена | 8 | M | готово; на реальной модели не проверено, evals не запускались |
 | 11 | Публикация по ссылке | кнопка «Publish»: постоянный публичный адрес статического сайта, снятие с публикации | 10 | M | не начат |
 | 12 | Память между задачами | факты о пользователе из его сообщений, просмотр и удаление в настройках | — | M | не начат |
@@ -65,9 +65,10 @@ DI на awilix, TDD, контрактные тесты для каждого а
 Главное решение: **отдаём выданные файлы из S3, а не проксируем порт песочницы.** Превью переживает удаление песочницы и не открывает доступ в её сеть. Приложения с сервером (Node, Flask) в этот план не входят.
 
-- **Безопасность.** Код от агента нельзя выполнять на домене приложения, иначе он получит сессию пользователя. Каждая задача получает свой поддомен (`<id>.preview.<домен>`), и он должен лежать на **отдельном регистрируемом домене**, а не на поддомене приложения: так ни один cookie приложения туда не попадёт. В разработке — `*.preview.localhost`.
-- **Доступ.** Подписанный токен с коротким сроком в адресе, потому что cookie приложения на этот домен не передаются. Страницу встраиваем в `iframe sandbox="allow-scripts allow-forms"` без `allow-same-origin`, с собственной CSP.
-- **Точка входа.** Первый найденный из `dist/index.html`, `outputs/dist/index.html`, `build/index.html`, `outputs/index.html`, `index.html`; его папка становится корнем поддомена. Поэтому абсолютные пути сборки Vite (`/assets/…`) работают без настройки `base`.
-- **Сервис.** Новый маршрут в `packages/api` или отдельный server-блок nginx с `server_name` по маске, новая вкладка в `ComputerPanel`, кнопка «Open in new tab». `docker-security.test.ts` расширить новым портом, если он появится.
-- **Готово, когда:** после задачи «собери тудулист» приложение кликается прямо в панели, а `document.cookie` и `localStorage` приложения из него недоступны (проверка в Playwright).
+- **Безопасность.** Код от агента нельзя выполнять на домене приложения, иначе он получит сессию пользователя. Каждая задача получает свой хост, и в продакшене он лежит на **отдельном регистрируемом домене**, а не на поддомене приложения: так ни один cookie приложения туда не попадёт. В разработке — `*.preview.localhost`. На таком хосте API отвечает только превью: `/api/*` там нет, cookie не читаются и не ставятся.
+- **Доступ.** Его несёт сам хост: `<id задачи>-<неделя>-<MAC>.<PREVIEW_HOST>`, одна метка DNS. Токен в адресе сломал бы абсолютные пути сборки, cookie третьей стороны блокируется во фрейме. Origin постоянен неделю, поэтому `localStorage` приложения живёт между открытиями; действуют текущая и прошлая неделя, и ссылка не служит бесплатным хостингом. Адрес получает только владелец задачи (`preview` в `GET /api/tasks/:id`).
+- **Фрейм.** `sandbox="allow-scripts allow-same-origin allow-forms allow-modals"`, без переходов верхнего окна и всплывающих окон. `allow-same-origin` намеренно: без него `localStorage` бросает исключение и обычное React-приложение падает. Это безопасно, потому что origin превью никогда не совпадает с origin приложения и сайт получает доступ только к самому себе. CSP сайта запрещает отправку форм и встраивание кем-либо, кроме приложения.
+- **Точка входа.** Первый найденный из `dist/index.html`, `outputs/dist/index.html`, `build/index.html`, `outputs/build/index.html`, `outputs/index.html`, `index.html`; его папка становится корнем хоста. Поэтому абсолютные пути сборки Vite (`/assets/…`) работают без настройки `base`.
+- **Сервис.** Обработчик в начале `createApp` и server-блок nginx с `server_name` по маске, переключатель Preview / Activity в `ComputerPanel`, кнопка «Open in new tab». Новых портов нет, `docker-security.test.ts` не меняется.
+- **Готово, когда:** после задачи «собери тудулист» приложение кликается прямо в панели, его `localStorage` работает, а `document.cookie` и окно приложения из него недоступны (проверка в Playwright).
 
 ### План 11: публикация по ссылке
```

`docs/superpowers/specs/2026-10-31-agent-platform-design.md`:

```diff
@@ -363,5 +363,5 @@ usage_events     id, user_id, task_id, model, tokens_in, tokens_out,
 | POST | `/api/tasks` | `{ prompt, fileIds[] }`, проверка кредитов и лимита активных задач |
 | GET | `/api/tasks` | Список задач пользователя; `?q=` — поиск по запросу |
-| GET | `/api/tasks/:id` | Задача, подзадачи, файлы |
+| GET | `/api/tasks/:id` | Задача, подзадачи, файлы, адрес превью сайта (`preview`, только владельцу) |
 | GET | `/api/tasks/:id/events` | SSE-стрим шагов |
 | POST | `/api/tasks/:id/messages` | `{ text, questionSeq? }`: ответ на `ask_user`; на законченной задаче без `questionSeq` — новый цикл работы с проверками как у `POST /api/tasks` (402, 429) |
@@ -372,4 +372,8 @@ usage_events     id, user_id, task_id, model, tokens_in, tokens_out,
 | DELETE | `/api/files/:id` | Удаление результата задачи |
 
+**Превью сайта:** запрос на хост под `PREVIEW_HOST` обрабатывается раньше охраны и всех маршрутов: только GET и HEAD,
+только файлы задачи из S3, `/api/*` там нет. Хост `<id задачи>-<неделя>-<MAC>.<PREVIEW_HOST>` сам несёт доступ, ссылка
+живёт не дольше двух недель, любая неудача — один и тот же 404. Пустой `PREVIEW_HOST` выключает превью: `preview: null`.
+
 **SSE:** событие = строка `steps`, `id` события = `seq`. При подключении
 с `Last-Event-ID` API сначала отдаёт пропущенные шаги из Postgres, затем
@@ -402,5 +406,7 @@ usage_events     id, user_id, task_id, model, tokens_in, tokens_out,
     задаче поле для следующего сообщения;
   - правая колонка — план с прогрессом подзадач, лента шагов текущей подзадачи
-    (вызовы инструментов свёрнуты, раскрываются), последний скриншот браузера;
+    (вызовы инструментов свёрнуты, раскрываются), последний скриншот браузера; если задача выдала сайт, панель
+    переключается между ним и шагами (Preview / Activity): законченный цикл открывает сайт сам, а ссылка
+    «Open in new tab» открывает его отдельно;
   - кнопка «Остановить».
 - Состояние задачи — сигналы, обновляемые из SSE.
@@ -452,4 +458,7 @@ backlog.md
 - У агента нет инструментов с внешними последствиями (почта, платежи, публикации),
   поэтому инструкции со страниц в интернете не могут привести к таким действиям.
+- Сайт от агента открывается только на отдельном хосте (`PREVIEW_HOST`, в продакшене — отдельный регистрируемый домен):
+  cookie приложения туда не попадают, окно приложения для него чужой origin. CSP сайта запрещает отправку форм и встраивание
+  кем-либо, кроме приложения. Файлы отдаются из S3, в сеть песочницы превью не ходит.
 - Лимиты ресурсов контейнера, лимиты шагов, токенов и времени.
 - Docker-изоляция недостаточна для публичного доступа — только закрытая бета (6.2).
```

`docs/beta-checklist.md`:

```diff
@@ -69,4 +69,15 @@ dc() { docker compose --env-file .env.prod -f docker/compose.prod.yml "$@"; }
       передаёт `Host` как есть: nginx стека отвечает 444 на чужой `Host`, а подпись presigned URL в Garage
       привязана к `Host`.
+- [ ] Превью сайтов (необязательно; `PREVIEW_HOST` пуст — выключены, `preview: null`):
+      - `PREVIEW_HOST` — **отдельный регистрируемый домен**, не поддомен приложения: `example-usercontent.net` при
+        `agent.example.com`. Иначе cookie родительского домена дойдут до кода агента. `loadConfig` ловит только совпадение и
+        поддомен самого `APP_ORIGIN`; соседа вроде `preview.example.com` он отличить не может, это проверка здесь;
+      - wildcard DNS `*.PREVIEW_HOST` на хост и wildcard-сертификат (Let's Encrypt — через DNS-01); reverse proxy ведёт
+        `*.PREVIEW_HOST` на `127.0.0.1:APP_PORT`, передаёт `Host` как есть и **не добавляет заголовков**: CSP и остальное
+        ставит API, а CSP приложения поверх них сломает сайт. HSTS этому имени не нужен: ссылки живут две недели;
+      - ключ подписи — `PREVIEW_SECRET` (`openssl rand -hex 32`), без него выводится из `BETTER_AUTH_SECRET`. Смена ключа
+        отключает все выданные адреса: экран задачи получит новый при следующем чтении карточки;
+      - проверка: `curl -s -o /dev/null -w '%{http_code}' https://x.PREVIEW_HOST/api/health` отвечает `404`, а
+        `dc logs nginx` не содержит имён хостов превью (в них MAC).
 - [ ] `real_ip`: reverse proxy стоит на другом адресе, чем клиенты, поэтому без настройки лимиты (`limit_req` nginx и
       Better Auth) считаются по одному IP на всех. Раскомментировать `set_real_ip_from` / `real_ip_header` /
```

`backlog.md`:

```diff
@@ -58,6 +58,11 @@
 - [ ] Файл, который агент удалил в более позднем цикле, остаётся в Library и возвращается после восстановления песочницы:
       восстанавливаются все файлы задачи из базы.
-- [ ] Превью собранного приложения в панели «Agent's computer» (план 10): сначала статический сайт, на отдельном домене — код
-      агента нельзя запускать на домене приложения, иначе он получит доступ к сессии пользователя.
+- [ ] Превью приложений с сервером и живое превью во время работы: план 10 отдаёт только выданные статические файлы, а
+      проксировать порт песочницы можно лишь после надёжной изоляции.
+- [ ] Превью: `about/index.html` на адресе `/about/`. Сейчас совпадение точное, поэтому многостраничный сайт без клиентской
+      маршрутизации получает главную; нужно генераторам статики (Astro, Hugo).
+- [ ] Превью: файлы потоком вместо `fileStore.getBytes`. Порт читает файл целиком в память (до 50 МиБ на запрос); на бете
+      память держит `limit_req`, для публичного запуска нужен метод порта со `stream()`.
+- [ ] Превью: свои домены и кнопка «поделиться». Ссылка несёт доступ и живёт до двух недель, но в интерфейсе ей не делятся.
 - [ ] Параллельные исполнители (план 13): подзадачи без зависимостей (`depends_on`) выполняются одновременно.
 - [ ] Деплой сайтов (план 11) и приложений с сервером (после надёжной изоляции) по публичной ссылке.
```

- [ ] **Step 2: Запустить всё**

Run:

```bash
bun run format && bun run check
bun run test:unit
bun run infra:up && bun run infra:wait
bun run test
bun run test:e2e:web
bun run prod:smoke
```

Expected: всё зелёное, без предупреждений. `bun run test` идёт с настоящими Postgres, Valkey и Garage, тестам песочницы нужен образ `bun run sandbox:build`. `bun run prod:smoke` поднимает продакшен-вариант и проверяет хост превью через сокет.

Затем стек разработки и настоящий nginx из `docker/nginx/nginx.conf`. `stack:up` пересоздаёт контейнеры `agent-dev` с `.env` разработчика, тома не трогает:

```bash
bun run stack:up
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: x.preview.localhost:8080' http://localhost:8080/api/health
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Host: x.preview.localhost:8080' http://localhost:8080/
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/api/health
```

Expected: `404`, `403`, `200`.

Если что-то падает, исправить в той задаче, к которой относится код, и повторить этот шаг.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add backlog.md docs/beta-checklist.md docs/superpowers/plans/2026-10-31-roadmap.md docs/superpowers/plans/2026-11-04-plan-10-preview.md docs/superpowers/specs/2026-10-31-agent-platform-design.md
git commit -m "docs: plan 10 done; previews in the spec and the beta checklist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
