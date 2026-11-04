# Закрытая бета: чек-лист и runbook

Стек беты — `docker/compose.prod.yml` на одном Linux-хосте (VM), переменные — в `.env.prod` (образец
`.env.prod.example`), снаружи — TLS reverse proxy хоста. Бета закрытая: только приглашённые и доверенные пользователи
(спецификация 1, 6.2, 15). Команды ниже запускаются из корня репозитория на хосте; `dc` — сокращение:

```bash
dc() { docker compose --env-file .env.prod -f docker/compose.prod.yml "$@"; }
```

Проект compose называется `agent-prod`: тома — `agent-prod_pgdata`, `agent-prod_valkeydata`, `agent-prod_garagemeta`,
`agent-prod_garagedata`; песочницы беты несут метку `agent.sandbox.ns=prod`. Бэкапы лежат вне репозитория, в
`BACKUP_DIR` (по умолчанию `/var/backups/agent`, права `700`; раздел «Бэкапы»).

## Перед приглашением пользователей

### Хост и изоляция

- [ ] Отдельная VM только под этот стек: на хосте нет других сервисов, данных и ключей. Прокси Docker API
      (`docker/docker-proxy.yml`) разрешает воркеру только пути API, нужные песочницам. Bind mount он отклоняет лишь в
      тех телах `POST /containers/create`, которые умеет разобрать; том с драйвером `local` и опциями bind
      (`--mount type=volume,volume-opt=type=none,volume-opt=o=bind,…`), `--privileged`, `--network host`,
      `--pid host`, `cap-add` и `exec` в любой контейнер хоста он не запрещает. Это защита от ошибок, а не граница
      безопасности: взломанный воркер — root на VM. Поэтому VM одноразовая (пересоздаётся из чистого образа),
      а настоящая граница — E2B или gVisor;
      для публичного запуска они обязательны (backlog «Надёжная изоляция песочниц»).
- [ ] `DOCKER_GID` в `.env.prod` — группа сокета Docker на хосте: `getent group docker | cut -d: -f3`. Без неё
      `docker-proxy` не откроет сокет и не станет здоровым (на Docker Desktop и OrbStack — оставить пустым).
- [ ] Исходящий трафик песочниц на Linux. Правила `ip rule … blackhole` внутри песочницы проверены только на OrbStack;
      на сервере нужен независимый слой — правила `DOCKER-USER`, которые запрещают из сети `agent-sandbox` шлюз хоста,
      сети compose и `169.254.169.254` (backlog «Фильтрация исходящего трафика песочниц на Linux»), и работающий DNS
      в песочнице (backlog «DNS в песочницах на Linux не проверен»). Проверка на хосте:
      1. `bun test packages/sandbox/test/docker-security.test.ts` (нужны репозиторий, Bun и образ песочницы) —
         изоляция самой песочницы: пользователь, лимиты, шлюз, метаданные, IPv6. Контейнеры стека беты (проект
         `agent-prod`) он не ищет — только проект `agent-dev`.
      2. Вручную, пока идёт любая задача: `docker ps --filter label=agent.sandbox.ns=prod` даёт имя песочницы;
         `docker exec <имя> curl -m 3 -sS http://<ip>:<порт>` не должен соединяться ни с одним из адресов
         `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' agent-prod-postgres-1`
         (так же `valkey`, `api`, `nginx`, `docker-proxy`; порты 5432, 6379, 3000, 8080, 2375), ни со шлюзом хоста,
         ни с `169.254.169.254`; при этом `curl -m 5 -sS https://example.com` работает (DNS).
- [ ] Диск: под `/var/lib/docker` свободно не меньше 50 ГБ и включён мониторинг заполнения — квоты места на песочницу
      нет (backlog). Песочница законченной задачи с томом `/workspace` хранится ещё `SANDBOX_RETENTION_MS` (по умолчанию
      час), чтобы беседу можно было продолжить: диска нужно на все задачи, законченные за этот срок. Если места мало,
      срок уменьшают: тогда файлы вернутся из S3, но зависимости агент поставит заново.
