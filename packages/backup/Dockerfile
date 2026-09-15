# Build context is the repo root (a pnpm workspace) — see docker-compose.yml.
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @logikos-dsp/shared build
RUN pnpm --filter @logikos-dsp/backup build
RUN pnpm --filter @logikos-dsp/backup --prod deploy /app

# Runtime is postgres:16-alpine, not node:*-slim like the other services: the
# tools this worker drives have to match the server. pg_dump refuses to dump a
# server newer than itself, and this image is the one guaranteed source of the
# same major version as the compose Postgres. rclone (uploads to S3/SFTP/Drive)
# and age (encryption) come from Alpine's packages. The worker's own
# dependencies (pg) are pure JavaScript, so node_modules built on Debian run
# unchanged on musl.
FROM postgres:16-alpine AS runtime
RUN apk add --no-cache nodejs rclone age tar
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
ENTRYPOINT ["node", "dist/index.js"]
