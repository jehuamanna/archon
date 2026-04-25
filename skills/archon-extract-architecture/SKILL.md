---
name: archon-extract-architecture
description: Extract a complete architectural picture (system or component) from a codebase or feature, decomposed into 7 dimension-phases. Produces Prompts (BA) and Plans (architect) under a seed note, reserving an Architecture/ deliverable bucket for a downstream execution skill. Invoke when the user asks to extract architecture, document architecture, reverse-engineer system design, or run the architecture-extraction phase of an Archon workflow.
---

# archon-extract-architecture

## Role

Acts as a principal architect doing reverse-architecture work: read a codebase / feature and lay out a phased extraction plan that yields HLD, LLD, diagrams, data model, runtime behavior, contracts, NFRs, and cross-cutting context. Stops after producing Prompts and Plans — execution (the actual `Arch-Phase-*` deliverable notes) is left to a downstream `archon-implement`-style skill.

## Inputs

- A seed note (UUID or title) describing the target subject — a codebase, a feature, or a service. Title typically `Extract Architecture — <subject>`.
- Optional: `subject` (free-form name to use in deliverable titles).

## Phase scheme (fixed)

The skill always produces these 7 phases. Phase numbers are stable across Prompts / Plans / Architecture layers.

1. `context-and-scope`
2. `components-and-hld`
3. `data-architecture`
4. `runtime-behavior`
5. `contracts-and-interfaces`
6. `nfrs-and-operations`
7. `cross-cutting-concerns`

Cross-phase dependencies (drives downstream execution order):

```
1 (context) → 2 (components) → 3 (data) ┐
                              ↘ 4 (runtime) ─→ 5 (contracts) → 6 (NFRs) → 7 (cross-cutting)
```

Phases 3 and 4 can run in parallel after 2 — record this in the plans so an `archon-implement`-style execution skill can parallelize.

## Output hierarchy under the seed

```
<Seed Note: "Extract Architecture — <subject>">
├── Prompts/                              ← container note (folder-like)
│   ├── Prompt-Phase-1-context-and-scope
│   ├── Prompt-Phase-2-components-and-hld
│   ├── Prompt-Phase-3-data-architecture
│   ├── Prompt-Phase-4-runtime-behavior
│   ├── Prompt-Phase-5-contracts-and-interfaces
│   ├── Prompt-Phase-6-nfrs-and-operations
│   └── Prompt-Phase-7-cross-cutting-concerns
├── Plans/                                ← container note
│   ├── Plans-Phase-1-context-and-scope
│   ├── Plans-Phase-2-components-and-hld
│   ├── Plans-Phase-3-data-architecture
│   ├── Plans-Phase-4-runtime-behavior
│   ├── Plans-Phase-5-contracts-and-interfaces
│   ├── Plans-Phase-6-nfrs-and-operations
│   └── Plans-Phase-7-cross-cutting-concerns
└── Architecture/                         ← reserved; populated by downstream execution skill
    ├── Arch-Phase-1-context-and-scope
    ├── Arch-Phase-2-components-and-hld
    │   ├── hld
    │   ├── lld
    │   ├── diagrams                      (mermaid: c4-context, container, component)
    │   └── module-dependency-graph
    ├── Arch-Phase-3-data-architecture
    │   ├── erd
    │   ├── datatypes
    │   ├── storage-and-indexes
    │   ├── caching-and-invalidation
    │   └── migration-strategy
    ├── Arch-Phase-4-runtime-behavior
    │   ├── sequence-diagrams
    │   ├── state-machines
    │   ├── concurrency-model
    │   ├── failure-modes
    │   └── lifecycle
    ├── Arch-Phase-5-contracts-and-interfaces
    │   ├── api-surface
    │   ├── event-schemas
    │   ├── authn-authz-model
    │   └── trust-boundaries
    ├── Arch-Phase-6-nfrs-and-operations
    │   ├── functional-requirements
    │   ├── non-functional-requirements
    │   ├── nfr-to-mechanism-map
    │   ├── deployment-topology
    │   ├── observability
    │   ├── scaling-and-bottlenecks
    │   ├── dr-and-backup
    │   └── security-and-compliance
    └── Arch-Phase-7-cross-cutting-concerns
        ├── glossary
        ├── adrs
        ├── assumptions-and-constraints
        └── risks-and-tech-debt
```

## Naming conventions

