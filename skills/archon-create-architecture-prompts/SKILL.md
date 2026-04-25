---
name: archon-create-architecture-prompts
description: Act as a senior business analyst to dissect an architecture-extraction seed-prompt note into 7 fixed dimension-phase prompt notes (Prompt-Phase-1..7-<topic>) saved under a "Prompts" container of the seed. Each prompt covers Scope / Inputs / Deliverables / [NEEDS CLARIFICATION] / Acceptance criteria with the dimension scheme (context, components, data, runtime, contracts, NFRs, cross-cutting) baked in. Invoke when the user asks to create architecture prompts from a seed, decompose architecture requirements into prompts, or run the BA phase of an architecture extraction.
---

# archon-create-architecture-prompts

## Role

Senior BA for architecture-extraction work. Read a seed note (a codebase / feature / system requesting architectural documentation) and produce 7 `Prompt-Phase-N-<topic>` notes covering the seven fixed architectural dimensions. Stops at prompts — `archon-create-architecture-plans` is the next phase.

## Inputs

- A seed note (UUID or title) describing the target subject. Title typically `Extract Architecture — <subject>`, but any architecture-extraction seed is acceptable.
- Optional: `subject` — free-form name to use in deliverable titles.

## Phase scheme (fixed, 7 dimensions)

1. `context-and-scope` — what the subject *is* and *isn't*; external dependencies; audience; depth.
2. `components-and-hld` — top-level components, HLD, LLD, C4 diagrams, module dependency graph.
3. `data-architecture` — entities, datatypes, storage layout, caches/invalidation, migration strategy.
4. `runtime-behavior` — sequence diagrams, state machines, concurrency model, failure modes, lifecycles.
5. `contracts-and-interfaces` — API surface, event/IPC schemas, authn/authz, trust boundaries.
6. `nfrs-and-operations` — FR/NFR, NFR-to-mechanism map, deployment topology, observability, scaling, DR, security/compliance.
7. `cross-cutting-concerns` — glossary, ADRs, assumptions/constraints, risks/tech-debt.

Cross-phase dependencies (inform the prompt bodies):

```
1 (context) → 2 (components) → 3 (data) ┐
                              ↘ 4 (runtime) ─→ 5 (contracts) → 6 (NFRs) → 7 (cross-cutting)
```

Phases 3 and 4 may run in parallel after 2.

## Output structure

```
<Seed Note>
└── Prompts/                              ← container created by this skill
    ├── Prompt-Phase-1-context-and-scope
    ├── Prompt-Phase-2-components-and-hld
    ├── Prompt-Phase-3-data-architecture
    ├── Prompt-Phase-4-runtime-behavior
    ├── Prompt-Phase-5-contracts-and-interfaces
    ├── Prompt-Phase-6-nfrs-and-operations
    └── Prompt-Phase-7-cross-cutting-concerns
```

## Naming conventions

- Container: `Prompts` (capitalized, no phase).
- Phase notes: `Prompt-Phase-<N>-<kebab-topic>` (e.g. `Prompt-Phase-3-data-architecture`).
- Phase numbers and topic slugs **must** match what `archon-create-architecture-plans` and `archon-create-architecture` will use 1:1 — these slugs are load-bearing across the three layers. Don't drift wording.

## Per-phase prompt template (lock these sections in every Prompt-Phase note)

- **Scope** — what this phase covers and what it explicitly defers to others.
- **Inputs** — code paths, prior phases' outputs, external docs.
- **Deliverables** — exact list of `Arch-Phase-N` sub-artifact note titles to be produced (from the table below).
- **Questions for the user** — `[NEEDS CLARIFICATION]` markers where the codebase can't answer (SLAs, audience, intentional design choices). Be liberal — better to ask than invent.
- **Acceptance criteria** — what "done" looks like for this phase.

### Sub-artifact targets per phase (children of the eventual `Arch-Phase-N` container)

