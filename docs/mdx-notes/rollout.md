# Rollout — Introducing the `mdx` Note Type

## Day-one posture

- Existing `markdown` notes render **unchanged**. Zero regression is the primary ship gate.
- The `mdx` note type is **opt-in per workspace** via `settings.mdxMiniApp = true`. Default false.
- Only workspace owners can **create** an `mdx` note (enforced by the existing note-create authz path).
- Any project member can **view** and **interact with** a rendered `mdx` note — but only owners see the builder chrome.

## Feature flag

- **Per-workspace**: `settings.mdxMiniApp: boolean` on `WpnWorkspaceDoc`. Admins toggle via the existing settings PATCH endpoint.
- **Global kill switch**: env `ARCHON_MDX_RUNTIME_DISABLED=1` on the sync-api. When set, every `mdx` note renders as raw source regardless of per-workspace setting. This is the rollback escape valve — no client deploy required.
- Helper: `apps/archon-sync-api/src/mdx-state/feature-flag.ts` (`mdxEnabledForWorkspace`, `mdxRuntimeGloballyEnabled`).

## Note-type dispatch (web)

When the web shell fetches an `mdx` note:

1. If the workspace flag is off **or** the global kill switch is on → render `<pre>{source}</pre>` with a "preview disabled" banner. This is the rollback mode.
2. Else → mount `<MdxRenderer source={note.content} context={…} />` (from `apps/archon-web/lib/mdx/renderer.tsx`).
3. If the caller is the workspace owner → wrap with `<BuilderApp>` when they request edit mode.
4. If the note has `metadata.readOnlyForImporter: true` (see R3-Qe) → bypass `<BuilderApp>` for everyone; render only.

## Export / import

- State is **excluded** from v2 bundles (R2-Q9a). No change to bundle version.
- On import: importer becomes new author **iff** they are a workspace owner in the target. Otherwise the note is stamped `metadata.readOnlyForImporter: true` and builder won't mount for them (R3-Qe).
- `useProjectState(key, initial)` auto-initializes empty per R3-Qd; consumers see `initial` (or `undefined`) on first render after a reimport.

## Staged rollout plan

1. **Dogfood** — enable on the Archon team's own workspace. Run for 1–2 weeks while the cookbook recipes are exercised daily. Triage M-findings from `security-review.md`.
2. **Beta** — enable for a small opt-in cohort of orgs. Collect telemetry on cache hit rate, WS reconnect frequency, and 413/422/429 counts.
3. **GA** — remove beta flag; keep kill switch.

## Rollback drill

- `ARCHON_MDX_RUNTIME_DISABLED=1 && restart sync-api`.
- Web client continues to serve; `mdx` notes display raw source + banner.
- No data loss; state remains intact in Postgres for the next re-enable.

## Regression gates

Before enabling for any workspace:

- `markdown` fixture suite passes byte-identical (no re-encoding).
- Autosave debounce interval unchanged (matches cited ms in `current-features.md`).
- v2 bundle export on a markdown-only project is byte-identical pre- and post-rollout.
- Backlinks unchanged.

## Ownership in production

- Bug reports tagged `mdx-mini-app` route to the team owning this plugin.
- On-call should know: the only new failure modes are MDX compile errors (fallback UI) and Postgres transaction retries (logged via sync-api logger). A single WS outage is graceful-degrade — the HTTP layer keeps working.

## Follow-ups not in v1

- Sanitizing `<Markdown>` component (security review M-1).
- AST-level import whitelist (M-2).
- Distributed rate limit (M-3).
- iframe-sandbox for defense-in-depth (L-6).
