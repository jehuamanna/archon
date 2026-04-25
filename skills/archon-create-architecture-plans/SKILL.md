---
name: archon-create-architecture-plans
description: Act as a principal solution architect to turn architecture-extraction Prompts (Prompt-Phase-1..7-<topic>) into matching plan notes (Plans-Phase-1..7-<topic>) under a "Plans" container of the seed, then reserve an "Architecture" container for the downstream execution skill. Each plan covers extraction strategy, tooling, dependencies, execution order with [commit] boundaries, and risks/unknowns. Mirrors the 1:1 phase numbers and topic slugs from the prompts. Invoke when the user asks to create architecture plans from prompts, or run the architect phase of an architecture extraction.
---

# archon-create-architecture-plans

## Role

Principal solution architect for architecture-extraction work. Given the 7 `Prompt-Phase-N-<topic>` notes already produced under a seed, write 7 `Plans-Phase-N-<topic>` notes mirroring them 1:1 and reserve the `Architecture/` container that the execution skill will populate.

## Inputs

- A seed note (UUID or title) — must already have a `Prompts/` container with 7 `Prompt-Phase-1..7-<topic>` children, produced by `archon-create-architecture-prompts`.
- Optional: `subject` — free-form name to use in deliverable titles.

## Pre-flight

- Verify the seed has a `Prompts/` container with 7 phase children. If not, **stop** and tell the user to run `archon-create-architecture-prompts` first. Do not improvise plans without prompts.
- If the seed already has a `Plans/` container, stop and ask whether to patch in place, version-suffix (`Plans-v2`), or abort.
- If the seed already has an `Architecture/` container, stop and ask before re-reserving.

## Output structure

```
<Seed Note>
├── Prompts/                   ← already exists
│   └── Prompt-Phase-1..7-<topic>
├── Plans/                     ← container created by this skill
│   ├── Plans-Phase-1-context-and-scope
│   ├── Plans-Phase-2-components-and-hld
│   ├── Plans-Phase-3-data-architecture
│   ├── Plans-Phase-4-runtime-behavior
│   ├── Plans-Phase-5-contracts-and-interfaces
│   ├── Plans-Phase-6-nfrs-and-operations
│   └── Plans-Phase-7-cross-cutting-concerns
└── Architecture/              ← reserved (empty body, created by this skill)
    ← populated later by archon-create-architecture
```

## Naming conventions

- Container: `Plans` (capitalized, no phase).
- Phase notes: `Plans-Phase-<N>-<kebab-topic>`. Note: `Plans` (plural) — matches the existing `archon-create-plans` skill's conventions.
- Phase numbers and topic slugs **must** mirror the matching `Prompt-Phase-N-<topic>` 1:1. If a slug must change, rename the prompt first (via `archon-clarify-prompts` or by hand), then run this skill.

## Per-phase plan template (lock these sections in every Plans-Phase note)

- **Matching prompt** — note id of the `Prompt-Phase-N-<topic>` it mirrors.
- **Extraction strategy** — how to derive each deliverable from the code (grep targets, files to read, runtime traces to capture, ADRs to consult).
- **Tooling** — mermaid for diagrams, JSON Schema for event contracts, OpenAPI for HTTP, etc. Pick what actually fits the codebase.
- **Dependencies** — which earlier phase outputs are required.
- **Execution order (with `[commit]` boundaries)** — sub-artifact ordering within the phase. `[commit]` markers tell the downstream execution skill where to checkpoint progress (note creation, not git).
- **Risks / unknowns** — places the codebase will likely be silent. Mirror the matching prompt's `[NEEDS CLARIFICATION]` markers and add architect-level concerns.

## Cross-phase dependencies (record in `Plans/` container body)

```
1 (context) → 2 (components) → 3 (data) ┐
                              ↘ 4 (runtime) ─→ 5 (contracts) → 6 (NFRs) → 7 (cross-cutting)
```

Phases 3 and 4 may run in parallel after 2.

## Procedure

1. Resolve the seed note via `archon_execute_note`. On ambiguity, surface candidates and stop.
2. Pre-flight check — fetch the seed's children, verify a `Prompts/` container exists with 7 phase children. Verify no `Plans/` or `Architecture/` exists (or surface for user decision).
3. Read every `Prompt-Phase-N-<topic>` note to capture its deliverables, [NEEDS CLARIFICATION] markers, and acceptance criteria — these drive the matching plan.
4. **Discuss with the user** (or surface assumptions in auto mode): which `[NEEDS CLARIFICATION]` markers from the prompts will be carried forward as `Risks / unknowns` rather than blocking work?
5. Create the `Plans` container as a direct child of the seed.
6. Create `Plans-Phase-1..7-<topic>` notes as children of `Plans`, in order, each using the template above. Each plan body explicitly cites the matching prompt's note id.
7. Create the `Architecture` container as a sibling of `Plans` under the seed. Body is intentionally empty — explain it's reserved for the execution skill, and include the full deliverable tree for documentation.
8. **Stop.** Tell the user the next skill is `archon-create-architecture`.

## Discussion checkpoints

- Before step 5: review the prompts together; lock or edit phase boundaries.
- After step 7: walk the user through the plans, especially the cross-phase dependency graph and any `[NEEDS CLARIFICATION]` markers still open.

## Write-back

After completing steps 5–7, attach an `Execution result — <ISO date>` child to the seed via `archon_write_back_child`, listing:
- `Plans/` container note id and `Architecture/` container note id.
- All 7 `Plans-Phase-N` note ids and their cross-references to the matching prompts.
- Suggested next skill: `archon-create-architecture`.

## Safety

- Read-only against the codebase.
- All writes are scoped to the seed's project: `Plans/` container + 7 phase children + reserved `Architecture/` container + write-back.
- Do not write into `Architecture/` from here — that's the next skill's job.
- Phase numbers and topic slugs must exactly mirror the prompts.

## Failure modes to avoid

- Drifting topic slugs from the prompts.
- Inventing tooling choices that don't fit the codebase (e.g. proposing OpenAPI for an Electron IPC surface).
- Padding plans with hypothetical sub-artifacts the prompt didn't request.
- Starting execution. This skill stops at plans + reserved Architecture/.

## Cross-skill relationships

- **Upstream:** `archon-create-architecture-prompts` (Phase A of the extraction flow).
- **Downstream:** `archon-create-architecture` reads the `Plans/` container and produces the actual `Architecture/Arch-Phase-N-<topic>/<sub-artifact>` notes.
- **Orchestrator:** `archon-extract-architecture` runs Phase A → B → C end-to-end.

## Finish

Summary to the user: plans created, cross-phase dependencies, suggested next skill, write-back note id.