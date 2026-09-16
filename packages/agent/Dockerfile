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
# python3-winrm (pywinrm, the client Ansible uses) for reading Windows Security
# logs over WinRM — NTLM with message encryption has no maintained Node client.
# Debian's package, not pip, so the image stays reproducible.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-winrm \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# `pnpm deploy` copies only the package's "files" (dist), so the collector
# script is copied explicitly; activityCollector.ts resolves it relative to dist.
COPY packages/agent/winrm/collect.py /app/winrm/collect.py
# No HTTP port — this is a background watcher, not a server. No
# HEALTHCHECK either: there's no meaningful check beyond "is the process
# alive," which Docker already tracks via the container's exit status.
ENTRYPOINT ["node", "dist/index.js"]
