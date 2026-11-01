FROM oven/bun:1.4.2-debian

# docker CLI — воркер управляет песочницами через docker.sock хоста (разработка и закрытая бета).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile --production

# Exec-форма: bun — PID 1 и сам получает SIGTERM. Миграции — отдельный сервис migrate в compose.
CMD ["bun", "packages/worker/src/main.ts"]
