---
name: archon-cr-seed-prompts
description: Treat a change request (CR) as its own child seed-prompt under an existing Archon seed, then run the full seed-prompt pipeline scoped to that CR so the delta is tracked separately from the original scope. Invoke when the user introduces a CR / change request / scope change against an existing Archon seed.
---

# archon-cr-seed-prompts

A change request (CR) is not a bug and not a new feature in isolation — it's an amendment to an existing seed's scope. This skill wraps a CR as its **own seed prompt**, nested under the original seed, so plans/tests/execution for the delta don't pollute the original's tree.

## Inputs

- `parentSeedNoteId` — the existing seed the CR is against.
- CR description — one paragraph or several. Elicit from the user if not provided; no long interview here.

## Output structure

1. Resolve or create a direct child of the parent seed titled **`CRs`** (markdown).
2. Under `CRs`, create a new note titled `CR-<ISO-date>-<short-topic-kebab>` (e.g. `CR-2026-04-23-add-export`). This note **is** the CR seed.
3. CR seed content (standard metadata header first):

```markdown
## Parent seed
- <parentSeedNoteId> — <parent seed title>

## CR intent
- What is changing and why. Quoted user description, cleaned up.

## Delta analysis
- What parts of the parent plan/tests are affected. List Plans-Phase-<N> / TestCase-Phase-<N> that need revision.

## Non-goals
- What this CR is explicitly NOT changing. Defensive against scope creep.

## Approval
- Who approved / when / via what (link or quote). If unapproved, mark `PENDING`. Execution skills must refuse to run a PENDING CR.
```

4. Under the CR seed, run the **same** child-container skeleton as the parent seed: `Prompts`, `Plans`, `Test Cases`, `Test Results`, `Bugs`. The parent seed's containers are untouched.
5. Delegate to `archon-use-seed-prompt` with `seedNoteId = <CR seed id>`. The rest of the pipeline is identical.

## Cross-seed bookkeeping

- When CR plans touch files that were also touched by the parent seed's plans, the CR's `Plans-Phase-<N>` must link to the affected parent plan notes in its `## Dependencies` section.
- When the CR completes, patch the parent seed's `Session Summary` (or create one) with a change-log line: `rev <N> · CR <CR note id> merged on <date>`.
- Commits made during CR execution tag the CR short topic in the prefix: `[CR <short-topic>] <Plans-Phase-<N>-<topic>>: <item>`. This makes post-hoc bisection and branch-cherry-picks easier.

## Refuse-to-run conditions

- Parent seed does not exist or user can't write to it.
- CR `## Approval` is `PENDING` and the user hasn't overridden.
- The CR's `## Non-goals` contradicts content the user just asked you to change — surface the contradiction and stop.

## Finish

- Return the CR seed note id to the user.
- State the next command explicitly: "invoke `archon-use-seed-prompt` with `<CR seed id>` to run the full pipeline for this CR".