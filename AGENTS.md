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

<!-- archon:skills:begin -->

## Archon skills

Canonical source: `skills/<name>/SKILL.md`. Each skill below is discoverable
by every AGENTS.md-aware agent (Codex, Antigravity, opencode, Pi, Copilot).
Tools with dot-directory support (Claude, Cursor, Windsurf, Copilot,
Antigravity, opencode) also get their own provider-specific file layout.

**Edit rule:** change `skills/<name>/SKILL.md` only. Re-run `archon_install_skill`
(or `npm run sync-skills` if your repo is Node-based) to regenerate the provider
dot-directories and this table. Do not hand-edit anything inside the marker block.

| Skill | When to invoke |
|---|---|
| `archon-analyze` | Read-only cross-artifact consistency check across Prompt-Phase, Plans-Phase, Tasks-Phase, TestCase-Phase, and the Constitution. Produces an Analysis-Phase-<N>-<topic> findings report that gates archon-implement (CRITICAL findings block execution). Invoke when the user says "analyze", "check consistency", or "run /analyze", or before archon-implement runs. |
| `archon-clarify-prompts` | Clarification pass over an existing Prompt-Phase-<N>-<topic> note — surface ambiguity, ask up to 5 structured questions one at a time, and apply each accepted answer in place (bumping the phase note's revision). Invoke when the user says "clarify the spec", "clarify phase N", "run /clarify", or when an upstream skill detects unresolved [NEEDS CLARIFICATION] markers. |
| `archon-cr-seed-prompts` | Treat a change request (CR) as its own child seed-prompt under an existing Archon seed, then run the full seed-prompt pipeline scoped to that CR so the delta is tracked separately from the original scope. Invoke when the user introduces a CR / change request / scope change against an existing Archon seed. |
| `archon-create-architecture` | Execute architecture-extraction Plans (Plans-Phase-1..7-<topic>) and write the actual architecture deliverables as Arch-Phase-N-<topic> notes (with sub-artifact children) under the reserved Architecture/ container of the seed. Read-only against the codebase — no git commits — output is Archon notes (mermaid diagrams, ERDs, sequence diagrams, contracts, etc.). Invoke when the user asks to execute architecture plans, materialize architecture, or run the build phase of an architecture extraction. |
| `archon-create-architecture-plans` | Act as a principal solution architect to turn architecture-extraction Prompts (Prompt-Phase-1..7-<topic>) into matching plan notes (Plans-Phase-1..7-<topic>) under a "Plans" container of the seed, then reserve an "Architecture" container for the downstream execution skill. Each plan covers extraction strategy, tooling, dependencies, execution order with [commit] boundaries, and risks/unknowns. Mirrors the 1:1 phase numbers and topic slugs from the prompts. Invoke when the user asks to create architecture plans from prompts, or run the architect phase of an architecture extraction. |
| `archon-create-architecture-prompts` | Act as a senior business analyst to dissect an architecture-extraction seed-prompt note into 7 fixed dimension-phase prompt notes (Prompt-Phase-1..7-<topic>) saved under a "Prompts" container of the seed. Each prompt covers Scope / Inputs / Deliverables / [NEEDS CLARIFICATION] / Acceptance criteria with the dimension scheme (context, components, data, runtime, contracts, NFRs, cross-cutting) baked in. Invoke when the user asks to create architecture prompts from a seed, decompose architecture requirements into prompts, or run the BA phase of an architecture extraction. |
| `archon-create-plans` | Act as a principal solution architect to turn Archon "Prompts" phase notes into implementation plans (Plans-Phase-<N>-<topic>) under a "Plans" container of the seed, covering HLD, LLD, tech stack, risks, feasibility, and a strict execution order. Invoke when the user asks to plan a seed, create plans from prompts, or run the architecture phase of the Archon workflow. |
| `archon-create-prompts` | Act as a senior business analyst to dissect an Archon seed-prompt note into phased prompt notes (Prompt-Phase-<N>-<topic>) saved as children of a "Prompts" container under the seed. Invoke when the user asks to create prompts from a seed, decompose requirements into prompts, or run the BA phase of the Archon workflow. |
| `archon-create-tasks` | Convert each approved Plans-Phase-<N>-<topic> note into a matching Tasks-Phase-<N>-<topic> note under a "Tasks" container on the seed, using the strict `- [ ] [TaskID] [P?] [Story?] Description with file path` format so archon-implement can iterate mechanically. Invoke when the user says "create tasks", "break plan into tasks", "run /tasks", or after archon-create-plans completes. |
| `archon-create-test-cases` | Write comprehensive unit, integration, and end-to-end test cases (Playwright for UI) as phase notes (TestCase-Phase-<N>-<topic>) under a "Test Cases" container of the seed. Invoke when the user asks to write or create test cases from an Archon plan or seed prompt. |
| `archon-execute-notes` | Resolve any Archon note by title or UUID via archon_execute_note and follow its content as executable instructions, handling ambiguity by surfacing candidates for the user to pick. Invoke when the user asks to run, execute, or follow an Archon note without specifying a workflow phase. |
| `archon-execute-test-cases` | Run the test cases specified in TestCase-Phase-<N> notes (unit, integration, e2e via Playwright) and write results as children of a "Test Results" container under the seed. No user interruption. Invoke when the user asks to run, execute, or validate test cases for an Archon seed prompt. |
| `archon-extract-architecture` | End-to-end architecture extraction — read a seed note about a codebase or feature, then chain through Prompts (BA), Plans (architect), and Architecture (execution) to produce mermaid diagrams, ERDs, sequence diagrams, contracts, NFR tables, and ADRs as Archon notes. Orchestrates archon-create-architecture-prompts → archon-create-architecture-plans → archon-create-architecture across 7 fixed dimension-phases (context, components, data, runtime, contracts, NFRs, cross-cutting). Invoke when the user asks to extract architecture, document architecture, reverse-engineer system design end-to-end, or run the architecture-extraction phase of an Archon workflow. |
| `archon-fix-bugs` | Triage and fix bugs surfaced from failing tests or user reports in an Archon seed-prompt workflow, keeping each bug as a child note under a "Bugs" container on the seed, grouped by topic. Invoke when the user reports a bug, asks Claude to fix failing tests, or says "fix bugs in <seed>". |
| `archon-implement` | Execute Archon Plans-Phase-<N> notes in the recorded execution order, write code, commit at every [commit] boundary, and attach a summary child under each plan note. No user interruption. Invoke when the user asks to execute plans, implement a seed prompt, or run the build phase of an Archon workflow. |
| `archon-use-seed-prompt` | Run the end-to-end Archon seed-prompt workflow — disect requirements, plan, write tests, execute, run tests, and write each phase back as children of the seed note. Invoke when the user says "use seed prompt", "run seed", "drive seed <note>", passes an Archon note UUID as the starting point, or asks to take an Archon note from requirements to delivery. |

<!-- archon:skills:end -->
