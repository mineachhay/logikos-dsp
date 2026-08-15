# Build context is the repo root (a pnpm workspace) — see docker-compose.yml
# and .dockerignore. Mirrors packages/backend/Dockerfile's shape; no OpenSSL
# or other native-dep setup needed here — agent's only non-pure-JS
# dependency risk (v9u-smb2) has none (it's ntlm2 + readable-stream, both
# pure JS).
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @logikos-dsp/shared build
RUN pnpm --filter @logikos-dsp/agent build
RUN pnpm --filter @logikos-dsp/agent --prod deploy /app

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# No HTTP port — this is a background watcher, not a server. No
# HEALTHCHECK either: there's no meaningful check beyond "is the process
# alive," which Docker already tracks via the container's exit status.
ENTRYPOINT ["node", "dist/index.js"]
