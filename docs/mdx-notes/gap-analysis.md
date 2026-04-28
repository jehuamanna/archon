# MDX Mini-App — Implementation Map

The original gap analysis (closed as v1) mapped each missing capability to the file that would deliver it. v1 has shipped; this doc is now an index from each capability to where it lives in the tree. Pair with `current-features.md` for the full inventory.

## Capability → implementation

| Capability | Where it lives |
|---|---|
| Web-side note-type dispatch for `mdx` | `apps/archon-web/app/` (note-type registry) — `wpnNotes.type` in `apps/archon-sync-api/src/db/schema.ts:376` is open-string, so no schema change was needed |
| Client-side MDX compile with content-hash cache | `apps/archon-web/lib/mdx/compile.ts` + `compile-cache.ts` (sha256-keyed, IndexedDB via `dexie`) |
| Expression sandbox (no `fetch`, no `window`) | `apps/archon-web/lib/mdx/sandbox.ts` (SES `Compartment`) |
| `useProjectState`, `useNote`, `useQuery` SDK | `packages/archon-mdx-sdk-runtime/src/hooks.ts` + `index.ts`; schema in `packages/archon-mdx-sdk` (npm `@nodex-studio/mdx-sdk`); facade name `@archon/mdx-sdk` enforced by the renderer |
| Per-project KV state on Postgres | `mdxStateHead` (`apps/archon-sync-api/src/db/schema.ts:511`) and `mdxStateChunks` (`schema.ts:534`); service in `apps/archon-sync-api/src/mdx-state/service.ts` |
| Live updates over WebSocket | `pg_notify('mdx:<projectId>', …)` in `mdx-state/notify.ts:35`; refcounted `LISTEN` channel manager in `mdx-state/ws.ts`; routes registered at `routes.ts:143` (`registerMdxStateWsRoutes`) |
| HTTP state routes | `mdx-state/routes.ts` (`registerMdxStateRoutes` — `routes.ts:142`) |
| Drag-and-drop builder with MDX round-trip | `apps/archon-web/app/mdx/builder/` (uses `@dnd-kit/*` + `@uiw/react-codemirror`) |
| Owner-only authoring gate | Reuses `permission-resolver.ts` + `space-auth.ts` from the existing WPN flow |
| Exclude state from v2 bundles | `wpn-import-export-routes.ts` does not touch the `mdx_state_*` tables |
| Read-only-on-import for non-owners | `metadata.readOnlyForImporter: true` is set on import; the builder refuses to mount when present |

## Reusable building blocks (referenced above)

- **Auth** — `apps/archon-sync-api/src/auth.ts`: `signToken` (`auth.ts:57`), `signAccessToken` (`auth.ts:69`), `verifyToken` (`auth.ts:103`), `requireAuth` (`auth.ts:145`).
- **Postgres pool** — `apps/archon-sync-api/src/pg.ts`: `ensurePgConnected` (`pg.ts:41`), `getDb` (`pg.ts:64`), `withTx` (`pg.ts:84`), `acquireDedicatedClient` (`pg.ts:96`) for `LISTEN`.
- **Schema + migrations** — `apps/archon-sync-api/src/db/schema.ts` and `apps/archon-sync-api/src/db/migrations/*.sql` (Drizzle-kit owns state).
- **Permission resolver** — `apps/archon-sync-api/src/permission-resolver.ts`.
- **Route aggregation** — `apps/archon-sync-api/src/routes.ts:120` (`registerRoutes`).
- **App build** — `apps/archon-sync-api/src/build-app.ts:36` (`buildSyncApiApp`); `@fastify/websocket` is registered there.
- **Virtual-module facade pattern** — `src/renderer/archon-mdx-facades/` (Electron prior art mirrored for the web).

## Operational caveats (carried forward from v1 review)

- **Sticky sessions for WebSocket.** `@fastify/websocket` works behind any proxy that supports `Upgrade`; horizontal scaling needs sticky sessions or a pub/sub layer above `pg_notify`.
- **Postgres reachability is hard required.** sync-api fails fast at boot if `DATABASE_URL` doesn't accept a `SELECT 1`.
- **Non-owner imports of `mdx` notes** land read-only by design; the builder mount gate consumes the import metadata, not a separate flag.
