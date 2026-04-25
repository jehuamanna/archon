---
name: archon-extract-architecture
description: End-to-end architecture extraction — read a seed note about a codebase or feature, then chain through Prompts (BA), Plans (architect), and Architecture (execution) to produce mermaid diagrams, ERDs, sequence diagrams, contracts, NFR tables, and ADRs as Archon notes. Orchestrates archon-create-architecture-prompts → archon-create-architecture-plans → archon-create-architecture across 7 fixed dimension-phases (context, components, data, runtime, contracts, NFRs, cross-cutting). Invoke when the user asks to extract architecture, document architecture, reverse-engineer system design end-to-end, or run the architecture-extraction phase of an Archon workflow.
---

# archon-extract-architecture

## Role

Orchestrator for end-to-end architecture extraction. Given a seed describing a target subject (codebase, feature, service, system), drive three sub-skills in sequence:

1. `archon-create-architecture-prompts` — Phase A — write 7 BA prompts.
2. `archon-create-architecture-plans` — Phase B — write 7 architect plans + reserve the `Architecture/` container.
3. `archon-create-architecture` — Phase C — execute the plans and write the actual architecture deliverables (Arch-Phase-N containers + sub-artifact notes).

This skill is the single entry point users hit when they want a complete architecture document. The three sub-skills are also independently invokable for partial runs (re-running just Phase C after a clarification, etc.).

## Inputs

- A seed note (UUID or title) describing the target subject. Title typically `Extract Architecture — <subject>`.
- Optional: `subject` — free-form name to use in deliverable titles.
- Optional: `mode` — `auto` (run end-to-end without checkpoints, recommended in auto mode) or `interactive` (pause for discussion between phases).

## Phase scheme (fixed, 7 dimensions)

The orchestrator inherits the same 7 dimension-phases from its sub-skills. Phase numbers and topic slugs are stable across `Prompt-Phase-N`, `Plans-Phase-N`, and `Arch-Phase-N` for any given N.

1. `context-and-scope`
2. `components-and-hld`
3. `data-architecture`
4. `runtime-behavior`
5. `contracts-and-interfaces`
6. `nfrs-and-operations`
7. `cross-cutting-concerns`

Cross-phase dependencies:

```
1 (context) → 2 (components) → 3 (data) ┐
                              ↘ 4 (runtime) ─→ 5 (contracts) → 6 (NFRs) → 7 (cross-cutting)
```

Phases 3 and 4 may run in parallel after 2.

## Output hierarchy under the seed

```
<Seed Note>
├── Prompts/                    ← created by archon-create-architecture-prompts
│   └── Prompt-Phase-1..7-<topic>
├── Plans/                      ← created by archon-create-architecture-plans
│   └── Plans-Phase-1..7-<topic>
├── Architecture/               ← reserved by plans skill, populated by archon-create-architecture
│   └── Arch-Phase-1..7-<topic>/
│       └── <sub-artifacts>
└── Execution result — <date>   ← write-back per sub-skill + final orchestrator summary
```

## Procedure

1. Resolve the seed via `archon_execute_note`. On ambiguity, surface candidates and stop.
2. Confirm classification — must be a seed prompt (requirements / intent for an architecture-extraction subject). If it isn't, suggest `archon-execute-notes` instead.
3. **Mode resolution** — `auto` if the harness signals auto mode or the user passes `mode=auto`; otherwise `interactive`.
4. **Resume detection** — fetch the seed's children. Skip any phase whose layer is already populated:
   - `Prompts/` exists → skip Phase A.
   - `Plans/` exists → skip Phase B.
   - `Architecture/` populated with at least one `Arch-Phase-N` child → ask whether to abort, patch, or version-suffix.

   If skipping, surface the resume plan to the user before continuing.
5. **Phase A — Prompts** (skip if `Prompts/` already exists):
   1. Invoke `archon-create-architecture-prompts` against the seed.
   2. After completion, surface the count of `[NEEDS CLARIFICATION]` markers per phase.
   3. **Interactive checkpoint** (skipped in auto mode): "review prompts before plans?" — give the user a chance to edit prompts or run `archon-clarify-prompts`.
6. **Phase B — Plans** (skip if `Plans/` already exists):
   1. Invoke `archon-create-architecture-plans` against the seed.
   2. After completion, summarise the 7 plans and the cross-phase dependency graph.
   3. **Interactive checkpoint** (skipped in auto mode): "proceed to execution?" — give the user a chance to edit plans.
