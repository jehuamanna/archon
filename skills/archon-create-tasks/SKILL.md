---
name: archon-create-tasks
description: Convert each approved Plans-Phase-<N>-<topic> note into a matching Tasks-Phase-<N>-<topic> note under a "Tasks" container on the seed, using the strict `- [ ] [TaskID] [P?] [Story?] Description with file path` format so archon-implement can iterate mechanically. Invoke when the user says "create tasks", "break plan into tasks", "run /tasks", or after archon-create-plans completes.
---

# archon-create-tasks

You convert an approved `Plans-Phase-<N>-<topic>` note into an executable task list. One task per small unit of work. Strict format so `archon-implement` can iterate mechanically.

## Role & tone

- You emit tasks, not prose. Every task has a fixed shape; deviations break downstream automation.
- You do not invent requirements — every task traces back to a Prompt-Phase FR / SC / US or a Plan LLD item.
- You may interrupt the user only to resolve a missing file path that the plan did not specify.

## Invocation triggers

- User says "create tasks", "break plan into tasks", "run /tasks".
- Called by `archon-use-seed-prompt` after `archon-create-plans` and before `archon-implement`.

## Inputs

- `seedNoteId` (required).
- Required prerequisites: `Plans/Plans-Phase-0-architecture` present with `## Execution order` populated, and a `Plans-Phase-<N>-<topic>` note for every numbered phase.

## Output structure

1. Resolve or create a direct child of the seed titled **`Tasks`** (markdown).
2. Under `Tasks`, create `Tasks-Phase-<N>-<topic>` for each matching `Plans-Phase-<N>`. Title mirrors the plan's N + topic verbatim.

## Task format (strict)

Every task MUST follow this format:

```
- [ ] [TaskID] [P?] [Story?] Description with file path
```

- **Checkbox**: always `- [ ]`. `archon-implement` ticks it to `- [X]` on completion.
- **TaskID**: `T001`, `T002`, … monotonic across the whole seed; never reset per phase.
- **[P]**: include only if the task is parallelizable (different files, no ordering dep).
- **[Story?]**: `[US1]`, `[US2]`, … — required for user-story phase tasks, omitted on Setup / Foundational / Polish phases.
- **Description**: ends with the exact file path touched.

## Phase structure inside Tasks-Phase-N

```
## Phase 1: Setup (Shared Infrastructure)
- [ ] T001 …
- [ ] T002 [P] …

## Phase 2: Foundational (Blocking Prerequisites)
- [ ] T003 …
- [ ] T004 [P] …

## Phase 3: User Story 1 — <title> (Priority: P1) — MVP
- [ ] T010 [P] [US1] …     ← tests first, if TDD
- [ ] T012 [US1] …          ← implementation

## Phase 4: User Story 2 — <title> (Priority: P2)
…

## Final Phase: Polish & Cross-Cutting Concerns
- [ ] TXXX …
```

Between phases, record a Checkpoint line: `Checkpoint: User Story N complete and independently testable`.

## Test-first handling

If the source `Prompt-Phase-<N>` note was generated with TDD mode (explicit request), inline test tasks appear BEFORE implementation tasks within each user-story phase. Each test task cites the FR-### / SC-### / US# it covers via the `Covers:` line on the corresponding test note (see `archon-create-test-cases`).

## Commit boundaries

Tasks that are natural commit points are tagged `[commit]` at end of line:

```
- [ ] T014 [US1] Implement UserService in src/services/user.py  [commit]
```

`archon-implement` commits once per `[commit]`-tagged task with message `<Plans-Phase-<N>-<topic>>: <task summary>`.

## Dependencies section

Each Tasks-Phase-N note ends with:

```
## Dependencies & Execution Order
- Phase 1 → unblocks Phase 2
- Phase 2 → unblocks all user-story phases
- User Story N: depends on Foundational; may cross-reference prior user stories
```

## Hard rules

- Never emit tasks without a file path.
- Never merge two unrelated changes into one task.
- Never introduce tasks not reachable from a `Prompt-Phase-<N>` acceptance criterion or a Plan LLD item.
- TaskIDs are monotonic across the whole seed; never reset between phases.

## Finish

- Summary: per phase, count of Setup / Foundational / Story / Polish tasks, and count of `[commit]` boundaries.
- Flag any Plan LLD item that produced zero tasks — that's a gap `archon-analyze` will catch.

## Failure modes to avoid

- Emitting a task without a file path ("implement UserService" is wrong; "implement UserService in src/services/user.py" is right).
- Renumbering or reusing TaskIDs across phases.
- Dropping the `[Story?]` tag on user-story tasks — `archon-implement` uses that to preserve story independence.
- Inventing tasks to "round out" a phase that the plan did not specify.

## See also

- Template reference: `github/spec-kit/main/templates/tasks-template.md`
- Consumer: `archon-implement` (formerly `archon-execute-plans`).