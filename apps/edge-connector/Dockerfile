# Build context: repository root.  docker build -f apps/edge-connector/Dockerfile -t societyos-edge .
FROM node:24-slim
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/edge-connector/package.json apps/edge-connector/
RUN pnpm install --frozen-lockfile --filter @societyos/edge-connector...
COPY apps/edge-connector apps/edge-connector
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV EDGE_CONFIG=/data/edge.json
WORKDIR /app/apps/edge-connector
VOLUME ["/data"]
CMD ["node_modules/.bin/tsx", "src/index.ts"]
