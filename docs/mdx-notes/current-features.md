# Current-Feature Inventory — Note Pipeline

Snapshot of the `markdown` / `image` / `mdx` note pipeline as it stands today. Every claim cites `path:line`. The MDX mini-app described in earlier planning docs has shipped end-to-end and is reflected here as a current feature, not a gap.

## 1. Note storage (backend: Fastify + Postgres)

| Feature | Entry points | Capability | Extension points | Notes |
|---|---|---|---|---|
| Postgres pool | `apps/archon-sync-api/src/pg.ts:41` (`ensurePgConnected`) — `pg.ts:64` (`getDb`) — `pg.ts:84` (`withTx`) | Singleton `pg.Pool` (size 100; 10 on serverless via `ARCHON_SYNC_API_SERVERLESS=1`). Drizzle ORM on top. | Acquire a dedicated `pg.Client` via `acquireDedicatedClient()` (`pg.ts:96`) for `LISTEN`. | Connection-string read from `DATABASE_URL`; fail-fast `SELECT 1` at boot. |
| Schema + migrations | `apps/archon-sync-api/src/db/schema.ts` (Drizzle), `apps/archon-sync-api/src/db/migrations/*.sql` | Drizzle-kit owns the schema; migrations apply on deploy. | Add a Drizzle table in `schema.ts` and run `drizzle-kit generate`. | Forward-only migrations; rollback via a new migration. |
| WPN tables | `wpnWorkspaces` (`schema.ts:316`), `wpnProjects` (`schema.ts:343`), `wpnNotes` (`schema.ts:376`) | UUID PKs, `type: text`, `content`, `title`, `parent_id`, `project_id`. | `type` is open-string, so a new note `type` requires no schema change. | `type` enum enforced at the API layer. |
| AuthN: JWT bearer | `auth.ts:57` (`signToken`) — `auth.ts:69` (`signAccessToken`) — `auth.ts:103` (`verifyToken`) — `auth.ts:145` (`requireAuth`) | HS256 access + refresh. Secret from `JWT_SECRET`. | Call `signAccessToken(jwtSecret, payload)` for ad-hoc tokens (e.g. WS tokens). | Single shared secret; no key rotation story yet. |
| AuthZ: project access | `permission-resolver.ts` + `space-auth.ts` + `org-auth.ts` | Resolves `{ canRead, canWrite, canManage }` for `(user, project)`. | Reuse from any new route handler. | — |
| App bootstrap | `build-app.ts:36` (`buildSyncApiApp`) | Registers `@fastify/websocket` + CORS + all route modules. | Add `register*Routes(app, …)` calls in `routes.ts`. | — |
| Route registry | `routes.ts:120` (`registerRoutes`) | Central aggregation of all `register*Routes(app, {jwtSecret})` calls. | Same pattern for any new router module. | — |

## 2. Note read/write API

| Feature | Entry points | Notes |
|---|---|---|
| WPN read routes | `wpn-routes.ts` (`registerWpnReadRoutes` — `routes.ts:128`) | Tree listing, single-note GET. Powers `useNote()` in the MDX SDK. |
| WPN write routes | `wpn-write-routes.ts` (`routes.ts:129`) | PATCH/POST notes; owner check enforced upstream. |
| Batch endpoint | `wpn-batch-routes.ts` (`routes.ts:130`) | Bulk writes. MDX mini-app state stays out of this path (separate tables). |
| Backlinks | `note-backlinks-vfs.ts` | Backlinks query used by `useBacklinks()` in the SDK. |
| Image assets | `me-assets-routes.ts`, `image-asset-path.ts`, `image-note-metadata.ts`, `r2-client.ts` for R2/S3 | Image note type infrastructure. |

## 3. MDX support — web runtime + Electron

| Feature | Entry points | Status |
|---|---|---|
| Web MDX runtime | `apps/archon-web/lib/mdx/{compile,compile-cache,sandbox,renderer}.{ts,tsx}` | Compile-in-browser via `@mdx-js/mdx`, sha256-keyed cache in IndexedDB (`dexie`), expression sandbox via SES `Compartment`. |
| Web MDX builder | `apps/archon-web/app/mdx/builder/` | Drag-and-drop builder using `@dnd-kit/*` + `@uiw/react-codemirror` with human-readable MDX round-trip. |
| MDX SDK package | `packages/archon-mdx-sdk` (npm `@nodex-studio/mdx-sdk`), `packages/archon-mdx-sdk-runtime` (private `@archon/mdx-sdk-runtime`) | Authors import as `@archon/mdx-sdk`; the renderer enforces the facade name. Schema package and runtime are separate by design. |
| MDX virtual-module facades (Electron) | `src/renderer/archon-mdx-facades/registry.ts:5` (`ARCHON_MDX_FACADE_IMPORTS = ["@archon/ui","@archon/date"]`) | Electron-renderer-only; resolved via `component-map.ts` / `ui.tsx`. Pattern mirrored on the web side. |
| Plugin system | `packages/archon-plugin-ui/src/index.ts:33` (`PluginModuleDefinition` with `noteTypes?: string[]`) | Plugins contribute new note types via `definePlugin(...)`. |
| SES sandbox | `ses` in root `package.json` | Dependency available for expression-sandboxing on the web. |