| Phase | Sub-artifacts |
|---|---|
| 1 context-and-scope | `scope-statement`, `system-context-diagram`, `glossary-seed`, `external-dependencies`, `in-scope-out-of-scope` |
| 2 components-and-hld | `hld`, `lld`, `diagrams` (c4-context / container / component, mermaid), `module-dependency-graph` |
| 3 data-architecture | `erd`, `datatypes`, `storage-and-indexes`, `caching-and-invalidation`, `migration-strategy` |
| 4 runtime-behavior | `sequence-diagrams`, `state-machines`, `concurrency-model`, `failure-modes`, `lifecycle` |
| 5 contracts-and-interfaces | `api-surface`, `event-schemas`, `authn-authz-model`, `trust-boundaries` |
| 6 nfrs-and-operations | `functional-requirements`, `non-functional-requirements`, `nfr-to-mechanism-map`, `deployment-topology`, `observability`, `scaling-and-bottlenecks`, `dr-and-backup`, `security-and-compliance` |
| 7 cross-cutting-concerns | `glossary`, `adrs`, `assumptions-and-constraints`, `risks-and-tech-debt` |

## Procedure

1. Resolve the seed note via `archon_execute_note`. On ambiguity, surface candidates and stop.
2. Read the seed and survey the codebase shallowly (file listings, key directories, framework signals). Goal: enough context to ground the prompt deliverables. Read-only — no code changes.
3. **Pre-flight discussion** — confirm with the user (or note assumptions explicitly when running in auto mode):
   - Subject (codebase root path / feature scope).
   - Target depth — system-level overview or single-component deep-dive?
   - Audience — internal engineers, new joiners, plugin authors, external integrators?
   - Goal — onboarding aid, refactor planning, external publication, audit?
4. Check the seed for an existing `Prompts/` child. If present, **stop and ask** whether to patch in place, version-suffix (`Prompts-v2`), or abort.
5. Create the `Prompts` container as a direct child of the seed (`archon_create_child_note` with `parentNoteId = <seed>`, title `Prompts`).
6. Create `Prompt-Phase-1..7-<topic>` notes as children of `Prompts`, in order, each using the template above. Include `[NEEDS CLARIFICATION]` markers liberally.
7. **Stop.** Tell the user the next skill is `archon-create-architecture-plans`. If many `[NEEDS CLARIFICATION]` markers remain, suggest `archon-clarify-prompts` first.

## Discussion checkpoints

- Before step 5 (after seed read): confirm subject, depth, audience, goal. Auto mode: surface assumptions in a one-line note and proceed.
- After step 6: list the open `[NEEDS CLARIFICATION]` markers and let the user edit before plans are drafted.

## Write-back

After completing steps 5–6, attach an `Execution result — <ISO date>` child to the seed via `archon_write_back_child`, listing:
- The `Prompts` container note id.
- All 7 `Prompt-Phase-N` note ids.
- Open `[NEEDS CLARIFICATION]` markers — count and topics by phase.
- Suggested next skill (`archon-clarify-prompts` if many markers, else `archon-create-architecture-plans`).

## Safety

- Read-only against the codebase. No code changes, no commits, no branch operations.
- All writes are scoped to the seed's project (`Prompts/` container + 7 phase children + write-back).
- Don't drop a phase even if a sub-artifact doesn't apply — mark sub-artifacts `N/A — <reason>` instead. The 7-phase scheme is load-bearing.

## Failure modes to avoid

- Inventing facts that must come from a human (SLAs, audience, intentional design choices). Use `[NEEDS CLARIFICATION]`.
- Stuffing everything into Phase 2.
- Drifting topic slugs that downstream skills then need to mirror.
- Writing the architecture itself — this skill produces only BA prompts.

## Cross-skill relationships

- **Upstream:** `archon-extract-architecture` orchestrator may invoke this as Phase A.
- **Downstream:** `archon-create-architecture-plans` reads the `Prompts/` container and produces the matching `Plans/` container.
- **Sibling:** `archon-clarify-prompts` refines individual `Prompt-Phase-N` notes when many `[NEEDS CLARIFICATION]` markers accumulate.

## Finish

Summary to the user: prompts created, total `[NEEDS CLARIFICATION]` markers (count + topic list), suggested next skill, write-back note id.