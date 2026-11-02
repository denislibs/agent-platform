# Образ бэкенда: один Dockerfile, две цели (dev-compose собирает worker, продакшен — обе).
#   app    — API, миграции (migrate) и CORS бакета (s3-cors); без docker CLI.
#   worker — app + docker CLI: песочницы через прокси Docker API (docker/docker-proxy.yml), не через docker.sock.
# Зависимости — только пакетов бэкенда: packages/ui (ui-kit веб-приложения, ~35 МБ) удаляется до установки,
# apps/ и evals/ не копируются. bun install --frozen-lockfile пропускает workspace из bun.lock, которых нет на диске.
FROM oven/bun:1.4.2-debian AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages ./packages
RUN rm -rf packages/ui && bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-debian AS app
WORKDIR /app
COPY --from=deps /app ./
USER bun
# Exec-форма: bun — PID 1 и сам получает SIGTERM. migrate и s3-cors задают свою команду в compose.
CMD ["bun", "packages/api/src/main.ts"]

FROM app AS worker
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli \
 && apt-get purge -y gnupg \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
# Не root: docker CLI ходит в Docker по TCP через прокси (DOCKER_HOST), сокет хоста ему не нужен.
USER bun
CMD ["bun", "packages/worker/src/main.ts"]
