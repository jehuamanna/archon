---
name: archon-analyze
description: Read-only cross-artifact consistency check across Prompt-Phase, Plans-Phase, Tasks-Phase, TestCase-Phase, and the Constitution. Produces an Analysis-Phase-<N>-<topic> findings report that gates archon-implement (CRITICAL findings block execution). Invoke when the user says "analyze", "check consistency", or "run /analyze", or before archon-implement runs.
---

# archon-analyze

You analyse. You do NOT modify any other note or file during this phase. Output goes to a new `Analysis-Phase-<N>-<topic>` child under the seed.

## Role & tone

- Critical reader. Your job is to find gaps, not to close them.
- Deterministic: rerunning without source changes must produce the same finding IDs and counts.
- You never patch another note; you surface problems and let the user (or an upstream skill) fix them.

## Invocation triggers

- User says "analyze", "check consistency", "run /analyze".
- Called by `archon-use-seed-prompt` after `archon-create-tasks` and before `archon-implement`.

## Inputs

- `seedNoteId` (required).
- Required: `Prompts/`, `Plans/`, `Tasks/`, and the `Archon / Constitution` project all exist.
- Optional: `TestCase-Phase-<N>` notes; if absent, their axis is skipped.

## Six detection passes

For each in-scope phase topic, run:

**A. Duplication** — near-duplicate FRs across Prompt-Phase notes. Flag the lower-quality phrasing for consolidation.

**B. Ambiguity** — vague adjectives without measurable criteria (`fast`, `scalable`, `secure`, `robust`, `intuitive`). Flag unresolved placeholders (`TODO`, `TBD`, `???`, `<placeholder>`, `[NEEDS CLARIFICATION]`).

**C. Underspecification** — FRs missing objects or measurable outcomes; user stories missing acceptance criteria; tasks referencing files or components not in the plan's LLD.

**D. Constitution Alignment** — any requirement or plan element conflicting with a MUST principle from `Archon / Constitution / Core Principles` or `Project Invariants`. Constitution conflicts are always CRITICAL.

**E. Coverage Gaps** — FRs with zero mapped tasks; tasks with no FR / SC / US mapping; SCs requiring buildable work (perf, security, availability) not reflected in tasks; FRs with no covering TestCase (if TestCase-Phase-N present).

**F. Inconsistency** — terminology drift (same concept named differently across notes); data entities in Plan but absent from Prompt; task ordering contradictions; conflicting tech decisions between `Plans-Phase-0` and `Plans-Phase-<N>`.

## Severity

- **CRITICAL** — Constitution MUST violated, missing core artifact, FR with zero coverage blocking baseline functionality.
- **HIGH** — Duplicate or conflicting requirements, ambiguous security / performance attribute, untestable acceptance criterion.
- **MEDIUM** — Terminology drift, missing non-functional task coverage, underspecified edge case.
- **LOW** — Wording improvements, minor redundancy.

Cap findings at **50**. Overflow is summarized as a single line.

## Output — `Analysis-Phase-<N>-<topic>` note body

```
(standard metadata header)

## Specification Analysis Report

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| A1 | Duplication | HIGH | Prompt-Phase-2 FR-003 + FR-007 | Both describe the same upload flow | Merge phrasing; keep FR-003 |
| C2 | Underspecification | HIGH | Tasks-Phase-3 T014 | Task references src/util/lock.py not in Plan LLD | Add lock.py to Plans-Phase-3 Design or remove task |
…

## Coverage Summary

| Requirement Key | Has Task? | Task IDs | Notes |
|-----------------|-----------|----------|-------|
| FR-001 | Yes | T005, T006 | |
| FR-003 | No  | —         | NO COVERAGE |

## Constitution Alignment Issues

(if any — always CRITICAL)

## Unmapped Tasks

(tasks with no FR / SC / US linkage)

## Metrics

- Total Requirements: <N>
- Total Tasks: <N>
- Coverage %: <N>%
- Ambiguity count: <N>
- Duplication count: <N>
- CRITICAL issues: <N>

## Next Actions

- If CRITICAL: blocks `archon-implement`. Fix before proceeding.
- If only MEDIUM / LOW: user may proceed; suggest improvements.
```

## Hard rules

- **NEVER modify** any other note or file during analysis.
- **NEVER hallucinate** a section that doesn't exist — report it as missing.
- Constitution violations are always CRITICAL.
- Rerunning without source changes must produce the same finding IDs and counts (deterministic).

## How this gates `archon-implement`

`archon-implement` reads the most recent `Analysis-Phase-<N>` note. If any finding has severity `CRITICAL`, execution is refused and the user is directed back to fix the upstream spec / plan / task.

## Failure modes to avoid

- Silently editing a Prompt / Plan / Task note "to fix" an issue — that defeats the audit trail.
- Hallucinating a MUST principle that is not in the Constitution.
- Skipping the Coverage Summary table — that's the input `archon-implement` relies on most.

## See also

- Reference: spec-kit `/speckit.analyze` (`github/spec-kit/main/templates/commands/analyze.md`)
- Constitution: `Archon / Constitution`
- Consumer: `archon-implement`.