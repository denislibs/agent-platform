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

## UI kit

```bash
bun run ui:dev              # component showcase on http://localhost:5174
bun run ui:build            # static showcase build in packages/ui/showcase/dist
bun run test:ui             # ui-kit tests (happy-dom in its own process; part of test:unit)
```

`packages/ui` (`@agent/ui`) is the design system: tokens, `ui-*` styles, Preact components and agent patterns.
Usage, themes and the component list: `packages/ui/README.md`.

## Docker stack

```bash
bun run worker              # worker locally, on the infra from infra:up
bun run stack:up            # infra + migrate + worker + api + nginx (profile app); stack:down stops them
bun run stack:logs          # follow api, worker and nginx logs
```

The app is served on `http://localhost:8080` only (nginx): `/api/` goes to the API, `/` is a placeholder until the web app.
The API container is not published and has no Docker access. It needs `BETTER_AUTH_SECRET` in `.env`.
Magic links show up in `bun run stack:logs` until a mail provider is configured (backlog).
Grant credits inside the stack: `docker compose -f docker/compose.yml --profile app exec api bun packages/api/src/admin-grant.ts <email> <credits>`.

`.env` for the stack: `BETTER_AUTH_SECRET` (API, `openssl rand -base64 32`) and the four `LITELLM_*` / `*_MODEL` values
(worker, below). Compose sets the in-network addresses itself (`DATABASE_URL`, `VALKEY_URL`, `S3_ENDPOINT`), plus
`BETTER_AUTH_URL=http://localhost:8080` and `S3_PUBLIC_ENDPOINT=http://localhost:53900` (the Garage port published by
`infra:up`, which the browser uses for presigned URLs). `NODE_ENV` is unset in the containers, so Better Auth rate limiting is on.

nginx overwrites `X-Real-IP` and `X-Forwarded-*` with its own values (clients cannot spoof the IP that rate limiting
counts), streams SSE unbuffered with a 1 h read timeout, rejects bodies over 1 MB with the API's JSON error
(files go straight to S3) and adds `nosniff`, `Referrer-Policy`, `X-Frame-Options` and a deny-all CSP for the placeholder.
`api` and `nginx` run as non-root users with a read-only root filesystem, no capabilities and `no-new-privileges`.
The sandbox isolation test (`packages/sandbox/test/docker-security.test.ts`) also probes port 8080 through every host
name and the `api` / `nginx` containers by IP; run it after `bun run stack:up` for the full check.

The worker needs the sandbox image (`bun run sandbox:build`) and `LITELLM_BASE_URL`, `LITELLM_API_KEY`,
`PLANNER_MODEL`, `EXECUTOR_MODEL` in `.env`: they are optional in the config schema (the API does without them),
but the worker creates the LiteLLM client at startup and refuses to start when any is missing.
In Docker the one-shot `migrate` service applies migrations before the worker and the API start; the worker manages
sandboxes through the host `/var/run/docker.sock` (root-equivalent on the host: development and closed beta only,
production uses E2B). `bun run backend:build` builds only the `agent-backend:dev` image, shared by `migrate`, `worker` and `api`.

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

## API

```bash
NODE_ENV=development BETTER_AUTH_URL=http://localhost:3000 bun run api   # Hono API on 127.0.0.1:3000, on the infra from infra:up
```

In the Docker stack the browser reaches the API through nginx on `http://localhost:8080` (see Docker stack). Run outside
Docker, the browser talks to the API directly, so local runs set `BETTER_AUTH_URL=http://localhost:3000`
(the app's origin: sign-in callbacks, cookies and the CSRF check of mutating requests compare against it) and
`NODE_ENV=development`. The API reads from `.env`:

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

| Method     | Path                      |                                                                                                                                      |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `*`        | `/api/auth/*`             | Better Auth                                                                                                                          |
| GET        | `/api/me`                 | profile and balance (`millicredits`, `credits` as a string)                                                                          |
| POST       | `/api/uploads`            | declare an input file → presigned PUT for exactly `size` bytes (≤ `UPLOAD_MAX_BYTES`)                                                |
| POST / GET | `/api/tasks`              | create (`{ prompt, fileIds }`) / list (`?limit=`, `?before=<nextCursor>`)                                                            |
| GET        | `/api/tasks/:id`          | task, subtasks, files                                                                                                                |
| GET        | `/api/tasks/:id/events`   | SSE: `step` events (`id` = seq, resume with `Last-Event-ID` or `?after=`), `: ping`, final `end`; `stream_error` on a server failure |
| POST       | `/api/tasks/:id/messages` | answer the agent's question (task in `waiting_user`)                                                                                 |
| POST       | `/api/tasks/:id/cancel`   | cancel                                                                                                                               |
| GET        | `/api/files/:id`          | redirect to a presigned download (always as an attachment)                                                                           |

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
