---
name: archon-fix-bugs
description: Triage and fix bugs surfaced from failing tests or user reports in an Archon seed-prompt workflow, keeping each bug as a child note under a "Bugs" container on the seed, grouped by topic. Invoke when the user reports a bug, asks Claude to fix failing tests, or says "fix bugs in <seed>".
---

# archon-fix-bugs

Bugs are first-class artifacts of the seed-prompt workflow. Every bug gets a note, a fix attempt, and a verdict. Bugs are grouped by **topic** (matching the phase topic they came from) under a `Bugs` container on the seed.

## Inputs

- `seedNoteId`.
- One of:
  - A failing `TestResult-Phase-<N>` note id (derive the phase topic from it).
  - A user-provided bug description (ask for phase topic if not obvious).

## Output structure

1. Resolve or create a direct child of the seed titled **`Bugs`** (markdown).
2. Under `Bugs`, group by topic. Create (if missing) a child per topic titled **`Bugs-<topic-kebab-case>`** — mirrors the plan/test-case topic. E.g. `Bugs-sync-api`.
3. Under each `Bugs-<topic>`, create one child per bug, titled `Bug-<shortId>-<one-line-summary>`. `<shortId>` is a 6-char lowercase hex derived from a hash of the first-reported timestamp + topic (simple, collision-tolerant, greppable).

## Per-bug note body (standard metadata header first)

```markdown
## Report
- Reporter: <user | TestResult-Phase-<N> noteId>
- First seen: <ISO>
- Phase topic: <matches Bugs-<topic>>
- Related plan: <Plans-Phase-<N> noteId>
- Related test case: <TestCase-Phase-<N> noteId> (if test-driven)

## Symptom
- What you observe, verbatim. Error messages, screenshots paths, failing assertions.

## Reproduction
- Commands / steps to reproduce, minimum viable. Commit hash.

## Root cause
- Fill after investigation. If unknown, say so.

## Fix
- Exact change(s) made: files, diffs (pasted or referenced by commit).
- Why this is the right fix (not just a symptom patch).

## Verification
- Tests added or unskipped: list IDs.
- Test run commands + pass/fail after fix.
- Commit(s) that contain the fix.

## Status
- Open | Fixed | Wontfix | Duplicate-of-<Bug-shortId>
```

## Procedure

1. **Triage.** For each incoming bug (from a TestResult or user report), create the note in `Open` status with Report + Symptom + Reproduction filled. If you can't reproduce, set Status to `Open` with a `Reproduction` subsection explicitly saying "Not yet reproduced — need <X>" and surface that to the user.
2. **Investigate.** Read the relevant plan and test-case notes. Look for the smallest change that addresses the root cause, not the smallest change that makes the symptom disappear.
3. **Fix.** Implement. Commit with message `Bug-<shortId>: <summary>`. Never amend prior commits. If hooks fail, diagnose and fix root cause — do not skip hooks.
4. **Verify.** Re-run the tests that triggered the bug. Add a new test if the original suite missed the case (this is mandatory for bugs caused by missing coverage).
5. **Close.** Update the bug note via `patch_existing`, fill `Root cause`, `Fix`, `Verification`, set `Status: Fixed`, bump revision, change-log line: `rev <N> · fixed via <commit-hash>`.
6. If fixing bug A surfaces bug B, open a new bug under the same or another topic. Do not widen the current fix.

## When not to fix

- If the bug is actually a spec error (plan or test case is wrong), set Status to `Wontfix` with reason, and create a revision on the relevant Plan or TestCase note explaining the spec correction. Commit code only after the spec is updated.
- If the bug is a duplicate, set Status `Duplicate-of-<shortId>` and close without code changes.

## Interruption policy

- User interruption is fine here — bug fixing is inherently interactive. Clarifying repro steps, scope of fix, or priority is expected.
- But don't block the user: if they say "fix P1 only", triage and defer P2+ by leaving them `Open` with a note.

## Finish

- Summary: bugs opened, fixed, deferred, with links. Re-run the failing test phase if requested; otherwise invite the user to invoke `archon-execute-test-cases` again.