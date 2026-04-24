# AGENTS.md — Archon

Standing instructions for AI coding agents (Claude Code, Cursor, Windsurf, Copilot, Antigravity, opencode, Pi, etc.) working in this repo.

## What this repo is

Archon is a programmable knowledge system distributed as an Electron desktop app plus a web app, backed by a Fastify sync API against MongoDB and exposed to AI agents via an MCP server.

Monorepo with npm workspaces:
- `apps/archon-web` — Next.js web app; colocated Fastify sync-api runs inside the same Node process via `apps/archon-web/lib/sync-api-route-handler.ts` when dev/prod is same-origin.
- `apps/archon-sync-api` — the Fastify sync-api package (`@archon/sync-api`); built to `dist/` and consumed from the web app via a symlinked workspace dep.
- `packages/archon-mcp` — the MCP server (`@archon-studio/mcp`) that exposes Archon WPN tools to agents.
- `src/` — the Electron main + renderer code.

The project is mid-rename from **nodex → archon**. Do not add backcompat shims.

## Commands you actually need

```bash
npm run dev:web                              # web app + colocated sync-api on :3000
npm run build:lib -w @archon/sync-api        # rebuild sync-api dist/
npm test -w @archon/sync-api                 # Fastify integration tests (need local MongoDB)
npm test -w @archon-studio/mcp               # MCP package unit tests
npm run typecheck -w @archon/sync-api        # fast sanity check
```

The Fastify sync-api is cached on `globalThis.__archonSyncFastifyApp` once built — editing sync-api source does NOT reload that instance. Changes to `apps/archon-sync-api/src/*.ts` require `npm run build:lib` AND a Next dev-server restart for `next dev` to pick up new routes.

## Skills — where they live and how they get into your tool

The canonical source of every Archon workflow skill is `<repo>/skills/<name>/SKILL.md`. A single sync script (`scripts/sync-skills.mjs`) fans those out to tool-specific folders at install time:

| Tool | Consumes | How |
|---|---|---|
| Claude Code | `.claude/skills/<name>/SKILL.md` | Symlink to `skills/<name>/` |
| Cursor | `.cursor/rules/<name>.mdc` | Generated with Cursor's frontmatter |
| Windsurf | `.windsurf/rules/<name>.md` | Generated, body verbatim |
| GitHub Copilot | `.github/instructions/<name>.instructions.md` | Generated with `applyTo` frontmatter |

Run `npm run sync-skills` after editing anything under `skills/`. `npm install` does this automatically via `postinstall`.

**When you add or change a skill**: edit `skills/<name>/SKILL.md` only. Never edit the generated files under `.claude/.cursor/.windsurf/.github/`.

## Hard constraints (the code cannot make these obvious)

1. **Fastify `reply` is a thenable** — never `await reply.header(...)` or any chainable setter before `.send()`. Under `app.inject` this deadlocks. Set headers by plain call; send by plain call.
2. **React `setValue((prev) => …)` updaters must be pure** — no broadcasts, subscriptions, or side effects inside. Updaters can run during a sibling's render, which will double-fire anything side-effectful.
3. **Integration tests hit real MongoDB**, never mocks. The `integration-*.test.ts` files in `apps/archon-sync-api/src/` use `resolveTestMongoUri()` and drop a per-test DB via `dropActiveMongoDb()`. Follow that pattern.
4. **MCP changes are two-step** — the MCP server reads `@archon/sync-api` from node_modules (symlinked to `apps/archon-sync-api`). A new sync-api route requires `npm run build:lib -w @archon/sync-api` AND restart of whatever Node process caches the Fastify app (usually `npm run dev:web`).
5. **Don't commit files under** `.claude/skills/`, `.cursor/rules/`, `.windsurf/rules/`, `.github/instructions/` — they're generated. If you see one in a diff, re-run `npm run sync-skills` and stage `skills/<name>/SKILL.md` instead.

## Don't

- Don't introduce back-compat shims during the nodex→archon rename.
- Don't add destructive shortcuts (`--no-verify`, `git reset --hard`, `rm -rf` on shared state) unless explicitly asked.
- Don't bypass Mongo through direct surgery when a REST or MCP path exists — add the path instead.
- Don't hand-edit generated tool-specific files (see table above). Edit the canonical source and re-sync.

## When things don't work

- **A Fastify route returns 404 even though you added it** — the colocated sync-api's Fastify app is cached on `globalThis.__archonSyncFastifyApp`. Rebuild sync-api (`npm run build:lib -w @archon/sync-api`) and fully restart the Next dev server (`Ctrl+C` the terminal running `npm run dev:web`, then start it again).
- **An MCP tool does not appear** — tools are statically registered in `packages/archon-mcp/src/server.ts`. Requires an MCP server restart. `/mcp` in Claude Code picks up a reconnect.
- **Tests fail with Mongo errors** — the test harness tries `resolveTestMongoUri()` and skips if unreachable. Make sure a local Mongo is up (`npm run docker:api:up`).
