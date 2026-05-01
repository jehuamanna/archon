# syntax=docker/dockerfile:1.7
#
# Unified build for the Archon Docker stack.
# - `deps`      shared workspace install + mdx-sdk compile
# - `web-build` Next.js build + dev-dep prune for the web image
# - `web`       runtime stage for `npm run deploy:web` (port 3000)
# - `sync-api`  runtime stage for the Fastify sync API (port 4010)

# ---------- shared deps + mdx-sdk build ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# CI/agents often see transient registry errors (e.g. ECONNRESET); npm retries reduce flake.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY src ./src
COPY docs/bundled-plugin-authoring ./docs/bundled-plugin-authoring

# Install ALL workspace deps (no `-w` filter) so the TypeScript build
# tooling required by `@nodex-studio/mdx-sdk` is present. `--ignore-scripts`
# keeps the install side-effect-free; the mdx-sdk build runs explicitly
# below. The cache mount persists `~/.npm` across builds.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts

# `@nodex-studio/mdx-sdk` declares `main: ./dist/index.js`. The repo-root
# `.dockerignore` excludes `dist/` and `--ignore-scripts` skipped its
# `prepare` hook, so the compiled output isn't in the image yet — build
# it here before either runtime boots and tries to import it.
RUN npm run build -w @nodex-studio/mdx-sdk

# ---------- web build (Next.js + prune) ----------
FROM deps AS web-build

ARG NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN=0
ARG NEXT_PUBLIC_ARCHON_WPN_USE_SYNC_API=1
ARG NEXT_PUBLIC_ARCHON_WEB_BACKEND=sync-only
# Public sync API base (no trailing slash). Match gateway origin + `/api/v1` (default :8080).
ARG NEXT_PUBLIC_ARCHON_SYNC_API_URL=http://127.0.0.1:8080/api/v1
ENV NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN=${NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN} \
    NEXT_PUBLIC_ARCHON_WPN_USE_SYNC_API=${NEXT_PUBLIC_ARCHON_WPN_USE_SYNC_API} \
    NEXT_PUBLIC_ARCHON_WEB_BACKEND=${NEXT_PUBLIC_ARCHON_WEB_BACKEND} \
    NEXT_PUBLIC_ARCHON_SYNC_API_URL=${NEXT_PUBLIC_ARCHON_SYNC_API_URL}

RUN --mount=type=cache,target=/app/apps/archon-web/.next/cache,sharing=locked \
    npm run build -w @archon/web
RUN npm prune --omit=dev

# ---------- web runtime ----------
FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production
COPY --from=web-build /app /app
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@archon/web"]

# ---------- sync-api runtime ----------
FROM deps AS sync-api
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4010 \
    ARCHON_BUNDLED_DOCS_DIR=/app/docs/bundled-plugin-authoring
EXPOSE 4010
CMD ["npm", "run", "start", "-w", "@archon/sync-api"]
