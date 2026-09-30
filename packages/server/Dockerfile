# The Yuzie server image (SPEC.md §18 Session 17), published as
# ghcr.io/apurvchoudhary18/yuzie-server. Build from the repository root:
#
#   docker build -f packages/server/Dockerfile -t yuzie-server .
#
# Runs as an unprivileged user, applies migrations on start, and answers
# GET /healthz. Configuration is environment variables only: see docs/self-hosting.md.

FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @yuzie/server... --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/server packages/server
RUN pnpm --filter @yuzie/server... build \
 && pnpm --filter @yuzie/server deploy --legacy --prod --no-optional /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "-e", "import('./dist/index.js').then((server) => server.start())"]
