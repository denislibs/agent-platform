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
bun run db:migrate
bun test                    # all tests (needs infra)
bun run test:unit           # fast tests, no Docker needed
```
