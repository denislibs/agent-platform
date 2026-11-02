# Веб-приложение в разработке: Vite dev server с HMR за nginx (план 6). Продакшен — статика в nginx (план 7).
FROM oven/bun:1.4.2-debian

WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
# С dev-зависимостями: Vite и плагин Preact нужны dev-серверу.
RUN bun install --frozen-lockfile

USER bun
EXPOSE 5173
# Исходники приходят bind-mount'ом (compose), Vite следит за ними и шлёт HMR.
CMD ["bun", "run", "--cwd", "apps/web", "dev"]
