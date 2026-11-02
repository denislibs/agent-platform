# Продакшен-вариант фронта (docker/compose.prod.yml): статика веб-приложения и reverse proxy в одном образе nginx.
FROM oven/bun:1.4.2-debian AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
# С dev-зависимостями: Vite и плагин Preact нужны сборке; в итоговый образ попадает только dist.
RUN bun install --frozen-lockfile
RUN bun run --cwd apps/web build \
 && bun apps/web/nginx-csp.ts > /csp.conf.template

FROM nginxinc/nginx-unprivileged:1.28-alpine
# Шаблоны → /tmp/nginx/*.conf при старте (корень только для чтения); подставляются только эти две переменные.
# S3_PUBLIC_ORIGIN выводит из S3_PUBLIC_ENDPOINT 18-s3-public-origin.envsh (до envsubst; неверный адрес — отказ старта).
ENV NGINX_ENVSUBST_OUTPUT_DIR=/tmp \
    NGINX_ENVSUBST_FILTER='^(APP_HOST|S3_PUBLIC_ORIGIN)$'
COPY --chmod=755 docker/nginx/prod/s3-public-origin.envsh /docker-entrypoint.d/18-s3-public-origin.envsh
COPY docker/nginx/prod/nginx.conf /etc/nginx/nginx.conf
COPY docker/nginx/prod/headers.conf /etc/nginx/snippets/headers.conf
COPY docker/nginx/prod/app.conf.template /etc/nginx/templates/nginx/app.conf.template
COPY --from=build /csp.conf.template /etc/nginx/templates/nginx/csp.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
