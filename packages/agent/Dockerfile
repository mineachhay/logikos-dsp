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
# pypsrp does PowerShell Remoting (PSRP), which is what a non-administrator in
# Remote Management Users is allowed to use — the plain WinRM shell that
# python3-winrm drives needs Execute on the service SDDL, which only admins
# have, so a read-only service account got "Access is denied" there. Debian
# doesn't package pypsrp; pinned, and python3-winrm still provides the NTLM
# transport underneath.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-winrm python3-pip \
 && pip install --break-system-packages --no-cache-dir "pypsrp==0.9.1" \
 && apt-get purge -y python3-pip && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
# NTLM hashes passwords with MD4, which OpenSSL 3 moved to its legacy provider,
# so Python's hashlib refuses it ("unsupported hash type md4") and every WinRM
# login fails. Node has the same problem with SMB and solves it with
# NODE_OPTIONS=--openssl-legacy-provider; Python needs this config file, passed
# to the collector subprocess only (activityCollector.ts).
RUN printf '%s\n' \
  'openssl_conf = openssl_init' \
  '[openssl_init]' \
  'providers = provider_sect' \
  '[provider_sect]' \
  'default = default_sect' \
  'legacy = legacy_sect' \
  '[default_sect]' \
  'activate = 1' \
  '[legacy_sect]' \
  'activate = 1' \
  > /etc/ssl/openssl-legacy.cnf
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
