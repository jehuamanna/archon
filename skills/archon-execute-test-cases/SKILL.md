---
name: archon-execute-test-cases
description: Run the test cases specified in TestCase-Phase-<N> notes (unit, integration, e2e via Playwright) and write results as children of a "Test Results" container under the seed. No user interruption. Invoke when the user asks to run, execute, or validate test cases for an Archon seed prompt.
---

# archon-execute-test-cases

You run tests. You do **not** interrupt the user during this phase. Results go under `Test Results` as children of the seed.

## Inputs

- `seedNoteId`.
- Required: `Test Cases/TestCase-Phase-<N>-*` children exist.
- Required: the implementation from `archon-execute-plans` is on disk.

## Pre-flight

1. Detect test runners from the repo:
   - Node: `package.json` scripts (`test`, `test:int`, `test:e2e`), `jest` / `vitest` / `playwright` config.
   - Python: `pytest`, `tox`, `pyproject.toml`.
   - Go: `go test ./...`.
   - Other: look for a `Makefile` target or obvious runner config.
2. If Playwright is required by a `TestCase-Phase-<N>` note but not installed, **install it now** (this is the point where the test-case spec says setup happens), using the exact commands listed in that note's `## Setup`. If those commands were not listed, fall back to `npx playwright install` + dependency installs inferred from `package.json`. Record the install commands you ran in the result note.
3. Resolve or create a direct child of the seed titled **`Test Results`** (markdown).

## Procedure

For each `TestCase-Phase-<N>-<topic>` in phase order:

1. Run each test level in order: **unit → integration → e2e → non-functional**. Stop at the first failing level only if the test-case note explicitly says so; otherwise continue to the next level and report all failures.
2. Capture:
   - Exact command run
   - Exit code
   - Pass / fail / skipped counts
   - Failure details (first ~20 lines of each failure, truncated)
   - Playwright trace/screenshot paths (if any)
   - Coverage % if the runner reports it
3. Create a child under `Test Results` titled `TestResult-Phase-<N>-<ISO-date>-<runId>`. Body:

```markdown
(standard metadata header)

## Context
- Commit: <git rev-parse HEAD>
- Branch: <current branch>
- Host: <uname>
- Test-case note: <TestCase-Phase-<N> noteId>
- Plan note: <Plans-Phase-<N> noteId>

## Commands
- <exact commands, one per line>

## Results
- Unit: <pass/fail/skipped counts>, duration <s>
- Integration: ...
- E2E: ...
- Non-functional: ...
- Coverage: <% if available>

## Failures
For each failure:
### <test id / title>
- Level: unit | integration | e2e | nf
- Expected: ...
- Actual: ...
- Log (truncated):
  ```
  ...
  ```
- Likely cause: <your one-line hypothesis>

## Artifacts
- Playwright traces, screenshots, HAR files — list paths. Do not upload them; they stay local.

## Verdict
- Phase <N>: PASS | FAIL | FLAKY
- Reasoning: <one line>
```

4. Between phases, print a one-line status: `Phase <N> tests: <pass>/<total>`.

## Rules

- **No user interruption** unless an Archon MCP call is ambiguous.
- **Do not modify code to make tests pass** in this phase. If a test fails because the implementation is wrong, record it and keep going. Fixing is the job of `archon-fix-bugs`.
- **Do not auto-retry flaky tests silently.** Run once. If a test is obviously infrastructure-flaky (network, timing), mark it FLAKY in the verdict and include the observation in `Failures`.
- **Do not skip tests the spec requires.** If a test can't run (e.g. missing service), mark it skipped with a reason; do not delete or comment out.
- **Never edit test files** to weaken assertions. That is falsifying the audit trail.

## Finish

- Overall summary: per phase pass/fail counts, list of FAIL phases, aggregate verdict.
- If any phase failed, suggest invoking `archon-fix-bugs` with `seedNoteId` and the failing phase numbers.