## 4. mdx-state service (per-project KV with live updates)

| Feature | Entry points | Notes |
|---|---|---|
| Schema | `mdxStateHead` (`schema.ts:511`), `mdxStateChunks` (`schema.ts:534`) | Inline values up to `INLINE_THRESHOLD_BYTES` (4 MiB); larger values are chunked at `CHUNK_SIZE_BYTES` (8 MiB) with `headVersion`-filtered reads to avoid torn state. |
| Service | `mdx-state/service.ts` | Inline + chunked write paths share one `withTx`. Each successful put fires `pg_notify('mdx:<projectId>', …)`. |
| Notify | `mdx-state/notify.ts:35` (`notifyMdxState`) | `pg_notify` fanout; channel naming is `mdx:<projectId>`. |
| HTTP routes | `mdx-state/routes.ts` (`registerMdxStateRoutes` — `routes.ts:142`) | Per-key get/put/delete with permission checks via `permission-resolver.ts`. |
| WebSocket | `mdx-state/ws.ts` (`registerMdxStateWsRoutes` — `routes.ts:143`) | Refcounted `LISTEN` channel manager; one dedicated `pg.Client` per channel; clients receive payloads and re-fetch the head row. |
| SDK hook | `packages/archon-mdx-sdk-runtime/src/hooks.ts` (`useProjectState`) | Optimistic local echo; reconciles on server ack. |

## 5. Export / import (v2 bundles)

| Feature | Entry points | Notes |
|---|---|---|
| v2 bundle export | `wpn-import-export-routes.ts`, `archiver` | Streams project notes into a ZIP. mdx-state tables are deliberately excluded. |
| Conflict policy | `image-note-metadata.ts` and helpers in `export-import-helpers.ts` | `skip | overwrite | rename` enum applied uniformly. |
| Import route | Same module | Non-owner imports of `mdx` notes land with a read-only marker; the builder refuses to mount in that state. |

## 6. Frontend surfaces

| Surface | Where | Notes |
|---|---|---|
| **Web app** (Next.js) | `apps/archon-web/` | Primary surface for note rendering, including the MDX runtime + builder. |
| Web app shell | `apps/archon-web/app/` + `packages/archon-shell-ui` | Mounts the shared shell UI; note-type dispatch lives here. |
| Plugin UI package | `packages/archon-plugin-ui/src/index.ts` | Plugin author API for slots, commands, note types. |
| **Electron renderer** (desktop) | `src/renderer/` | Same plugin runtime; uses the `archon-mdx-facades/` virtual modules. |

## 7. Notable dependencies

From the root `package.json`:
- `@mdx-js/mdx`, `@mdx-js/react`, `remark-mdx` — MDX compile in the browser
- `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/modifiers` — the builder
- `@codemirror/*` + `@uiw/react-codemirror` — code-edit toggle
- `dexie` — IndexedDB wrapper for the compile cache
- `dompurify`, `rehype-sanitize` — `<Markdown>` sanitization
- `ses` — hardened JS for expression sandbox
- `@babel/standalone` — fallback transforms
- `jsonwebtoken` — token minting (HTTP + WS)
- `pg` + `drizzle-orm` (in `apps/archon-sync-api`) — Postgres driver and query layer; `pg_notify` powers fanout, ordinary `BEGIN…COMMIT` covers transactions

## 8. Runtime preconditions

| Precondition | Status |
|---|---|
| Postgres reachable at `DATABASE_URL` | sync-api fails fast at boot if the pool can't `SELECT 1`. |
| WebSocket layer | `@fastify/websocket` registered in `build-app.ts:42`. Sticky-session note for proxy deployments. |
| MDX SDK virtual module | `@archon/mdx-sdk` resolved at compile time; authors import the facade name and `mdx-sdk-runtime` ships the implementation. |
| Owner-only authoring | `permission-resolver.ts` + `space-auth.ts` enforce; the builder mount gate consumes the same helpers. |