- [ ] Образ песочницы собран на хосте: `bun run sandbox:build` (или `SANDBOX_IMAGE` указывает на свой тег). Без него
      первая же задача падает.

### Секреты и адреса

- [ ] `.env.prod` заполнен, права `600`, в git его нет (`git check-ignore .env.prod`; `.env` и `.env.prod` — в
      `.gitignore`, не коммитить и не вставлять в чаты и тикеты). Секреты — новые, не из `.env.example`:
      `openssl rand -hex 32` (Postgres, Valkey, Garage), `openssl rand -base64 32` (`BETTER_AUTH_SECRET`).
      `S3_ACCESS_KEY_ID` — `GK` и 24 шестнадцатеричных символа (`GK$(openssl rand -hex 12)`), `S3_SECRET_ACCESS_KEY` —
      `openssl rand -hex 32`.
- [ ] Что где нужно:
      - `BETTER_AUTH_SECRET` — API и воркер (воркеру для `admin:delete-user`: пользователей ведёт Better Auth);
        смена секрета разлогинит всех;
      - `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `PLANNER_MODEL`, `EXECUTOR_MODEL` — воркер (без них он не стартует);
        `BRAVE_API_KEY` — поиск (без него инструмент поиска сообщает «не настроен»);
      - `GOOGLE_*` / `GITHUB_*` — OAuth-приложения (ниже); `SMTP_URL` и `MAIL_FROM` — почта (ниже);
      - `S3_PUBLIC_ENDPOINT` — https-адрес, по которому **браузер** ходит в S3 (presigned URL и `connect-src` CSP):
        только origin — `https://files.example.com` или `https://host:port`, без пути. nginx берёт для CSP origin
        адреса (`docker/nginx/prod/s3-public-origin.envsh`) и не стартует, если это не `http(s)://host[:port]`.
- [ ] `APP_ORIGIN` и `S3_PUBLIC_ENDPOINT` — `https://`: cookie сессии получают `Secure` и префикс `__Secure-`. Если
      `APP_ORIGIN` не совпадёт с адресом в браузере, вход и все POST отклонит проверка Origin.
