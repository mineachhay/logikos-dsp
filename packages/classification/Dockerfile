# Build context is the repo root (a pnpm workspace) — see docker-compose.yml
# and .dockerignore.
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
# Installs @huggingface/transformers' onnxruntime-node dependency, whose
# postinstall downloads native runtime binaries (~150MB, includes an
# unused CUDA provider .so — no way to skip it short of patching the
# dependency) — this step is the slow one, budget ~1-2 minutes.
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @logikos-dsp/shared build
RUN pnpm --filter @logikos-dsp/classification build
RUN pnpm --filter @logikos-dsp/classification --prod deploy /app

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# The NER model (~100MB, Xenova/bert-base-NER) downloads to ./.cache on
# first run (env.cacheDir in src/ner.ts resolves one level up from
# wherever the running file lives — /app/dist/ner.js here, so /app/.cache).
# Deliberately not baked into the image (kept out of the build context by
# .dockerignore's **/.cache — see there for why): mount a volume at this
# path (see docker-compose.yml's classification_cache) so it downloads once
# and survives container recreation instead of re-fetching every restart.
VOLUME /app/.cache
ENTRYPOINT ["node", "dist/index.js"]
