# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

ENV NODE_ENV=production
RUN corepack enable
WORKDIR /app

# Dependencies first, so code changes do not invalidate the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/engine/package.json packages/engine/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --prod

COPY tsconfig.json ./
COPY packages ./packages

RUN mkdir -p /data && chown node:node /data
USER node

ENV HOST=0.0.0.0 \
    PORT=7341 \
    TERRARIUM_DB=/data/terrarium.db
EXPOSE 7341
VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:7341/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Run from the server package so its own dependencies (tsx) resolve.
WORKDIR /app/packages/server
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "src/main.ts"]