7. **Phase C — Architecture** (skip if `Architecture/` is already populated):
   1. Invoke `archon-create-architecture` against the seed.
   2. The execution skill runs end-to-end without further interruption (per its own no-interrupt policy).
8. After Phase C completes (or at first hard block), write a final orchestrator-level summary as a child of the seed.

## Mode behavior

- **`auto`** — run all three sub-skills back-to-back, no interactive checkpoints. Useful when the seed is well-defined or the user wants speed. Each sub-skill still does its own pre-flight and writes its own write-back child. Even in auto mode, log explicit subject/audience/depth assumptions in the orchestrator's final summary.
- **`interactive`** — pause between Phase A→B and Phase B→C. At each pause, summarise what was produced and surface open questions. Useful for first-time extractions or when the seed is ambiguous.

## Discussion checkpoints

- **Before Phase A** (always): confirm subject, target depth, audience, goal. Auto mode: log the assumptions explicitly in the orchestrator's final summary.
- **Between A and B** (interactive only): review prompts, especially `[NEEDS CLARIFICATION]` markers. Optionally run `archon-clarify-prompts`.
- **Between B and C** (interactive only): review plans, especially the cross-phase dependency graph and any architect-level risks.
- **None during C**: the execution sub-skill mirrors `archon-implement`'s no-interrupt policy.

## Pre-flight

- If a sub-skill is missing (not installed locally), surface that and stop — do not duplicate sub-skill logic in the orchestrator.
- If the seed already has `Prompts/`, `Plans/`, or `Architecture/` children, use the resume policy in step 4. Don't silently overwrite.

## Sub-skill invocation

The orchestrator delegates real work to the three sub-skills. It does not duplicate their logic. If a sub-skill blocks (returns a Blocker note), the orchestrator stops at that phase and surfaces the blocker — does not advance to the next phase.

## Write-back

After Phase C (or first hard block), attach an orchestrator-level `Execution result — <ISO date>` child to the seed via `archon_write_back_child`, summarising:
- Mode used (`auto` or `interactive`).
- Sub-skill execution results (note ids of each sub-skill's own write-back).
- Total counts: prompts, plans, arch-phase containers, sub-artifacts.
- Any blockers surfaced by Phase C.
- Final state of `[NEEDS CLARIFICATION]` markers (resolved / preserved).
- Suggested next action.

## Safety

- **Read-only against the codebase end-to-end.** No code changes, no commits, no branch operations.
- All writes are scoped to the seed's project: `Prompts/`, `Plans/`, `Architecture/`, sub-artifact notes, write-back children, blocker children.
- Sub-skills enforce their own safety; this orchestrator inherits.
- If a sub-skill blocks, the orchestrator stops and surfaces the blocker — does not advance to the next phase.

## Cross-skill relationships

- **Sub-skills:** `archon-create-architecture-prompts`, `archon-create-architecture-plans`, `archon-create-architecture`.
- **Sibling:** `archon-clarify-prompts` can be inserted between Phase A and B in interactive mode.
- **Differentiator vs `archon-create-prompts` / `archon-create-plans` / `archon-implement`:** the generic skills take a free-form seed and let the BA / architect / executor choose phases, plus `archon-implement` produces git commits. This orchestrator and its sub-skills bake in the 7-dimension architecture phase scheme and produce Archon notes (not commits).

## Failure modes to avoid

- Skipping the discussion checkpoint about subject/audience/depth — even in auto mode, log explicit assumptions.
- Running Phase B before Phase A's prompts have any `[NEEDS CLARIFICATION]` resolved — at least surface the count.
- Treating Phase C as a git-commit flow (it's notes-only).
- Inventing facts in any phase — preserve `[NEEDS CLARIFICATION]` until a human resolves them.
- Re-running Phase A when `Prompts/` already exists — use the resume policy in pre-flight instead.

## Finish

Final orchestrator summary to the user:
- Mode used.
- Phase-by-phase counts (prompts, plans, sub-artifacts).
- Open `[NEEDS CLARIFICATION]` markers preserved in deliverables.
- Blockers (if any).
- Write-back note ids per sub-skill plus orchestrator.
- Suggested next step.