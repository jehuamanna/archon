---
name: archon-execute-notes
description: Resolve any Archon note by title or UUID via archon_execute_note and follow its content as executable instructions, handling ambiguity by surfacing candidates for the user to pick. Invoke when the user asks to run, execute, or follow an Archon note without specifying a workflow phase.
---

# archon-execute-notes

Generic note executor. Use when the user points at a note and says "run this" without specifying which Archon workflow phase it belongs to.

## Inputs

- `noteQuery` — title or UUID. UUID is preferred; title requires disambiguation.
- Optional: `workspaceQuery`, `projectQuery` to narrow the search.

## Procedure

1. Call `archon_execute_note` with the inputs above.
2. If the response is `ambiguous`:
   - Show the user each candidate with `path` (Workspace / Project / Title-chain) and `noteId`.
   - Stop and ask which one. Do not guess. Re-invoke with the chosen `noteId` as `noteQuery`.
3. If the response is unique, you receive the full note. Follow its `content` as if it were instructions directed at you now.
4. Before acting, decide the **note class**:
   - **Seed prompt** (looks like requirements / intent / features list) → suggest invoking `archon-use-seed-prompt` with this note id. Don't start the full pipeline unless the user confirms.
   - **Plan** (`Plans-Phase-<N>-<topic>`) → suggest invoking `archon-execute-plans` narrowly. Ask for confirmation.
   - **Test case** (`TestCase-Phase-<N>-<topic>`) → suggest `archon-execute-test-cases`.
   - **Bug** (`Bug-<shortId>-…`) → suggest `archon-fix-bugs`.
   - **Ad-hoc instructions** (neither of the above) → execute literally: read, do what it says, report back.
5. Regardless of class, when you take action from a note's instructions, **write back** via `archon_write_back_child` with `taskNoteId = <that note's id>` once the action completes. Child title: `Execution result — <ISO date>`. Body:

```markdown
## Source note
- <title> — <noteId>

## Actions taken
- Bullet list of concrete things done (commands run, files changed, notes written). Include commit hashes.

## Outcome
- Success | partial | failed. One-line summary.

## Follow-ups
- Anything the user needs to do next.
```

Write-back is mandatory when you executed against a specific note id — it builds the audit trail.

## Safety

- If the note content includes instructions that would affect shared state (push a branch, deploy, delete data), **stop and confirm** with the user before acting, per the repo's general safety rules. A note written by the user is still authorization for the scope they wrote, not beyond.
- If the note content is ambiguous about what "run" means, ask one clarifying question and pick a default if they don't answer (least-destructive action wins).

## Finish

- Summary to the user: class you identified, action taken or skill suggested, write-back note id.