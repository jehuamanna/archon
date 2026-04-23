# Current-Feature Audit — Note Pipeline (Baseline for MDX Mini-App Plugin)

Audit of the `markdown` / `image` / `mdx` note pipeline as it exists today. The new MDX mini-app plugin will slot in alongside. Every claim below cites `path:line`.

## 1. Note storage (backend: Fastify + MongoDB)

| Feature | Entry points | Capability | Extension points | Limitations |
|---|---|---|---|---|
| Mongo client pool | `apps/archon-sync-api/src/db.ts:142` (`connectMongo`) — `apps/archon-sync-api/src/db.ts:166` (`ensureMongoConnected`) | Single `MongoClient` singleton; pool size 100 (10 serverless). | `getActiveDb()` at `db.ts:787`; per-collection getters from `db.ts:581` onward. | Replica set status not asserted at connect; required for Change Streams / transactions (R3-Qc, R4-Qb). |
| Idempotent migrations | `db.ts:303` (`runIdempotentMigrations`) | Keyed in `_migrations` collection (`db.ts:291`); backfills run on every startup. | Add a new `m_00x_*` fn + call site. | No down-migrations. |
| Notes collection (WPN) | `db.ts:77` (`WpnNoteDoc`) — indexes at `db.ts:198-201` | Per-user note doc: `type: string`, `content`, `title`, `parent_id`, `project_id`. | `type` is open-string, so a new `mdx` type requires no schema change. | `type` enum enforced only at the API layer; backend accepts any string. |
| AuthN: JWT bearer | `auth.ts:44` (`signToken`) — `auth.ts:122` (`authBearerHeader`) — `auth.ts:132` (`requireAuth`) | HS256 access + refresh. Secret from `ARCHON_JWT_SECRET`. | Call `signAccessToken(jwtSecret, payload)` to mint tokens for other purposes (e.g. WS tokens). | Single shared secret — no key rotation story. |
| AuthZ: project access | `permission-resolver.ts` (whole file) + `space-auth.ts`, `org-auth.ts` | Resolves `{ canRead, canWrite, canManage }` for `(user, project)`. | Re-use in a new state-service middleware. | — |
| App bootstrap | `build-app.ts:19` (`buildSyncApiApp`) | Registers CORS + all route modules; `app.ready()` before listen. | Add a new `registerMdxStateRoutes(app, …)` call in `routes.ts`. | — |
| Route registry | `routes.ts:119` (`registerRoutes`) | Central aggregation of all `register*Routes(app, {jwtSecret})` calls. | Same pattern for any new router module. | — |

## 2. Note read/write API

| Feature | Entry points | Notes |
|---|---|---|
| WPN read routes | `wpn-routes.ts` (see `registerWpnReadRoutes` in `routes.ts:126`) | Tree listing, single-note GET. Used for `useNote()` in MDX SDK. |
| WPN write routes | `wpn-write-routes.ts` (`routes.ts:127`) | PATCH/POST notes; owner check upstream. Only workspace owners can create/update MDX notes per R1-5 — enforce in the existing owner path. |
| Batch endpoint | `wpn-batch-routes.ts` (`routes.ts:128`) | Bulk writes — MDX mini-app state should **not** piggyback on this (separate collection). |
| Backlinks | `note-backlinks-vfs.ts` | Backlinks query used by `useBacklinks()` in the SDK. |
| Image assets | `me-assets-routes.ts`, `image-asset-path.ts`, `image-note-metadata.ts`, plus `r2-client.ts` for R2/S3 | Existing image note type infrastructure; referenced as comparable complexity for MDX mini-app. |

## 3. Existing MDX support (Electron renderer only — no web runtime yet)

| Feature | Entry points | Status |
|---|---|---|
| `mdx` note type registration (main process) | `src/core/register-builtin-mdx-note-type.ts:17` | Renders MDX as escaped pre-text — **placeholder**, no real compile. |
| MDX virtual-module facades | `src/renderer/archon-mdx-facades/registry.ts:5` (`ARCHON_MDX_FACADE_IMPORTS = ["@archon/ui","@archon/date"]`) | Electron-renderer-only; resolved via `component-map.ts` / `ui.tsx`. **Good prior art to mirror for the web `@archon/mdx-sdk` module.** |
| Plugin system | `packages/archon-plugin-ui/src/index.ts:33` (`PluginModuleDefinition` with `noteTypes?: string[]`) | Plugins can contribute new note types via `definePlugin(...)`. MDX mini-app will be a plugin contribution. |
| SES sandbox | `ses@^1.15.0` in `package.json:173` | Already a dependency — available for expression-sandboxing on the web. |

