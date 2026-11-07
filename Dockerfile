# UNIVERSAL FLOW AI: API, worker, scheduler and the web app in one container.
# Build: docker build -t universal-flow-ai .
# Run:   docker run -p 8080:8080 -e DATABASE_URL=... -e MASTER_KEY=... -e PUBLIC_BASE_URL=... universal-flow-ai

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CI=true
RUN corepack enable
COPY . .
RUN pnpm install --no-frozen-lockfile
# Workspace packages build in dependency order: core-engine, then backend and web.
RUN pnpm -r run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    ROLE=all \
    AUTO_MIGRATE=true \
    WEB_DIST_DIR=/app/apps/web/dist
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "apps/backend/dist/src/main.js"]
