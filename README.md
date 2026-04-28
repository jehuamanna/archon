# Archon

A programmable knowledge system that unifies notes, code, and data into a single workspace. Archon ships as an Electron desktop app, a Next.js web client, and a Fastify + Postgres sync API — all driven by a pluggable plugin runtime and exposed to AI assistants via the Model Context Protocol (MCP).

**Status:** experimental / proof of concept (`v0.0.0-experimental.5`).

**License:** MIT

---

## Table of Contents

- [What is Archon?](#what-is-archon)
- [Repository Layout](#repository-layout)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Running the Stack](#running-the-stack)
- [Environment Configuration](#environment-configuration)
- [Testing](#testing)
- [Packaging Desktop Builds](#packaging-desktop-builds)
- [Docker & Deployment](#docker--deployment)
- [Plugins](#plugins)
- [MCP Integration](#mcp-integration)
- [Contributing](#contributing)

---

## What is Archon?

Archon is a workspace where every artifact — a note, a document, a script, a dataset, a view — is a **node** governed by the same plugin system. The runtime treats user content as addressable, programmable objects so that:

- Notes can be edited as Markdown/MDX **or** executed as reactive JavaScript notebooks.
- Plugins extend the shell with commands, side panels, editors, and background tools.
- An MCP server exposes the workspace to AI assistants (Claude Desktop, Cursor, and any MCP-compatible client) so that agents can read, write, and reorganize nodes on your behalf.
- The same data layer powers the desktop app (local file vault + optional RxDB mirror) and the web app (synced through the Fastify API).

The short version: a scriptable, AI-native, plugin-first note taking and knowledge management system.

---

## Repository Layout

This is an npm **workspaces** monorepo.

```
apps/
  archon-web/            Next.js web client (App Router, React 19)
  archon-sync-api/       Fastify + Postgres sync API (auth, workspaces, notes, assets)
packages/
  archon-platform/       Platform ports: RemoteApi, LocalStore, DesktopHost
  archon-mcp/            MCP server (stdio / SSE / Streamable HTTP) — @archon-studio/mcp
  archon-plugin-ui/      Plugin-facing UI SDK (panels, commands, editor surfaces)
  archon-shell-ui/       Host shell UI primitives (layout, chrome, navigation)
plugins/
  system/               First-party bundled plugins (e.g. `code`)
  user/                 User-authored plugins live here at runtime
src/
  main/                 Electron main process (IPC, vault, plugin loader, windowing)
  renderer/             Electron renderer (React, Redux, Monaco, CodeMirror)
  preload.ts            Context-isolated preload bridge
  core/                 Cross-target logic: notes store, plugin runtime, WPN model
  shared/               Code shared between main, renderer, web, and sync-api
deploy/                 nginx, systemd, Jenkins, Drone, git-server configs
e2e/                    Playwright end-to-end tests
scripts/                Build, install, deploy, and dev-tooling scripts
```

Top-level Electron Forge config lives in `forge.config.js`; webpack configs under `webpack.*.js`.

---

## Tech Stack

**Desktop:** Electron 41, Electron Forge 7, React 19, Redux Toolkit, Monaco Editor, CodeMirror 6.

**Web:** Next.js (App Router), React 19, Tailwind CSS 4, RxDB, Dexie (IndexedDB).

**Backend:** Fastify 5, Postgres 16, Drizzle ORM, JWT auth, AWS S3 (optional asset storage), Multer/multipart uploads.

**AI/Agents:** Model Context Protocol SDK (`@modelcontextprotocol/sdk`), stdio + SSE + Streamable HTTP transports.

**Content & Execution:** MDX 3, `@observablehq/runtime` for reactive notebooks, SES (secure EcmaScript) for plugin sandboxing, Babel standalone for in-browser compilation, `@babel/standalone` + esbuild for plugin bundling.

**Tooling:** TypeScript 5.9, ESLint 10, Playwright, Rollup, tsx.

---

## Prerequisites

- **Node.js** 20+ (22 LTS recommended).
- **npm** 10+.
- **Postgres** 14+ running locally, or a hosted Postgres connection string. The sync API needs it; pure desktop mode does not.
- **Python**, **make**, a **C/C++ toolchain** — required by `electron-rebuild` for native modules (`bcrypt`, etc.). On Debian/Ubuntu: `sudo apt install build-essential python3`.
- **Docker** + Docker Compose (optional) — for the containerized stack, local Postgres, and CI.

On Linux, Electron also needs a few system libraries (`libnss3`, `libgbm1`, `libasound2`, …). The `scripts/install-linux-deb.js` helper can install the packaged `.deb` with dependencies resolved.

---

## Quick Start

```bash
# 1. Clone and install (root + workspaces)
npm install

# 2. Copy the example env and edit as needed
cp .env.example .env

# 3. Start the pieces you want (each in its own terminal)
npm run sync-api       # Fastify API on :4010 (needs Postgres reachable)
npm run dev:web        # Next.js web client on :3000
npm start              # Electron desktop shell (loads the web client in dev)
```

The first `npm install` triggers `electron-rebuild` via `scripts/npm-postinstall.js`. To skip that (faster, web-only workflow):

```bash
ARCHON_SKIP_ELECTRON_REBUILD=1 npm install
# or
npm run install:web
```

Rebuild native modules later with `npm run rebuild:electron`.

---

## Running the Stack

### Sync API (`@archon/sync-api`)

```bash
npm run sync-api                 # dev mode, reads DATABASE_URL from .env
npm run sync-api:local           # forces DATABASE_URL=postgres://archon:archon@localhost:5432/archon_sync
npm run sync-api:start           # production-style start (NODE_ENV=production)
```

Defaults: `PORT=4010`, `HOST=0.0.0.0`, DB name `archon_sync`. In dev CORS is permissive so the Next client on `:3000` can reach it.

### Web Client (`@archon/web`)

```bash
npm run dev:web                  # Next dev server on :3000
npm run build:web:static         # Static export (for gateway deploys)
```

The dev script auto-syncs iframe tokens, video.js styles, and sets
`NEXT_PUBLIC_ARCHON_WPN_USE_SYNC_API=1` + `NEXT_PUBLIC_ARCHON_WEB_BACKEND=sync-only`
so the client talks to the sync API instead of using an in-browser-only store.

### Electron Desktop Shell

```bash
npm start                        # alias for `npm run electron`
npm run electron                 # electron-forge start (ELECTRON_DISABLE_SANDBOX=1)
```

In dev, Electron loads the Next app from `ARCHON_WEB_DEV_URL` (default `http://127.0.0.1:3000`), so run `npm run dev:web` first or alongside it.

### MCP Server (`@archon-studio/mcp`)

Binaries exposed by `packages/archon-mcp`:

```bash
npx archon-mcp                    # stdio transport (Claude Desktop, Cursor)
npx archon-mcp-http               # Streamable HTTP / SSE transport
```

See `packages/archon-mcp/src/cli.ts` for flags and auth modes (cloud sync-api vs Electron loopback).

---

## Environment Configuration

Copy `.env.example` → `.env` at the repo root. The same file is read by Docker Compose, the Next client (in dev), and the sync API. Don't commit `.env`.

Key variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. Default: `postgres://archon:archon@localhost:5432/archon_sync` |
| `JWT_SECRET` | Signing key. **Minimum 32 chars in production** |
| `PORT` / `HOST` | Sync API listener. Defaults: `4010` / `0.0.0.0` |
| `CORS_ORIGIN` | Sync API CORS. `true` = permissive (dev only) |
| `NEXT_PUBLIC_ARCHON_SYNC_API_URL` | Override the sync base the web client targets |
| `NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN` | `1` to route through a same-origin nginx gateway |
| `ARCHON_WEB_DEV_URL` | URL the Electron shell loads in dev (default `http://127.0.0.1:3000`) |
| `ARCHON_LOCAL_RXDB_WPN` | Enable local RxDB mirror in the Electron renderer |
| `ARCHON_WORKSPACE_RXDB_AUTHORITY` | Treat renderer RxDB as the persistence authority |
| `ARCHON_SKIP_ELECTRON_REBUILD` | Skip native rebuild during `npm install` |

See `.env.example` for the full list, including S3 asset storage, gateway ports, and Drone/Jenkins deploy keys.

---

## Testing

```bash
npm test                         # node unit tests + shared utilities + sync-api tests
npm run test:node-unit           # repo-wide node:test runner
npm run test:vfs-link-rewrite    # VFS link rewrite unit tests
npm run test:legacy-wpn-migrate  # legacy → WPN migration tests
npm run test:mcp                 # MCP package tests
npm run test:e2e                 # Playwright end-to-end (web)
npm run test:e2e:ci              # Same, with chromium install
```

The sync API integration tests (`apps/archon-sync-api/src/integration-*.test.ts`) expect a reachable Postgres; point `DATABASE_URL` (or `ARCHON_TEST_DATABASE_URL`) at a test DB before running.

Lint:

```bash
npm run lint                     # ESLint on the e2e tree
```

---

## Packaging Desktop Builds

Electron Forge drives packaging; `scripts/collect-dist-artifacts.js` gathers outputs.

```bash
npm run package                  # unpacked app bundle
npm run make                     # platform default makers

npm run build:linux              # .deb + AppImage
npm run build:windows            # Squirrel installer
npm run build:mac                # .dmg
npm run build:all                # everything, plus packaged plugins

npm run build:plugins            # bundle plugin releases only (scripts/build-plugins-release.ts)
npm run install:linux            # install the freshly built .deb locally
```

Makers, icon paths, and platform settings live in `forge.config.js`.

---

## Docker & Deployment

Local container workflow:

```bash
npm run docker:api:build         # build sync-api image
npm run docker:api:up            # compose up with local Postgres profile
npm run docker:api:down          # tear it down
npm run docker:logs              # follow compose logs
```

End-to-end deploy helpers:

```bash
npm run deploy                   # full stack (scripts/docker-full-deploy.sh)
npm run deploy:web               # web-only swap (scripts/docker-web-deploy.sh)
npm run docker:web:swap          # blue/green swap of the web container
npm run docker:stack:boot        # bring the full stack up from cold
```

Gateway (host nginx):

```bash
npm run gateway:nginx            # start host nginx with deploy/nginx-gateway.host.conf
npm run gateway:nginx:stop       # stop it
```

CI integrations live under `deploy/drone/`, `deploy/jenkins/`, and the repo-level `.drone.yml` / `Jenkinsfile`. The `deploy/git-server/` tree contains server-side hooks for post-push deploys.

---

## Plugins

Plugins are first-class. Each plugin is a self-contained bundle with a manifest, a runtime entry, and optional UI surfaces.

- **System plugins** (`plugins/system/`) ship bundled with the app. Currently includes `code`.
- **User plugins** (`plugins/user/`) are discovered at runtime from the user's vault.
- The core plugin runtime lives in `src/core/plugin-*` — loader, bundler, catalog, cache, audit, disabled store, and the `archon-host-packages` whitelist.
- Plugins execute inside a SES lockdown realm and see a curated host API provided by `@archon/plugin-ui`.

Manifest schema and validation rules: `src/core/manifest-*`.

---

## MCP Integration

The MCP server (`packages/archon-mcp`, published as `@archon-studio/mcp`) exposes the workspace to AI clients. It supports three transports:

- **stdio** — `archon-mcp` binary, for Claude Desktop / Cursor.
- **SSE** — legacy streaming transport.
- **Streamable HTTP** — `archon-mcp-http` binary, for long-running HTTP clients.

Two auth modes:

- **Cloud** — authenticates against the sync API (`/auth/device`), caches the token, and reads/writes through it.
- **Electron loopback** — connects directly to the running desktop app's local IPC bridge.

See the `@archon-studio/mcp` package for tool definitions (`note.create`, `note.read`, `note.update`, `note.rename`, workspace listing, asset I/O, …).

---

## Contributing

1. Fork and branch from `main`.
2. Install deps and run the test suite before opening a PR: `npm install && npm test`.
3. Follow the existing ESLint + TypeScript configuration.
4. Keep PRs focused and include a short description of what changed and why.
5. New plugins go under `plugins/user/` for third-party contributions; `plugins/system/` is reserved for bundled first-party plugins.

Bug reports, feature ideas, and plugin examples are welcome via issues and PRs.

---

## License

Released under the [MIT License](./LICENSE).
