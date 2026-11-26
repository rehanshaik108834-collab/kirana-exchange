# syntax=docker/dockerfile:1.7
# Multi-stage React PWA build served by unprivileged Nginx reverse proxy (non-root UID 101).

FROM node:22.14.0-alpine3.21 AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.2.2 --activate
WORKDIR /app

ARG VITE_API_BASE_URL=/v1
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web-app/package.json ./apps/web-app/package.json

RUN pnpm install --frozen-lockfile --filter @kirana/web-app

COPY apps/web-app ./apps/web-app
RUN pnpm --filter @kirana/web-app build

FROM nginxinc/nginx-unprivileged:1.27.4-alpine AS runner

COPY --chown=101:101 infra/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=builder --chown=101:101 /app/apps/web-app/dist /usr/share/nginx/html

USER 101
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
