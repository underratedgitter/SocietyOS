# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/device-simulator/package.json apps/device-simulator/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY apps/api/prisma apps/api/prisma
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
RUN pnpm --filter @societyos/api exec prisma generate \
  && pnpm --filter @societyos/api build

FROM node:22-alpine AS runner
RUN apk add --no-cache openssl \
  && addgroup -S societyos \
  && adduser -S societyos -G societyos
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder --chown=societyos:societyos /app/package.json ./package.json
COPY --from=builder --chown=societyos:societyos /app/node_modules ./node_modules
COPY --from=builder --chown=societyos:societyos /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder --chown=societyos:societyos /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder --chown=societyos:societyos /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=societyos:societyos /app/apps/api/prisma ./apps/api/prisma

USER societyos
WORKDIR /app/apps/api
EXPOSE 4000

# Migrations are idempotent and run once per container start before serving.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/main.js"]
