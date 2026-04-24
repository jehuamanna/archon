---
name: archon-use-seed-prompt
description: Run the end-to-end Archon seed-prompt workflow — disect requirements, plan, write tests, execute, run tests, and write each phase back as children of the seed note. Invoke when the user says "use seed prompt", "run seed", "drive seed <note>", passes an Archon note UUID as the starting point, or asks to take an Archon note from requirements to delivery.
---

# archon-use-seed-prompt

You are the orchestrator for the Archon "seed-prompt" workflow. A **seed-prompt** is an Archon note whose content describes what the user wants built. Your job is to run five phases in order, attaching every artifact back to the seed as children so the note tree captures the entire audit trail.

## Inputs you need before starting

1. `seedNoteId` — the Archon note UUID that is the seed prompt. If the user provides a title instead of a UUID, resolve it first via `archon_resolve_note` (or `archon_find_notes`). If ambiguous, show candidates and stop until the user picks one.
2. Read the seed with `archon_get_note` and surface its title + content to the user in one short message so they can confirm you're working from the right note.

If no seed id is provided, ask **once** for it and stop.

## Phase order (strict)

Run phases in this order. Do not skip. Between phases, write a one-line status update to the user ("Phase 1 complete — 4 prompt notes created; moving to planning").

1. **Create Prompts** — delegate to skill `archon-create-prompts` (you may ask clarifying questions).
2. **Create Plans** — delegate to skill `archon-create-plans` (you may ask clarifying questions).
3. **Create Test Cases** — delegate to skill `archon-create-test-cases` (you may ask clarifying questions).
4. **Execute Plans** — delegate to skill `archon-execute-plans` (**no user interruption** — make reasonable assumptions, commit per phase).
5. **Execute Test Cases** — delegate to skill `archon-execute-test-cases` (**no user interruption** — write results to `Test Results/`).

"Delegate" here means: follow the instructions in that skill's SKILL.md yourself. Skills cannot invoke skills directly — you are the runtime. Open each skill file once at the phase boundary if you need the full instructions.

## Child skeleton under every seed

Create these containers as direct children of the seed **on first use**, not upfront:

- `Prompts` (markdown) — parent of `Prompt-Phase-<N>-<topic>`
- `Plans` (markdown) — parent of `Plans-Phase-<N>-<topic>`
- `Test Cases` (markdown) — parent of `TestCase-Phase-<N>-<topic>`
- `Test Results` (markdown) — parent of `TestResult-Phase-<N>-<runId>`
- `Bugs` (markdown, created on demand by `archon-fix-bugs`)
- `CRs` (markdown, created on demand by `archon-cr-seed-prompts`)

Use `archon_create_child_note` with `parentNoteId = <seedNoteId>` for the containers, then `parentNoteId = <containerNoteId>` for the phase notes. Never rely on path-string creation when you already have a parent UUID — it's cheaper and unambiguous.

## Mandatory note etiquette (applies to every note you write under the seed)

Every derivative note **must** begin with this YAML-front-matter-like header block, inside the markdown body (Archon stores content as markdown — this header is part of the content). This is on top of Archon's own `created_at_ms` / `updated_at_ms`.

```
---
seedPath: "<Workspace> / <Project> / <Seed Title> / <Container> / <This Note Title>"
seedNoteId: <seed UUID>
createdAt: <ISO-8601 UTC>
revision: 1
---

## Change log
- <ISO-8601 UTC> · rev 1 · initial draft
```

**Revision rules:**
- On every patch via `archon_write_note` (mode `patch_existing`), bump `revision` by 1 and append a new change-log line: `- <ISO-8601 UTC> · rev <N> · <one-line description of what changed>`.
- Never delete prior change-log lines. The log grows.
- If you do not know the workspace or project name, resolve them via `archon_find_projects` / `archon_list_wpn` before writing — do not write `unknown` into `seedPath`.

Resolve the seed's workspace and project **once** at the start (via `archon_find_projects` with the project_id from the seed note's payload, then workspace from the project) and cache them in-context for all subsequent writes in the session.

## Write-back at the end

When the final phase finishes, call `archon_write_back_child` with `taskNoteId = <seedNoteId>` and a session-summary child titled `Session Summary — <ISO date>`. The body lists:
- Which phases ran, their note IDs, and final status.
- Commits made (hash + subject).
- Test pass/fail counts.
- Any open bugs (link to the `Bugs` subtree).
- Anything the user will need to follow up on.

This runs regardless of whether the workflow succeeded — on failure, the summary records where it stopped and why.

## Failure / interruption handling

- If any phase fails mid-run, stop the pipeline, write the failure + partial state into the session summary, and surface it to the user. Do not auto-retry.
- If the user interrupts during an execute phase, treat it as a course correction; record the interruption in the active plan/test note's change log before responding.
- If an Archon MCP call returns ambiguous candidates, halt and ask the user to pick — never guess.

## What you must NOT do

- Do not write any code or commit anything before phases 1–3 finish. Planning precedes execution.
- Do not create placeholder / empty container notes speculatively — create on first real write.
- Do not skip the metadata header; a note without it is a bug in this workflow.
- Do not modify the seed note's own content. Everything goes into children.