## 4. Export / import (v2 bundles)

| Feature | Entry points | Notes |
|---|---|---|
| v2 bundle export | `wpn-import-export-routes.ts`, `archiver` (see `routes.ts:141`) | Streams project notes into a ZIP. State collection will be **excluded** (R2-Q9a). |
| Conflict policy (image notes) | Commits `91f713a` + `38415d5`; see `image-note-metadata.ts` | `skip | overwrite | rename` enum; the per-key state layer mirrors this pattern on re-import. |
| Import route | Same file. | Non-workspace-owner importing an `mdx` note produces a read-only marker per R3-Qe. |

## 5. Frontend surfaces

| Surface | Where | Relevance to MDX plugin |
|---|---|---|
| **Electron renderer** (desktop) | `src/renderer/` | Has `archon-mdx-facades/` prior art. Out of scope per "forget Electron" (R1-6) but good reference. |
| **Web app** (Next.js 16) | `apps/archon-web/` | `apps/archon-web/package.json:13` (`next: ^16.2.3`). **Target surface for this plugin.** |
| Web app shell | `apps/archon-web/app/client-shell.tsx`, `client-shell-loader.tsx` | Mounts the `@archon/shell-ui` package. |
| Shared shell UI | `packages/archon-shell-ui/src/index.tsx` (117 lines) | Entry point — note rendering dispatch lives here (or is a hole to add). |
| Plugin UI package | `packages/archon-plugin-ui/src/index.ts` | Plugin author API for slots, commands, note types. |

## 6. Dependencies already available (no new installs needed)

From `package.json`:
- `@mdx-js/mdx@^3.1.1`, `@mdx-js/react@^3.1.1`, `remark-mdx@^3.1.1` — compile-in-browser ready
- `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/modifiers` — for the builder
- `@codemirror/*` + `@uiw/react-codemirror` — for the Code toggle
- `dexie@^4.4.2` — IndexedDB wrapper for the compile cache
- `dompurify@^3.3.3`, `rehype-sanitize@^6.0.0` — for `<Markdown>` sanitization
- `ses@^1.15.0` — hardened JS for expression sandbox
- `@babel/standalone@^7.29.2` — available for fallback transforms
- `jsonwebtoken@^9.0.3` — WS token minting
- `mongodb@^6.12.0` — driver; supports Change Streams + transactions (requires replica set)

## 7. Gaps / preconditions for the mini-app plugin

| Precondition | Status |
|---|---|
| Replica-set Mongo | **Unverified** — `db.ts` does not assert. If single-node, `Change Streams` and `session.withTransaction` will fail. Mark as runtime prereq. |
| WebSocket layer (R4-Qc) | **None** — Fastify app has HTTP routes only. To be added under `registerMdxStateWsRoutes` using Fastify's `ws` ecosystem (or raw `ws` adapter). |
| `useProjectState` layer | **None** — per-project KV store is new. |
| Web-side MDX compile | **None** — Electron renderer has a stub; web has no MDX runtime. |
| Drag-and-drop builder | **None** — `@dnd-kit` deps present but no builder code. |
| Owner-only authoring gate | **Indirect** — owner checks live in `space-auth.ts` / `permission-resolver.ts`; new code should reuse these helpers. |

## 8. Integration points for the mini-app plugin

1. **State service** → new files under `apps/archon-sync-api/src/mdx-state/*`, wired from `routes.ts:119` via a new `registerMdxStateRoutes(app, {jwtSecret})`.
2. **WebSocket** → new `apps/archon-sync-api/src/mdx-state-ws.ts` mounted in `build-app.ts`.
3. **Web renderer** → new `apps/archon-web/app/mdx/` (runtime, SDK, builder) + a plugin manifest under `plugins/system/mdx-mini-app/`.
4. **Note-type dispatch (web)** → extend the existing web shell renderer (a small dispatch table; today only `markdown` is wired web-side).
5. **Feature flag** → add `featureFlags.mdxMiniApp` consulted in both create-note UI and render dispatch.

## 9. Conflict flags

- **No existing WS layer.** Adds deployment complexity (sticky sessions / horizontal scaling considerations) — flag for human review.
- **Electron has a different MDX stub.** Web-side does not need to unify with it in v1; flagged to avoid divergence drift.
- **Web app is thin.** Most UI today is in `src/renderer/` for Electron; the web app only hosts auth/invite/health. The builder will roughly double the web app surface area — flag for capacity.
