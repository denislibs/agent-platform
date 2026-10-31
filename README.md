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
cp .env.example .env        # fill LITELLM_BASE_URL and LITELLM_API_KEY
bun run infra:up && bun run infra:wait
bun run sandbox:build       # agent sandbox image (Chromium + Python + Node), takes a few minutes
bun run db:migrate
bun test                    # all tests (needs infra)
bun run test:unit           # fast tests, no Docker needed
```

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
