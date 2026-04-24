---
name: archon-implement
description: Execute Archon Plans-Phase-<N> notes in the recorded execution order, write code, commit at every [commit] boundary, and attach a summary child under each plan note. No user interruption. Invoke when the user asks to execute plans, implement a seed prompt, or run the build phase of an Archon workflow.
---

# archon-execute-plans

You implement. You do **not** interrupt the user during this phase. If you hit a genuine blocker, stop, record it in the active plan's change log and a new child note, and surface it at the end — do not silently skip.

## Inputs

- `seedNoteId`.
- Required: `Plans/Plans-Phase-0-architecture` exists and its `## Execution order` section is populated.
- Required: `Plans/Plans-Phase-<N>-<topic>` children exist for every ordered phase.

If any are missing, stop and tell the user to run `archon-create-plans` first. Do not improvise plans during execution.

## Procedure

1. Read `Plans-Phase-0-architecture` in full. Cache the execution-order list.
2. For each phase in order:
   1. Fetch `Plans-Phase-<N>-<topic>` with `archon_get_note`.
   2. Implement the `## Execution checklist` items strictly in order.
   3. After completing each `[commit]`-tagged item, stage only the files that item changed and commit with message: `<Plans-Phase-<N>-<topic>>: <checklist item summary>`. Example: `Plans-Phase-2-sync-api: add /sync/push endpoint with tenant scoping`. Prefer per-file `git add <path>`; never `git add -A` during this flow.
   4. When the phase's `## Definition of done` is met, create a child note under the current `Plans-Phase-<N>` note titled `Summary` (markdown) using `archon_write_back_child` with `taskNoteId = <Plans-Phase-<N> noteId>`. Body:

```markdown
## Outcome
- Status: done | partial | blocked
- Commits: <list of hash + subject>
- Files touched: <list>
- Behaviors delivered: <bullets, plain English>

## Deviations from plan
- Anything the plan said but you didn't do, with reason.

## Follow-ups
- Items to address later (non-blocking).
```

Also bump the plan note itself (`patch_existing`) with a change-log line `rev <N> · executed`, preserving all prior content.

3. Between phases, print a one-line status to the user: `Phase <N> complete — <commit count> commits.`. No questions.
4. If a phase blocks (plan wrong, test failing, external dependency down):
   - Stop that phase.
   - Create a child under the blocked plan titled `Blocker — <short name>` documenting: what you tried, what failed, what you need. Use `archon_write_back_child`.
   - Still print a status line and surface the blocker at the end.
   - Do **not** start the next phase until the user unblocks.

## Rules of engagement

- **No user interruption.** The user gave you plans; use them. Make reasonable assumptions. Surface anything unusual in the Summary note, not mid-execution.
- **Commit hygiene.** One `[commit]` tag → one commit. Never skip hooks, never `--no-verify`, never `--amend` a prior commit. If a hook fails, fix the root cause, re-stage, new commit.
- **No scope creep.** Do not add features, refactors, or abstractions beyond the plan. If a refactor would help, write it in `Follow-ups`, don't do it.
- **Tests live, but don't run here.** Write the test files the plan specifies, but **do not run** the suite — running belongs to `archon-execute-test-cases`. (Smoke-checking a single file while debugging an implementation is fine; a full pass is not.)
- **Plan drift.** If during execution you discover the plan is wrong in a non-trivial way, stop the phase, write a `Blocker` child explaining the delta, and escalate. Do not rewrite the plan silently.

## Ambiguity handling

If an Archon MCP call returns ambiguous candidates (e.g. two projects with the same name), stop and surface candidates. Ambiguity is the one case where this skill does interrupt, because guessing could write to the wrong note tree.

## Finish

- After the last phase (or at the first hard block), print a multi-line summary: phases done, commits made, blockers, next action for the user.
- The orchestrator (`archon-use-seed-prompt`) will also write a session summary under the seed; your job is per-phase.