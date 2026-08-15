# Build context is the repo root (a pnpm workspace) — see docker-compose.yml
# and .dockerignore. node:24-bookworm-slim, not alpine: @logikos-dsp/shared's
# main field points at compiled dist/ (see ARCHITECTURE.md's "Production
# packaging" note for why), and glibc (not Alpine's musl) matches every other
# service image in this project for consistency.
FROM node:24-bookworm-slim AS build
# Prisma's engine downloader needs to detect the real OpenSSL version to
# fetch the matching query engine binary — without this it warns and
# guesses (wrong, for bookworm's OpenSSL 3.x), which fails at runtime, not
# build time. Same package installed in the runtime stage below.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# `pnpm install` at the workspace root runs @prisma/client's postinstall
# from a working directory where it can't find packages/backend/prisma —
# it warns and skips rather than failing, silently leaving the client
# ungenerated (and every Prisma-typed query as `any`, breaking `tsc`).
# Running it explicitly, scoped to the package that owns the schema, fixes
# both.
RUN pnpm --filter @logikos-dsp/backend exec prisma generate
RUN pnpm --filter @logikos-dsp/shared build
RUN pnpm --filter @logikos-dsp/backend build
RUN pnpm --filter @logikos-dsp/backend --prod deploy /app
# `pnpm deploy` builds /app as its own independent node_modules tree — it
# does NOT inherit the generated Prisma Client from the `generate` above,
# because "generate" isn't part of @prisma/client's package contents, it's
# code written into a specific already-installed instance's node_modules
# after the fact. The deployed instance is a fresh install with no
# generated code, so it fails at runtime with "does not provide an export
# named 'PrismaClient'" even though the build above succeeded. Regenerate
# against the actual deployed tree.
RUN /app/node_modules/.bin/prisma generate --schema /app/prisma/schema.prisma

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://localhost:4000/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# prisma migrate deploy is non-interactive and idempotent — safe to run on
# every container start. There's no persistent interactive session in a
# container the way there is in dev, so this replaces the explicit separate
# `pnpm db:migrate` step used there. See ARCHITECTURE.md.
ENTRYPOINT ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/index.js"]