| Layer | Pattern | Example |
|---|---|---|
| Containers | `Prompts`, `Plans`, `Architecture` (capitalized, no phase) | `Prompts` |
| Prompt note | `Prompt-Phase-<N>-<kebab-topic>` | `Prompt-Phase-3-data-architecture` |
| Plan note | `Plans-Phase-<N>-<kebab-topic>` (note: `Plans`, plural — matches existing `archon-create-plans`) | `Plans-Phase-3-data-architecture` |
| Arch deliverable | `Arch-Phase-<N>-<kebab-topic>` | `Arch-Phase-3-data-architecture` |
| Arch sub-artifact | lowercase kebab, no phase prefix | `erd`, `sequence-diagrams` |

Rules:
- Phase number is stable across layers — `Prompt-Phase-3` ↔ `Plans-Phase-3` ↔ `Arch-Phase-3`. Renumbering one means renumbering all three.
- Topic slug is identical across the three layers for the same phase. Don't drift wording.
- Lowercase kebab for the topic; capitalized prefix segments (`Prompt-Phase`, `Plans-Phase`, `Arch-Phase`).
- No hard-coded numbers in sub-artifact names — they live under their `Arch-Phase-N-*` parent, so adding/removing one doesn't cascade.

## Per-phase deliverable template (lock these in the prompt notes)

| Phase | Sub-artifacts (Arch-Phase-N children) |
|---|---|
| 1 context-and-scope | `scope-statement`, `system-context-diagram`, `glossary-seed`, `external-dependencies`, `in-scope-out-of-scope` |
| 2 components-and-hld | `hld`, `lld`, `diagrams` (c4-context / container / component, mermaid), `module-dependency-graph` |
| 3 data-architecture | `erd`, `datatypes`, `storage-and-indexes`, `caching-and-invalidation`, `migration-strategy` |
| 4 runtime-behavior | `sequence-diagrams`, `state-machines`, `concurrency-model`, `failure-modes`, `lifecycle` |
| 5 contracts-and-interfaces | `api-surface`, `event-schemas`, `authn-authz-model`, `trust-boundaries` |
| 6 nfrs-and-operations | `functional-requirements`, `non-functional-requirements`, `nfr-to-mechanism-map`, `deployment-topology`, `observability`, `scaling-and-bottlenecks`, `dr-and-backup`, `security-and-compliance` |
| 7 cross-cutting-concerns | `glossary`, `adrs`, `assumptions-and-constraints`, `risks-and-tech-debt` |

## What each `Prompt-Phase-N-<topic>` note contains (BA phase)

- **Scope** — what this phase covers and what it explicitly defers.
- **Inputs** — code paths, prior phases' outputs, external docs.
- **Deliverables** — exact list of `Arch-Phase-N` sub-artifact note titles to be produced (from the table above).
- **Questions for the user** — `[NEEDS CLARIFICATION]` markers where the codebase can't answer (e.g., "is X a hard SLA or aspirational?", "is the legacy column still load-bearing?").
- **Acceptance criteria** — what "done" looks like for this phase.

## What each `Plans-Phase-N-<topic>` note contains (architect phase)

- **Extraction strategy** — how to derive each deliverable from the code (grep targets, files to read, runtime traces to capture, ADRs to consult).
- **Tooling** — mermaid for diagrams, JSON Schema for event contracts, OpenAPI for HTTP, Plant ER for ERD if mermaid is too thin, etc.
- **Dependencies** — which earlier phase outputs are required (e.g., Phase 5 contracts depend on Phase 2 component map).
- **Execution order** — sub-artifact ordering within the phase, with `[commit]` boundaries if you want a downstream execution skill to commit between artifacts.
- **Risks/unknowns** — places the codebase will likely be silent and require human confirmation. Mirror the matching prompt's `[NEEDS CLARIFICATION]` markers and add architect-level concerns (e.g., "deployment topology is inferred from CI config — verify with infra owner").

## Procedure

