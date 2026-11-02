# Agent platform

Autonomous agent SaaS: planner (DeepSeek) + executors (Qwen) via LiteLLM, sandboxed tools.
Spec: `docs/superpowers/specs/2026-10-31-agent-platform-design.md`.
Backend architecture: ports & adapters, DI with awilix, TDD (spec section 3.1).

## Requirements

- Bun 1.4+
- Docker with Compose

## Local setup

```bash
bun install
cp .env.example .env        # fill LITELLM_BASE_URL and LITELLM_API_KEY (worker), BETTER_AUTH_SECRET (API)
bun run infra:up && bun run infra:wait
bun run sandbox:build       # agent sandbox image (Chromium + Python + Node), takes a few minutes
bun run db:migrate
bun test                    # all tests (needs infra)
bun run test:unit           # fast tests, no Docker needed
```

## Run the app

`.env` needs `BETTER_AUTH_SECRET` (API, `openssl rand -base64 32`) and `LITELLM_BASE_URL`, `LITELLM_API_KEY`,
`PLANNER_MODEL`, `EXECUTOR_MODEL` (worker); the rest of `.env.example` works as is. The worker also needs the sandbox
image (`bun run sandbox:build`).

In Docker, on `http://localhost:8080`:

```bash
bun run stack:up            # infra, migrations, bucket CORS, worker, API, web app (Vite with HMR) behind nginx
bun run stack:logs          # the magic link is printed here (no mail provider yet)
docker compose -f docker/compose.yml --profile app exec api bun packages/api/src/admin-grant.ts you@example.com 10
```

Without Docker, on `http://localhost:5173` (each command in its own terminal):

```bash
bun run infra:up && bun run infra:wait && bun run db:migrate
bun run s3:cors             # once per Garage volume
NODE_ENV=development BETTER_AUTH_URL=http://localhost:5173 bun run api
bun run worker
bun run web:dev
bun run admin:grant you@example.com 10
```

Sign in with your email, open the link from the logs (API log without Docker), then grant credits: a user exists
after the first sign-in, and a new account has none. `NODE_ENV=development` is for local runs only: it turns off
Better Auth rate limiting and the production warning; the Docker stack leaves it unset.

## Evals

Reference tasks on real models (spec 14): `evals/tasks/<id>/task.json` (prompt, checks, budget) with input files in
`inputs/`. The runner puts each task through `TaskIntake` and an in-process worker (LiteLLM, Docker sandbox, S3) and
checks the result: files present and in their format, key facts in files and in the answer.

```bash
bun run evals --list                         # the task set
bun run evals                                # every task once (needs infra:up, sandbox:build and LiteLLM in .env)
bun run evals --only csv-revenue-by-region --repeat 3
bun run evals --planner qwen-max --executor qwen-turbo --tool-choice auto   # other model roles for this run
bun run evals --compare evals/results/A/report.json evals/results/B/report.json
```

- Needs `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `PLANNER_MODEL`, `EXECUTOR_MODEL` in `.env`; research tasks also need
  `BRAVE_API_KEY` and are `skipped` without it. Not part of `test` or `test:unit`: no automated test calls a real model.
- Runs use their own database (`agent_evals`, created on first run; `EVALS_DATABASE_URL` to override), queue prefix and
  sandbox namespace, so the dev worker and the evals never pick up each other's tasks. Outputs land in the dev bucket
  under `tasks/<taskId>/`.
- Results: `evals/results/<time>/report.md` (status, checks, model calls, tool calls and errors, tokens, credits, time),
  `report.json`, and per task `steps.json`, `answer.md`, `outputs/`. The report records the models, `tool_choice`,
  the commit and a hash of the agent prompts (`packages/agent/src/agent/prompts.ts`) — tune prompts and model roles
  by comparing reports.
- A task: `title`, `category` (`research`, `csv`, `scraping`, `document`, `code`), `prompt`, optional `requires: ["search"]`,
  `reply` (the answer to `ask_user`), `budget` (`modelCalls`, `tokens`, `minutes`; over budget the task is cancelled)
  and `checks`: `file` (path or glob, `format`, `minBytes`, CSV `columns`, `rows`, `contains`) and `answer` (`contains`).
  A fact is a substring (case-insensitive), `{ "regex", "flags" }`, `{ "anyOf": [...] }` or `{ "number", "tolerance" }`.

## UI kit

```bash
bun run ui:dev              # component showcase on http://localhost:5174
bun run ui:build            # static showcase build in packages/ui/showcase/dist
bun run test:ui             # ui-kit tests (happy-dom in its own process; part of test:unit)
```

`packages/ui` (`@agent/ui`) is the design system: tokens, `ui-*` styles, Preact components and agent patterns.
Usage, themes and the component list: `packages/ui/README.md`.

## Web app

`apps/web` (`@agent/web`) — Preact + Vite on the ui-kit: sign-in, the task composer, the task screen and settings.

```bash
bun run web:dev             # Vite on http://localhost:5173, /api proxied to the API on :3000
bun run web:build           # production build in apps/web/dist (docker/nginx/Dockerfile serves it)
bun run test:web            # component tests (happy-dom in its own process; part of test:unit)
bun run test:e2e:web        # Playwright: the real API and worker on ScriptedLlm (needs infra:up and Chromium)
```

The end-to-end test (`apps/web/e2e`, not part of `test` or `test:unit`) starts two servers itself: the backend
`packages/api/test/web-stack.ts` (API and worker in one process on the `*_test` database, scripted model, in-memory
sandbox, captured mail) on `127.0.0.1:5197` and Vite on `http://localhost:5199`. In Chromium it signs in with the
magic link, attaches a file (a real presigned PUT to Garage), runs a task, answers the agent's question and downloads
the result. It adds `http://localhost:5199` to the bucket CORS and on exit deletes its users (`@web-e2e.test.dev`,
tasks and files cascade), their S3 objects and its queue. Install the browser once: `bunx playwright install chromium`
(from `apps/web`).

