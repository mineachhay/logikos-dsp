# Build context is the repo root (a pnpm workspace) — see docker-compose.yml
# and .dockerignore. No shared-package build step: the dashboard doesn't
# depend on @logikos-dsp/shared.
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# Vite inlines import.meta.env.* into the JS bundle at build time — it's
# not runtime-configurable the way a server's env vars are. The backend
# URL must therefore be reachable from wherever the *browser* runs, not
# from inside the Docker network (http://backend:4000 would only resolve
# to other containers on the compose network, not to a browser on the
# host) — pass the real externally-reachable URL for this deployment as a
# build arg. Defaults to localhost:4000, matching a single-host deployment
# where the backend's port is published to the host.
ARG VITE_BACKEND_URL=http://localhost:4000
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
RUN pnpm --filter @logikos-dsp/dashboard build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/packages/dashboard/dist /usr/share/nginx/html
# Cache headers: index.html revalidated every load, hashed assets cached for good.
COPY packages/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