- [ ] TLS reverse proxy хоста (Caddy или nginx с сертификатом Let's Encrypt): `APP_HOST` → `127.0.0.1:APP_PORT`
      (по умолчанию 8080), имя для файлов (`S3_PUBLIC_ENDPOINT`) → `127.0.0.1:GARAGE_PORT` (3900); HSTS, редирект с
      http на https, `client_max_body_size` на имени для файлов не меньше `UPLOAD_MAX_BYTES` (50 МиБ). Прокси
      передаёт `Host` как есть: nginx стека отвечает 444 на чужой `Host`, а подпись presigned URL в Garage
      привязана к `Host`.
- [ ] Превью сайтов (необязательно; `PREVIEW_HOST` пуст — превью выключены, `preview: null`):
      - `PREVIEW_HOST` — **отдельный регистрируемый домен**, не поддомен приложения: `example-usercontent.net` при
        `agent.example.com`. `loadConfig` ловит только совпадение и поддомен самого `APP_ORIGIN`; соседа вроде
        `preview.example.com` он отличить не может, это проверка здесь. Соседний поддомен опасен в обе стороны:
        - сайт агента на `preview.example.com` может выставить cookie с `Domain=example.com` и тем самым подсунуть
          приложению на `app.example.com` свою cookie сессии (session fixation);
        - превью под одним родителем делят cookie между собой: cookie с `Domain=example-usercontent.net` уходит на все
          превью. Cookie-бомба одного сайта раздувает заголовок `Cookie` и ломает все превью в этом браузере (заголовок
          отвергается до API). Закрыть это может только Public Suffix List: домен превью в её приватной секции — тогда
          браузер не ставит cookie на родителя, и каждое превью становится отдельным сайтом. Рекомендуется подать домен на
          добавление: https://publicsuffix.org/submit/;
      - wildcard DNS `*.PREVIEW_HOST` на хост и wildcard-сертификат (Let's Encrypt — через DNS-01). TLS reverse proxy
        ведёт `*.PREVIEW_HOST` на `127.0.0.1:APP_PORT`, передаёт `Host` как есть и **не добавляет заголовков**: CSP и
        остальные заголовки ставит API, а заголовок от прокси поверх них может сломать сайт. HSTS этому имени не нужен:
        ссылки живут две недели;
      - ключ подписи — `PREVIEW_SECRET` (`openssl rand -hex 32`); без него он выводится из `BETTER_AUTH_SECRET`. Смена
        ключа отключает все выданные адреса: карточка задачи выдаст новый при следующем чтении;
      - ссылка — bearer: имя хоста видно в DNS, в SNI TLS, в истории браузера и в журнале доступа TLS-прокси хоста (если
        он пишет `Host`). Журнал доступа nginx стека `Host` не пишет, но в журнал ошибок он попадает (уровень `error`,
        например при сбое upstream), поэтому утверждать, что `dc logs nginx` не содержит имён хостов превью, нельзя.
        Секреты в превью не кладут, журналы не пересылают без фильтра;
      - срок: ссылка живёт 7–14 дней (текущая и прошлая неделя). Origin меняется каждый понедельник в 00:00 UTC:
        `localStorage` сайта в новой неделе пуст. Истёкшая ссылка отвечает голым `Not found` (404), без объяснения.
        Отозвать одну ссылку нельзя; отключает все только смена `PREVIEW_SECRET`;
      - `UPLOAD_MAX_BYTES` больше 256 МиБ (`PREVIEW_INFLIGHT_BYTES`, бюджет памяти превью): файл крупнее бюджета отвечает
        503 навсегда, поэтому предел держат не выше;
      - проверка: `curl -s -o /dev/null -w '%{http_code}' https://x.PREVIEW_HOST/api/health` отвечает `404`.
- [ ] `real_ip`: reverse proxy стоит на другом адресе, чем клиенты, поэтому без настройки лимиты (`limit_req` nginx и
      Better Auth) считаются по одному IP на всех, в том числе превью (`limit_req` и `limit_conn` зоны `preview` и
      `previewconn`): все пользователи превью делят один предел соединений, и чужая страница с сотней файлов может
      отказать вашей. Раскомментировать `set_real_ip_from` / `real_ip_header` /
      `real_ip_recursive` в `docker/nginx/prod/nginx.conf`, вписав адрес или подсеть прокси (для прокси на том же
      хосте — шлюз сети Docker, `docker network inspect agent-prod_default`), и пересобрать (`bun run prod:up`).
      Проверка: два запроса с разных машин оставляют в access-логе nginx (`dc logs nginx`, первое поле —
      `$remote_addr`) адреса клиентов, а не адрес прокси (API `X-Real-IP` не пишет). Reverse proxy должен
      дописывать `X-Forwarded-For` клиентским адресом.

### Вход и почта

- [ ] OAuth-приложения Google и GitHub: callback `https://<APP_HOST>/api/auth/callback/google` и `…/github`;
      id и секрет — в `.env.prod`, только парой (провайдер включается, когда заданы оба значения). Без них остаётся
      вход по ссылке.
- [ ] Почта: `SMTP_URL` (`smtps://user:password@smtp.example.com:465` или STARTTLS на 587) и `MAIL_FROM` заданы, домен
      отправителя подтверждён у провайдера (SPF, DKIM, DMARC). Проверка — войти по ссылке на свой адрес, письмо
      приходит, в `dc logs api` нет предупреждения `magic links are written to the log`. **Без SMTP ссылки для входа
      пишутся в лог API** — тогда оператор видит чужие ссылки входа: допустимо только для заведомо доверенных
      тестеров, которых вы вводите сами.
- [ ] Вход проверен в браузере всеми включёнными способами; выход и повторный вход работают.
- [ ] Лимиты входа: Better Auth ограничивает запросы по IP (включено, пока `NODE_ENV` не `development` — в
      `compose.prod.yml` он `production`).

### Кредиты и лимиты

- [ ] Цены моделей (`PLANNER_PRICE_*`, `EXECUTOR_PRICE_*`, кредитов за 1M токенов) соответствуют реальной
      стоимости в LiteLLM, иначе кредиты списываются неверно.
- [ ] Каждому приглашённому — кредиты после первого входа (раздел «Кредиты»): у нового аккаунта их нет.
- [ ] Лимиты: `MAX_ACTIVE_TASKS_PER_USER` (по умолчанию 2), `TASK_TOKEN_BUDGET` (2 000 000), `TASK_WALL_TIME_MS`
      (2 ч), `UPLOAD_MAX_BYTES` (50 МиБ) — осознанно выбраны. Rate limiting по пользователю — backlog; до него
      работают `limit_req` nginx (20 запросов/с на IP с пачкой 100 для `/api/`), лимиты Better Auth на вход и
      баланс кредитов.
- [ ] `SANDBOX_RETENTION_MS` (по умолчанию 3600000, час) — сколько остановленная песочница законченной задачи ждёт
      продолжения беседы, прежде чем её удалит сборщик. Больше — дольше держится диск (см. «Диск» выше); меньше — продолжение
      чаще начинается с восстановления из S3, и зависимости ставятся заново.
- [ ] Загрузки, объявленные, но не привязанные к задаче, сборщик удаляет (запись и объект S3) через `UPLOAD_TTL_MS`
      (по умолчанию сутки; минимум час — дольше самого долгого presigned PUT). Предел числа таких загрузок на
      пользователя — backlog.

### Качество агента

- [ ] Прогон evals на моделях беты (на машине разработчика: `bun run infra:up`, образ песочницы и `.env` с теми же
      `LITELLM_*`, `PLANNER_MODEL`, `EXECUTOR_MODEL`): `bun run evals`. Задачи-исследования без `BRAVE_API_KEY`
      пропускаются (`skipped`) — для полного прогона ключ нужен. Отчёт `evals/results/<время>/report.md` сохранён,
      непрошедшие задачи разобраны по `steps.json`.
- [ ] Промпт планировщика изменился (продолжение беседы): прогон evals на ключах LiteLLM повторить и сравнить с базовым
      (`--compare`). В evals нет ни одной задачи с продолжением беседы, поэтому прогон его не проверит: проверить вручную
      на реальной модели.
- [ ] `PROMPTS` изменились в плане 10 (сборка сайта кладётся в `outputs/`, `packages/agent/src/agent/prompts.ts`):
      прогон evals на машине разработчика повторить и сравнить с базовым (`--compare`). В плане 10 evals не запускались.
- [ ] `bun run prod:smoke --browser` на машине разработчика — все проверки зелёные (поднимает одноразовую копию
      стека на :58080 со своими секретами и убирает её; секретов беты не читает).

### Наблюдаемость и бэкапы

- [ ] Внешняя проверка `https://<APP_HOST>/api/health` раз в минуту с оповещением (любой uptime-сервис); отдельно
      оповещение при заполнении диска больше 80 % и при перезапусках контейнеров (`docker events` или проверка
      `dc ps` по cron: `restarting`, `unhealthy`, `exited`).
- [ ] Место под песочницы смотреть отдельно: каждая законченная задача держит остановленный контейнер и том `/workspace`
      до `SANDBOX_RETENTION_MS`, и ничто не ограничивает их общий объём. Раз в день `docker system df` и число томов
      `agent-ws-*` (`docker volume ls -q --filter name=agent-ws-`), сравнить с числом задач, законченных за последний
      `SANDBOX_RETENTION_MS`.
- [ ] Логи не растут бесконечно и закрыты от посторонних. Драйвер `json-file` с ротацией в `/etc/docker/daemon.json`:
      `{"log-driver": "json-file", "log-opts": {"max-size": "50m", "max-file": "5"}}`, затем `systemctl restart docker`
      и пересоздание контейнеров (`bun run prod:up`; настройка действует только на новые контейнеры). Доступ к
      `/var/lib/docker/containers` и к `docker` — только операторам. Access-лог nginx без query string
      (`prod:smoke` это проверяет), но **error-лог nginx может содержать строку запроса со ссылкой входа** (например,
      `request: "GET /api/auth/magic-link/verify?token=… "` при недоступном API): поэтому логи не пересылать в
      сторонние сервисы без фильтра и ротировать. Ссылка одноразовая, хранится хэшем и живёт 15 минут, так что
      просроченный лог безопасен.
- [ ] Бэкап Postgres и Garage по расписанию (раздел «Бэкапы», cron на хосте) в `BACKUP_DIR` вне репозитория, копия —
      вне VM; восстановление проверено хотя бы раз на отдельном проекте (`P=agent-restore`).
- [ ] Расход виден (токены и милликредиты по дням):
      ```bash
      dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"' <<'SQL'
      select date_trunc('day', created_at) as day, sum(millicredits) as millicredits, sum(tokens_in + tokens_out) as tokens
      from usage_events group by 1 order by 1 desc limit 14;
      SQL
      ```

### Пользователи и данные

- [ ] Приглашённые знают, что это бета: оператор технически видит их задачи и файлы, ответы и файлы создаёт модель
      (проверять), задачи с чужими секретами и персональными данными ставить нельзя, песочницы выходят в интернет.
- [ ] Пользователи удаляют аккаунт сами (Settings → Delete account); по запросу — `admin:delete-user` (раздел
      «Удаление данных»); срок ответа на запрос определён; пользователям сказано, что в бэкапах данные живут до ротации.
      Загрузка, начатая во время удаления, может оставить объект, который никто не собирает; если удаление сорвалось
      после выхода, пользователь видит понятное сообщение и удаляет аккаунт снова, войдя.

## Runbook

### Старт, остановка, логи

```bash
cp .env.prod.example .env.prod      # один раз, заполнить; chmod 600 .env.prod
bun run sandbox:build               # образ песочницы
bun run prod:up                     # сборка и старт; ждёт здоровых nginx и воркера
bun run prod:logs                   # api, worker, nginx, docker-proxy
dc ps                               # состояние и healthcheck
dc logs --since 1h worker           # логи сервиса за период
bun run prod:down                   # остановка; тома остаются
```

`prod:up` собирает образы и поднимает всё по зависимостям: Postgres, Valkey и Garage, потом `migrate` (миграции) и
`s3-cors` (CORS бакета для `APP_ORIGIN`), затем API, воркер и nginx. Воркер останавливается до 60 с
(`stop_grace_period`): текущий шаг доходит до конца, остальное подхватит сборщик после старта. `prod:down` не
удаляет тома; **`dc down -v` удаляет данные — не использовать на проде.**

### Обновление

```bash
git pull                                                   # или git checkout <тег>
# перед обновлением, в котором есть новые миграции, — бэкап Postgres (раздел «Бэкапы»)
dc stop worker                                             # только при миграциях: старый воркер не должен писать в новую схему
bun run prod:up                                            # пересобирает образы, migrate применяет миграции до старта api и воркера
dc ps && curl -fsS https://<APP_HOST>/api/health
```

Порядок при обновлении с миграциями: остановить воркер, применить миграции, запустить API и воркер. `prod:up` сам
миграции и запуск делает в этом порядке, но старый воркер до пересоздания продолжает работать, поэтому его останавливают
первым (`dc stop worker`).

Задачи в работе переживают перезапуск воркера: job вернётся в очередь (до 3 попыток), сборщик переставит зависшие
задачи (раз в минуту). Обновлять лучше в тихое время. Откат кода: `git checkout`
предыдущего тега и `bun run prod:up`. Откат схемы БД — только восстановлением из бэкапа: миграции идут вперёд.

### Миграции

Применяет сервис `migrate` при каждом `prod:up` (один раз, до API и воркера); если миграция падает, API и воркер не
стартуют: `dc logs migrate`. Вручную: `dc run --rm migrate`.

### Бэкапы

Postgres хранит пользователей, задачи, шаги, список файлов и кредиты; Garage — сами файлы. Valkey не бэкапится:
очередь восстанавливается из Postgres (сборщик ставит job задачам без активного job).

Бэкапы — в `BACKUP_DIR` вне репозитория (по умолчанию `/var/backups/agent`): не в рабочем дереве, где их может
захватить `git add` или контекст сборки образа (`backups/` на всякий случай есть в `.gitignore` и `.dockerignore`).

```bash
BACKUP_DIR=${BACKUP_DIR:-/var/backups/agent}
install -d -m 700 "$BACKUP_DIR" && stamp=$(date -u +%Y%m%dT%H%M%SZ)

# Postgres: логический дамп
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > "$BACKUP_DIR/pg-$stamp.dump"

# Garage: снимок метаданных (живую sqlite-базу копировать нельзя), затем метаданные без базы + база из снимка + данные
dc exec garage /garage meta snapshot --all
docker run --rm -v agent-prod_garagemeta:/v:ro -v "$BACKUP_DIR:/b" -e STAMP="$stamp" alpine sh -c '
  set -e
  snap=$(ls -d /v/snapshots/* | sort | tail -1)
  cp "$snap/db.sqlite" "/b/garagedb-$STAMP.sqlite"
  tar czf "/b/garagemeta-$STAMP.tgz" -C /v --exclude=./snapshots --exclude=./db.sqlite --exclude=./db.sqlite-shm --exclude=./db.sqlite-wal .'
docker run --rm -v agent-prod_garagedata:/v:ro -v "$BACKUP_DIR:/b" alpine tar czf "/b/garagedata-$stamp.tgz" -C /v .
```

- Делать Postgres и Garage в одной минуте: рассинхрон описан в «Восстановлении».
- Копировать `$BACKUP_DIR` за пределы VM (шифровать: в дампе пользователи и тексты задач); хранить не меньше 7 дней.
- Старые снимки Garage копятся в томе `garagemeta` (`snapshots/`): раз в неделю оставлять три последних
  (`docker run --rm -v agent-prod_garagemeta:/v alpine sh -c 'ls -d /v/snapshots/* | sort | head -n -3 | xargs -r rm -r'`).
- Расписание: cron на хосте раз в сутки. Блок выше сохранить в скрипт (с `set -e`, `cd` в корень репозитория,
  определением `dc` из начала документа и `BACKUP_DIR`); любой ненулевой код завершения — повод для оповещения.

### Восстановление

Проверять на чистой машине или в отдельном проекте compose (`P=agent-restore`) до того, как это понадобится.
Все команды ниже работают с проектом `$P` и его томами `${P}_…`: для репетиции `P=agent-restore` — тома беты
(`agent-prod_…`) не затрагиваются; `P=agent-prod` — только при настоящем восстановлении. Репетиция на хосте беты
получает свои порты, теги образов и пространство имён песочниц: иначе она заняла бы порты беты, пересобрала бы её
образы `:prod`, а её сборщик удалял бы песочницы беты.

```bash
P=agent-restore                              # репетиция; agent-prod — только для настоящего восстановления
BACKUP_DIR=${BACKUP_DIR:-/var/backups/agent}
stamp=<stamp>
dcp() { docker compose -p "$P" --env-file .env.prod -f docker/compose.prod.yml "$@"; }
[ "$P" = agent-prod ] || export APP_PORT=58081 GARAGE_PORT=53901 IMAGE_TAG=restore SANDBOX_NAMESPACE=restore

dcp down                                     # останавливает проект $P; тома остаются

# Postgres: поднять только базу проекта $P и залить дамп поверх (--clean пересоздаёт объекты)
dcp up -d --wait postgres
dcp exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < "$BACKUP_DIR/pg-$stamp.dump"
dcp stop postgres

# Garage: тома проекта $P удаляются (УДАЛЯЕТ ФАЙЛЫ ПРОЕКТА $P) и заполняются из архивов
echo "removing ${P}_garagemeta ${P}_garagedata"
docker volume rm -f "${P}_garagemeta" "${P}_garagedata"   # -f: на первой репетиции томов ещё нет
dcp up --no-start garage                     # создаёт пустые тома проекта $P
docker run --rm -v "${P}_garagemeta:/v" -v "$BACKUP_DIR:/b:ro" -e STAMP="$stamp" alpine sh -c \
  'tar xzf "/b/garagemeta-$STAMP.tgz" -C /v && cp "/b/garagedb-$STAMP.sqlite" /v/db.sqlite'
docker run --rm -v "${P}_garagedata:/v" -v "$BACKUP_DIR:/b:ro" alpine tar xzf "/b/garagedata-$stamp.tgz" -C /v

dcp up -d --build --wait nginx worker        # для P=agent-prod то же, что bun run prod:up
```

После репетиции: `dcp down -v` **при `P=agent-restore`** (удаляет тома репетиции; с `P=agent-prod` это удалит данные
беты).

Проверка (на `APP_PORT` проекта `$P`): вход, список задач, скачивание файла из старой задачи;
`dcp exec garage /garage bucket list` показывает `agent-files`. Если `.env.prod` менялся, `S3_ACCESS_KEY_ID` и `S3_SECRET_ACCESS_KEY` должны быть прежними
(Garage хранит ключ в метаданных). Рассинхрон Postgres и Garage: объекты новее бэкапа Postgres остаются без записей
(лишнее место, видно только ручной чисткой); записи новее бэкапа Garage указывают на отсутствующие объекты —
скачивание такого файла отвечает ошибкой хранилища. После восстановления задачи, шедшие на момент бэкапа, сборщик
доведёт сам: проверить `dcp logs worker`.

### Кредиты

Пользователь должен хотя бы раз войти (аккаунт появляется при первом входе; у нового кредитов нет).

```bash
dc exec api bun run admin:grant <email> <кредиты>      # например 10 или 0.5 (до трёх знаков)
```

Команда печатает новый баланс; повторный вызов начисляет ещё раз (это сумма, а не установка баланса).

### Удаление данных пользователя

Пользователь может удалить аккаунт сам: Settings → Delete account (`DELETE /api/me`, нужно ввести свой email). Тот же
порядок, что у команды ниже: сессии, объекты S3, пользователь; активная задача или задача, завершённая менее 10 минут
назад, — отказ 409 с объяснением. Контейнер API не видит Docker, поэтому песочницы не проверяются: оставшуюся уберёт
сборщик, когда строки задачи не станет. Команда нужна, когда пользователь просит удалить данные, но войти не может.

Команда выполняется в контейнере **воркера** (ему нужны Docker через прокси, чтобы проверить песочницы, и
`BETTER_AUTH_SECRET`); образ `api` Docker CLI не содержит.

```bash
dc exec worker bun run admin:delete-user <email>             # сначала сухой прогон: что будет удалено, ничего не меняет
dc exec worker bun run admin:delete-user <email> --yes       # удаление
```

- Сухой прогон печатает пользователя, число файлов и ключи объектов S3.
- С `--yes` команда **сначала отзывает все сессии** пользователя (новые задачи и загрузки на время удаления не
  начнутся; повторный вход по ссылке возможен — попросить пользователя не входить), потом проверяет и удаляет объекты
  S3 всех его файлов, затем самого пользователя: задачи, шаги, файлы, сессии, аккаунты OAuth и события расхода
  уходят каскадом.
- Команда **отказывает**, пока у пользователя есть задачи в работе, работающие песочницы его задач или задача, завершённая
  менее 10 минут назад (`--idle-minutes=N` меняет порог): финализатор отменённой задачи ещё может грузить файлы.
  Остановленная песочница не мешает: её удалит сборщик, когда строки задачи не станет.
  Порядок: отменить задачи в приложении (или дождаться конца) → подождать 10 минут → повторить сухой прогон → `--yes`.
- Без доступа к Docker (прокси лежит) команда тоже отказывает: проверить песочницы нельзя.
- В бэкапах данные остаются до их ротации — сообщить об этом в ответе на запрос. Журналы nginx и API могут хранить
  e-mail пользователя в логах входа до ротации.

### Evals перед изменением промптов и моделей

Любое изменение `PROMPTS` (`packages/agent/src/agent/prompts.ts`), ролей моделей или `LLM_TOOL_CHOICE` — на машине
разработчика, с теми же настройками, что в бете:

```bash
bun run evals                                    # базовый прогон до изменения
# …правки…
bun run evals --planner <модель> --executor <модель>
bun run evals --compare evals/results/<до>/report.json evals/results/<после>/report.json
```

Нужны `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `PLANNER_MODEL`, `EXECUTOR_MODEL` в `.env` (флаги меняют роли только для
прогона) и `BRAVE_API_KEY` для задач-исследований (без него они `skipped`). Отчёт запоминает модели, `tool_choice`,
коммит и хэш промптов. Выкатывать в бету, если пройденных задач не меньше базового прогона.

### Инциденты

- **Задача зависла.** Сборщик раз в минуту переставляет задачи без активного job; `waiting_user` дольше 24 ч
  завершается частичным результатом. Отменить можно в приложении от имени пользователя. Крайняя мера — прямая запись в базу:
  ```bash
  dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"' <<'SQL'
  update tasks set status = 'cancelled', finished_at = now(), updated_at = now()
  where id = '<id>' and status not in ('done', 'failed', 'cancelled');
  SQL
  ```
  `UPDATE 0` — задача уже завершена, менять нечего. В ленте задачи не будет шага отмены: открытые страницы увидят
  отмену только после перезагрузки. Песочницу остановит сборщик, после чего смотреть `dc logs worker`. Окно
  `admin:delete-user` (10 минут с конца задачи) считается от этого `updated_at`.
- **Песочницы копятся.** `docker ps -a --filter label=agent.sandbox.ns=prod` — работающие должны быть только у задач в
  работе; остановленные — только у задач, законченных за последний `SANDBOX_RETENTION_MS` (час): они ждут продолжения
  беседы. Остальные сборщик удаляет за проход. `docker system df` — место; тома `agent-ws-*` без задачи — сироты.
- **Модель недоступна.** Шаги падают с `LlmError`, job повторяется (3 попытки), потом задача `failed` с причиной:
  `dc logs worker`; проверить `LITELLM_BASE_URL` и ключ.
- **Вход не работает.** `dc logs api`: ошибки почты (`mail to … was not sent`), неверный `APP_ORIGIN` (отклонён Origin),
  неправильный callback OAuth. Лимит входа — подождать.
- **Загрузка файла не идёт.** CORS бакета для `APP_ORIGIN` (`dc logs s3-cors`, повтор — `dc run --rm s3-cors`),
  `S3_PUBLIC_ENDPOINT` и reverse proxy перед Garage (`Host`, размер тела).
- **Подозрение на компрометацию песочницы или воркера.** `bun run prod:down`, снимок VM для разбора, новые секреты
  (все из `.env.prod`, включая ключи LiteLLM, OAuth и SMTP), пересоздание VM из чистого образа, восстановление из бэкапа.
  Воркер, прошедший через прокси Docker, считается root на VM (раздел «Хост и изоляция»).