Without Docker, start the API with the app's origin: Better Auth compares `Origin` with `BETTER_AUTH_URL`.

```bash
bun run s3:cors             # once per Garage volume: lets the browser PUT uploads into the bucket
NODE_ENV=development BETTER_AUTH_URL=http://localhost:5173 bun run api
bun run worker
bun run web:dev
```

- The app talks to the backend over HTTP only: it imports `@agent/shared` (schemas) and `@agent/ui` and nothing else
  from the monorepo (oxlint). It has no CSS of its own: layout and looks come from the ui-kit.
- The page CSP comes from the Vite dev server (`apps/web/csp.ts`): the inline theme script is allowed by its hash,
  connections go to the app, `S3_PUBLIC_ENDPOINT` and the HMR socket. Dev-server variables: `WEB_PORT`, `WEB_HOST`,
  `WEB_PUBLIC_ORIGIN` (the origin the browser sees), `S3_PUBLIC_ENDPOINT`, `API_PROXY_TARGET`, `VITE_CACHE_DIR`,
  `WEB_WATCH_POLL=1`. The production CSP is generated when the nginx image is built (`apps/web/nginx-csp.ts`: no
  `'unsafe-inline'`, the theme script hash from the same build); nginx fills in the S3 origin at start.
- Uploads go from the browser straight to S3. The bucket accepts PUT from the origins added by
  `bun run s3:cors [origin…]` (default: the `BETTER_AUTH_URL` origin and `http://localhost:5173`).
- The theme is stored in the profile (`PATCH /api/me`); `localStorage` only caches it for the first paint.

## Docker stack

```bash
bun run worker              # worker locally, on the infra from infra:up
bun run stack:up            # infra + migrate + s3-cors + worker + api + web + nginx (profile app); stack:down stops them
bun run stack:logs          # follow api, worker, web and nginx logs
```

The app is served on `http://localhost:8080` only (nginx): `/` goes to the web app (Vite dev server, HMR over
WebSocket through nginx, sources bind-mounted read-only), `/api/` to the API. The API and web containers are not
published; the API has no Docker access. It needs `BETTER_AUTH_SECRET` in `.env`.
Magic links show up in `bun run stack:logs` until a mail provider is configured (backlog).
Grant credits inside the stack: `docker compose -f docker/compose.yml --profile app exec api bun packages/api/src/admin-grant.ts <email> <credits>`.

`.env` for the stack: `BETTER_AUTH_SECRET` (API, `openssl rand -base64 32`) and the four `LITELLM_*` / `*_MODEL` values
(worker, below). Compose sets the in-network addresses itself (`DATABASE_URL`, `VALKEY_URL`, `S3_ENDPOINT`), plus
`BETTER_AUTH_URL=http://localhost:8080` and `S3_PUBLIC_ENDPOINT=http://localhost:53900` (the Garage port published by
`infra:up`, which the browser uses for presigned URLs). `NODE_ENV` is unset in the containers, so Better Auth rate limiting is on.