1. Resolve the seed note via `archon_execute_note` (UUID or title; handle ambiguity by listing candidates and stopping).
2. Confirm classification: must be a seed prompt (requirements / intent for an architecture-extraction subject). If it isn't, suggest `archon-execute-notes` instead.
3. **Discuss with the user** before writing:
   - Confirm the subject (codebase root path / feature scope).
   - Surface obvious phase-scope questions ("Is this system-level or single-component?", "Audience — internal engineers, new joiners, or external consumers?").
   - Lock the 7-phase scheme. Only mark a sub-artifact `N/A` (don't drop the phase) when the subject genuinely doesn't have it (e.g., a stateless library has no `state-machines` — note `state-machines: N/A — stateless` rather than removing).
4. **Create the `Prompts` container** as a direct child of the seed (`archon_create_child_note` with `parentNoteId = <seed>`, title `Prompts`).
5. **Create `Prompt-Phase-1..7` notes** as children of the `Prompts` container, in order. Each body uses the BA template above. Inline `[NEEDS CLARIFICATION]` markers liberally — better to ask than to invent.
6. **Discuss with the user** between Prompts and Plans — surface the `[NEEDS CLARIFICATION]` markers gathered, let them edit before architecture work begins.
7. **Create the `Plans` container** as a sibling of `Prompts` under the seed.
8. **Create `Plans-Phase-1..7` notes** as children of `Plans`, mirroring the prompt phases by number/topic. Each body uses the architect template above and explicitly references the matching `Prompt-Phase-N` note id.
9. **Reserve the `Architecture/` slot** — create an `Architecture` container note (empty body explaining it's reserved for execution output). Each `Plans-Phase-N` references the `Architecture/Arch-Phase-N-*` titles it will eventually populate.
10. **Stop.** Do not start execution. Tell the user the next skill is `archon-implement` (or equivalent) once Prompts and Plans are reviewed.

## Discussion checkpoints

- **Before step 4** (after seed read): confirm subject, target depth, audience.
- **Between steps 6 and 7**: review prompts together; let the user lock or edit phase boundaries before plans get drafted.
- **After step 9**: walk the user through the plans, especially the cross-phase dependency graph and any `[NEEDS CLARIFICATION]` markers still open.

## Write-back

After completing steps 4–9, attach an `Execution result — <ISO date>` child to the seed via `archon_write_back_child`, listing:
- Created container note ids (`Prompts`, `Plans`, `Architecture`).
- Phase note ids per layer.
- Open `[NEEDS CLARIFICATION]` markers — count and topics.
- Suggested next skill (`archon-clarify-prompts` if many markers remain, otherwise `archon-implement`).

## Safety

- Read-only against the codebase. No code changes, no commits, no branch operations.
- All writes are scoped to the seed's project (Prompts/Plans/Architecture containers + their phase children).
- If the seed already has `Prompts/`, `Plans/`, or `Architecture/` children with the same titles, **stop and confirm** before overwriting — surface the conflict and ask whether to patch in place, version-suffix (`Prompts-v2`), or abort.
- Do not invent NFR values. If a latency / availability number isn't in the codebase or docs, mark it `[NEEDS CLARIFICATION]` rather than guessing.

## Cross-skill relationships

- **Upstream:** `archon-use-seed-prompt` may delegate here when the seed's intent is architecture extraction.
- **Downstream:** `archon-implement` (or `archon-execute-plans`) consumes the `Plans/` container and writes the actual `Architecture/Arch-Phase-N-*` deliverable notes.
- **Sibling:** `archon-clarify-prompts` can refine the `Prompt-Phase-N` notes if `[NEEDS CLARIFICATION]` markers proliferate.
- **Differentiator vs `archon-create-prompts` / `archon-create-plans`:** generic versions take a free-form seed and let the BA / architect choose phases. This skill bakes in the 7-dimension architecture phase scheme so the deliverable taxonomy is consistent across architecture-extraction projects.

## Two design choices baked in

1. **Arch sub-artifacts as child notes, not sections in one note** — children are better for backlinks/reuse (a sequence diagram referenced from an ADR). Architecture docs get linked-to constantly.
2. **Mermaid lives inline in each artifact note** — the ERD lives in `erd`, the sequence diagram in `sequence-diagrams`. Reserve `Arch-Phase-2-components-and-hld/diagrams` only for cross-cutting C4 diagrams that don't belong to one artifact.

## Failure modes to avoid

- Guessing facts that must come from a human (SLAs, rejected alternatives, compliance scope). Use `[NEEDS CLARIFICATION]`.
- Drifting topic slugs between Prompt-Phase and Plans-Phase. They must match 1:1.
- Stuffing everything into Phase 2. The seven-phase split is load-bearing for parallelization and review; preserve it.
- Writing the architecture itself. Your job is to produce prompts and plans; the downstream execution skill produces `Arch-Phase-*` notes.
- Inventing deliverables the seed never asked for. If scope is narrow (e.g. "data layer only"), mark sub-artifacts `N/A` rather than dropping the phase.

## Finish

Summary to the user:
- Number of Prompts / Plans created.
- List of unresolved `[NEEDS CLARIFICATION]` markers.
- Suggestion of which skill to run next (`archon-clarify-prompts` or `archon-implement`).
- Write-back note id.
