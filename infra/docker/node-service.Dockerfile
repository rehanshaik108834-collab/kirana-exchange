# syntax=docker/dockerfile:1.7
# Shared multi-stage, pinned, non-root Dockerfile for all Kirana Exchange NestJS services.

ARG SERVICE_NAME
ARG SERVICE_PKG
ARG SERVICE_PORT=3001
ARG HEALTH_PATH=/health

FROM node:22.14.0-alpine3.21 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.2.2 --activate
WORKDIR /app

FROM base AS builder
ARG SERVICE_NAME
ARG SERVICE_PKG
RUN apk add --no-cache python3 make g++

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY libs/common/package.json ./libs/common/package.json
COPY apps/api-gateway/package.json ./apps/api-gateway/package.json
COPY apps/auth-service/package.json ./apps/auth-service/package.json
COPY apps/shop-service/package.json ./apps/shop-service/package.json
COPY apps/catalog-service/package.json ./apps/catalog-service/package.json
COPY apps/inventory-service/package.json ./apps/inventory-service/package.json
COPY apps/swap-service/package.json ./apps/swap-service/package.json
COPY apps/saga-orchestrator/package.json ./apps/saga-orchestrator/package.json
COPY apps/groupbuy-service/package.json ./apps/groupbuy-service/package.json
COPY apps/notification-service/package.json ./apps/notification-service/package.json

RUN pnpm install --frozen-lockfile --filter "${SERVICE_PKG}..."

COPY libs/common ./libs/common
COPY apps/${SERVICE_NAME} ./apps/${SERVICE_NAME}

RUN pnpm --filter @kirana/common build \
  && pnpm --filter "${SERVICE_PKG}" build

FROM base AS prod-deps
ARG SERVICE_NAME
ARG SERVICE_PKG
RUN apk add --no-cache python3 make g++

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY libs/common/package.json ./libs/common/package.json
COPY apps/${SERVICE_NAME}/package.json ./apps/${SERVICE_NAME}/package.json

RUN pnpm install --prod --frozen-lockfile --filter "${SERVICE_PKG}..."

FROM node:22.14.0-alpine3.21 AS runner
ARG SERVICE_NAME
ARG SERVICE_PORT=3001
ARG HEALTH_PATH=/health

ENV NODE_ENV=production
ENV PORT=${SERVICE_PORT}
ENV HEALTH_PATH=${HEALTH_PATH}
WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/libs/common ./libs/common
COPY --from=prod-deps --chown=node:node /app/apps/${SERVICE_NAME} ./apps/${SERVICE_NAME}
COPY --from=builder --chown=node:node /app/libs/common/dist ./libs/common/dist
COPY --from=builder --chown=node:node /app/apps/${SERVICE_NAME}/dist ./apps/${SERVICE_NAME}/dist

WORKDIR /app/apps/${SERVICE_NAME}
USER node
EXPOSE ${SERVICE_PORT}

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3001')+(process.env.HEALTH_PATH||'/health')).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