nginx overwrites `X-Real-IP` and `X-Forwarded-*` with its own values (clients cannot spoof the IP that rate limiting
counts), streams SSE unbuffered with a 1 h read timeout, rejects bodies over 1 MB with the API's JSON error
(files go straight to S3) and adds `nosniff`, `Referrer-Policy` and `X-Frame-Options` everywhere and a deny-all CSP
on `/api/` (the app's CSP comes from Vite).
`api`, `web` and `nginx` run as non-root users with a read-only root filesystem, no capabilities and `no-new-privileges`.
The sandbox isolation test (`packages/sandbox/test/docker-security.test.ts`) also probes port 8080 through every host
name and the `api` / `nginx` containers by IP; run it after `bun run stack:up` for the full check.

The worker needs the sandbox image (`bun run sandbox:build`) and `LITELLM_BASE_URL`, `LITELLM_API_KEY`,
`PLANNER_MODEL`, `EXECUTOR_MODEL` in `.env`: they are optional in the config schema (the API does without them),
but the worker creates the LiteLLM client at startup and refuses to start when any is missing.
In Docker the one-shot `migrate` service applies migrations before the worker and the API start. The worker runs as
the non-root `bun` user with a read-only root and reaches Docker only through `docker-proxy`
(`docker/docker-proxy.yml`, `wollomatic/socket-proxy`): it allows exactly the Docker API calls of the sandbox provider
and refuses host bind mounts, images, builds and system calls. The proxy does not inspect container settings
(privileged mode, host namespaces) — it narrows access but is not a boundary against a compromised worker: closed beta
only, production uses E2B (see `docs/beta-checklist.md`). On Linux set `DOCKER_GID` to the docker group of the host
(`getent group docker | cut -d: -f3`). `bun run backend:build` builds the `agent-backend:dev` image (target `worker`),
shared by `migrate`, `worker`, `api` and `s3-cors`; it carries no ui-kit dependencies.

Docker sandbox tests (`packages/sandbox`) need the image from `bun run sandbox:build`.
The sandbox isolation (non-root, no capabilities, own network, limits) is for development and the closed beta;
public launch requires E2B or gVisor (see `backlog.md`).

Sandbox network isolation:

- Sandboxes share the `agent-sandbox` bridge network, created with inter-container communication (ICC) off.
  An older `agent-sandbox` network with ICC on is recreated automatically when nothing is attached to it;
  if containers (even stopped ones) are still attached, sandbox creation fails with instructions to remove them
  and run `docker network rm agent-sandbox`.
- Host aliases (`host.docker.internal`, `host.orb.internal`, `host.internal`, `gateway.docker.internal`,
  `docker.for.mac.*`) resolve to the sandbox's own `127.0.0.1`.
- On every start the provider installs `ip rule … blackhole` rules inside the sandbox's network namespace
  for private, CGNAT, link-local and OrbStack ranges, the network gateway and the sandbox subnet itself.
  This is what actually blocks the host (OrbStack forwards `0.250.250.254` to the Mac's localhost),
  the infra containers (reachable by IP across Docker networks on OrbStack) and other sandboxes
  (OrbStack does not enforce ICC). Only the provider starts sandboxes; there is no Docker restart policy.
- This was verified on OrbStack (macOS) only: `bun --env-file=.env.test scripts/probe-sandbox-gateway.ts`
  must report `RESULT: host services are not reachable`. A Linux production host additionally needs
  `DOCKER-USER` egress rules that drop traffic from the sandbox network to the host gateway, the infra networks
  and `169.254.169.254` (cloud metadata).

## Production-like stack

`docker/compose.prod.yml` runs the closed beta on one host: Postgres and Valkey with passwords, Garage with secrets from
the environment, `migrate` and `s3-cors` once, the API (`agent-api:prod`), the worker (`agent-worker:prod`, non-root,
Docker through `docker-proxy`) and nginx (`agent-nginx:prod`) with the static web app and the production CSP. Only
loopback ports are published (`APP_PORT`, `GARAGE_PORT`): put a TLS reverse proxy of the host in front of them.
Every service gets an explicit list of variables from `.env.prod` (copy `.env.prod.example`); required ones stop
compose when missing.

```bash
bun run sandbox:build       # the sandbox image (SANDBOX_IMAGE, default agent-sandbox:dev)
bun run prod:up             # build and start, wait until nginx and the worker are up
bun run prod:logs
docker compose --env-file .env.prod -f docker/compose.prod.yml exec api bun packages/api/src/admin-grant.ts you@example.com 10
docker compose --env-file .env.prod -f docker/compose.prod.yml exec worker bun run admin:delete-user user@example.com
bun run prod:smoke --browser   # a throwaway copy on :58080 with one-off secrets: API, static app, CSP, logs, proxy, Chromium
```

`prod:smoke` never reads `.env` or `.env.prod`: it generates one-off secrets, runs as the compose project
`agent-prod-smoke` with its own volumes (ports 58080 and 53990) and removes the containers, networks and volumes at
the end, also on failure or Ctrl+C (`--keep` leaves the stack up and prints the `down -v` command).

The beta checklist and the runbook (backups, upgrades, restore, data deletion): `docs/beta-checklist.md`.

## API

```bash
NODE_ENV=development BETTER_AUTH_URL=http://localhost:3000 bun run api   # Hono API on 127.0.0.1:3000, on the infra from infra:up
```

In the Docker stack the browser reaches the API through nginx on `http://localhost:8080` (see Docker stack). Run outside
Docker, the browser talks to the API directly, so local runs set `BETTER_AUTH_URL=http://localhost:3000`
(the app's origin: sign-in callbacks, cookies and the CSRF check of mutating requests compare against it; with the
web app it is the Vite origin `http://localhost:5173`, see Web app) and `NODE_ENV=development`. The API reads from `.env`:

- `DATABASE_URL`, `VALKEY_URL`, `S3_*` (`S3_PUBLIC_ENDPOINT` — the S3 address the browser can reach);
- `BETTER_AUTH_SECRET` — required, at least 32 characters: `openssl rand -base64 32`;
- `BETTER_AUTH_URL` — the app's public origin (default `http://localhost:8080`, the stack's nginx);
- optional: `API_HOST`, `API_PORT`, `UPLOAD_MAX_BYTES`, `SSE_HEARTBEAT_MS` (≤ 120000), `SSE_MAX_STREAM_MS`,
  `GOOGLE_*` / `GITHUB_*`.

The API does not need `LITELLM_*` or the models; the worker refuses to start without them.

Sign-in methods:

- magic link — always on; without a mail provider the link is written to the API log (`mail not sent … logged instead`);
- Google / GitHub — on when both `*_CLIENT_ID` and `*_CLIENT_SECRET` are set; the OAuth callback URL is
  `<BETTER_AUTH_URL>/api/auth/callback/google` (or `/github`), `BETTER_AUTH_URL` defaults to `http://localhost:8080`.

Endpoints (spec section 10; request and response schemas: `packages/shared/src/api.ts`):

| Method      | Path                      |                                                                                                                                      |
| ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `*`         | `/api/auth/*`             | Better Auth                                                                                                                          |
| GET         | `/api/config`             | public: the configured OAuth providers and the upload limit                                                                          |
| GET / PATCH | `/api/me`                 | profile with the theme and balance (`millicredits`, `credits` as a string) / save the theme (`dark`, `light`, `auto`)                |
| POST        | `/api/uploads`            | declare an input file → presigned PUT for exactly `size` bytes (≤ `UPLOAD_MAX_BYTES`)                                                |
| POST / GET  | `/api/tasks`              | create (`{ prompt, fileIds }`) / list (`?limit=`, `?before=<nextCursor>`)                                                            |
| GET         | `/api/tasks/:id`          | task, subtasks, files                                                                                                                |
| GET         | `/api/tasks/:id/events`   | SSE: `step` events (`id` = seq, resume with `Last-Event-ID` or `?after=`), `: ping`, final `end`; `stream_error` on a server failure |
| POST        | `/api/tasks/:id/messages` | answer the agent's question (task in `waiting_user`); optional `questionSeq` — the pause answered, 409 if the agent asked again      |
| POST        | `/api/tasks/:id/cancel`   | cancel                                                                                                                               |
| GET         | `/api/files/:id`          | redirect to a presigned download (always as an attachment)                                                                           |

A stream lives at most `SSE_MAX_STREAM_MS` (15 min): it then closes without `end`, and EventSource reconnects with
`Last-Event-ID`, passing the session check again.

Errors are `{ "error": { "code", "message" } }`; `/api/auth/*` answers in Better Auth's own `{ "message", "code" }`.
Presigned URLs use `S3_PUBLIC_ENDPOINT` — the S3 address the browser can reach.

Local runs use `NODE_ENV=development`. Any other value, unset included, counts as production: Better Auth rate limiting
is on and the API warns at startup while magic links still go to the log. Origin and CSRF checks are on everywhere.
The Better Auth integration tests (`packages/api/test/integration`) run on Postgres from `infra:up`
and are not part of `test:unit`.

Credits are granted by hand during the beta (the user must have signed in once):

```bash
bun run admin:grant someone@example.com 10        # 10 credits = 10000 millicredits; up to 3 decimals
```

In the Docker stack run it inside the `api` container (see Docker stack).
