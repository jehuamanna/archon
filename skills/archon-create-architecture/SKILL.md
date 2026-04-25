---
name: archon-create-architecture
description: Execute architecture-extraction Plans (Plans-Phase-1..7-<topic>) and write the actual architecture deliverables as Arch-Phase-N-<topic> notes (with sub-artifact children) under the reserved Architecture/ container of the seed. Read-only against the codebase — no git commits — output is Archon notes (mermaid diagrams, ERDs, sequence diagrams, contracts, etc.). Invoke when the user asks to execute architecture plans, materialize architecture, or run the build phase of an architecture extraction.
---

# archon-create-architecture

## Role

Execution phase for architecture extraction. Given a seed with `Plans/Plans-Phase-1..7-<topic>` notes and a reserved `Architecture/` container, materialize the architecture by reading the codebase and writing the deliverable artifact notes — mermaid diagrams, ERDs, sequence diagrams, IPC inventories, NFR tables, glossaries, ADRs, and so on.

This is **not** a code-execution skill: it produces Archon notes, not git commits. Distinct from `archon-implement`.

## Inputs

- A seed note (UUID or title) — must already have:
  - `Prompts/` container (informs deliverables and acceptance criteria).
  - `Plans/` container with 7 `Plans-Phase-1..7-<topic>` children.
  - `Architecture/` container (reserved, empty).
- Optional: `subject` — free-form name to use in deliverable titles.

## Pre-flight

- Verify the seed's children include `Prompts/`, `Plans/` (with all 7 phase notes), and an empty or near-empty `Architecture/`. If any are missing, **stop** and tell the user which earlier skill to run (`archon-create-architecture-prompts` or `archon-create-architecture-plans`).
- For each `Plans-Phase-N-<topic>` note, verify it has:
  - A `Matching prompt` reference to the corresponding `Prompt-Phase-N-<topic>`.
  - An `Execution order (with [commit] boundaries)` section.
  - A `Risks / unknowns` section.
- If the `Architecture/` container already has `Arch-Phase-N-<topic>` children, stop and ask whether to patch in place, version-suffix, or abort. Don't silently overwrite.

## Output structure (created by this skill)

```
<Seed Note>/Architecture/
├── Arch-Phase-1-context-and-scope/
│   ├── scope-statement
│   ├── system-context-diagram
│   ├── glossary-seed
│   ├── external-dependencies
│   └── in-scope-out-of-scope
├── Arch-Phase-2-components-and-hld/
│   ├── hld
│   ├── lld
│   ├── diagrams
│   └── module-dependency-graph
├── Arch-Phase-3-data-architecture/
│   ├── erd
│   ├── datatypes
│   ├── storage-and-indexes
│   ├── caching-and-invalidation
│   └── migration-strategy
├── Arch-Phase-4-runtime-behavior/
│   ├── sequence-diagrams
│   ├── state-machines
│   ├── concurrency-model
│   ├── failure-modes
│   └── lifecycle
├── Arch-Phase-5-contracts-and-interfaces/
│   ├── api-surface
│   ├── event-schemas
│   ├── authn-authz-model
│   └── trust-boundaries
├── Arch-Phase-6-nfrs-and-operations/
│   ├── functional-requirements
│   ├── non-functional-requirements
│   ├── nfr-to-mechanism-map
│   ├── deployment-topology
│   ├── observability
│   ├── scaling-and-bottlenecks
│   ├── dr-and-backup
│   └── security-and-compliance
└── Arch-Phase-7-cross-cutting-concerns/
    ├── glossary
    ├── adrs
    ├── assumptions-and-constraints
    └── risks-and-tech-debt
```

## Naming conventions

- Phase containers: `Arch-Phase-<N>-<kebab-topic>` — phase numbers and slugs mirror the matching `Plans-Phase-<N>-<topic>` 1:1.
- Sub-artifacts: lowercase kebab, no phase prefix (`erd`, `sequence-diagrams`, etc.).
- Each sub-artifact is its own note (better for backlinks/reuse than one monolithic note per phase).
- Mermaid lives inline in each artifact note (the ERD lives in `erd`, the boot sequence in `sequence-diagrams`). Reserve `Arch-Phase-2-components-and-hld/diagrams` only for cross-cutting C4 diagrams that don't belong to a single artifact.

## Execution order

Follow the cross-phase dependency graph from the `Plans/` container body:

```
1 (context) → 2 (components) → 3 (data) ┐
                              ↘ 4 (runtime) ─→ 5 (contracts) → 6 (NFRs) → 7 (cross-cutting)
```

Phases 3 and 4 may run in parallel after 2 — execute them concurrently when subagents are available.

Within each phase, follow the plan's `Execution order (with [commit] boundaries)` strictly. At each `[commit]` boundary, finalize the corresponding sub-artifact note. **The `[commit]` is a sub-artifact checkpoint, not a git commit** — this skill never touches the working tree.

## Procedure

1. Resolve the seed via `archon_execute_note`. On ambiguity, surface candidates and stop.
2. Pre-flight (above). Stop on any failure.
3. Cache the 7 Plans-Phase notes locally (read once).
4. For each phase in execution order:
   1. Create the `Arch-Phase-<N>-<topic>` container under `Architecture/` (parent = `Architecture/` note id).
   2. Read the matching `Plans-Phase-<N>` note's `Extraction strategy` and `Execution order`.
   3. For each sub-artifact in the plan's order:
      1. Read the codebase per the plan's strategy (grep, file reads, doc lookups). Read-only.
      2. Compose the sub-artifact body (mermaid diagram, table, prose, schema). Cite source files as `path:line` where helpful.
      3. Create the sub-artifact note as a direct child of the `Arch-Phase-<N>` container.
      4. Treat the plan's `[commit]` markers as soft checkpoints — between markers you may parallelize file reads or batch sub-artifact writes.
   4. After the phase's sub-artifacts are written, append a one-line status to the phase container body's "Status" line (or the orchestrator's running log).
5. After Phase 7, write a final session summary as a child of the seed via `archon_write_back_child`.

## Plan-drift handling

If a plan's strategy is wrong in a non-trivial way (e.g. names a file that no longer exists, references a tool not in the repo, the codebase has structurally moved on), do not silently rewrite the plan. Instead:
- Create a `Blocker — <short name>` child under that `Plans-Phase-<N>` note (via `archon_write_back_child`).
- Write a partial sub-artifact noting what could be derived plus a `[NEEDS PLAN UPDATE]` marker.
- Continue the rest of the phase if possible; surface the blocker in the final summary.
- Do not block other phases unless the drift is foundational (e.g. Phase 2 component map turns out to be wholly wrong).

## Discussion checkpoints

- **None during execution.** This skill runs end-to-end without user interruption, mirroring `archon-implement`'s no-interrupt policy. Surface anything unusual at the end (final summary or blocker child notes).
- The one exception: ambiguity in note resolution (`archon_execute_note` returns multiple candidates). Surface candidates and stop — guessing risks writing to the wrong note tree.

## Write-back

After all phases (or at first hard block), attach an `Execution result — <ISO date>` child to the seed via `archon_write_back_child`, listing:
- All 7 `Arch-Phase-N` container note ids.
- Per-phase sub-artifact counts and any sub-artifacts marked `N/A — <reason>` or skipped.
- Any `Blocker —` children created under `Plans-Phase-N` notes.
- Total `[NEEDS CLARIFICATION]` markers preserved in deliverables (carried over from prompts that weren't clarified).
- Suggested next action: `archon-clarify-prompts` if many markers remain, or "review the architecture" if complete.

## Safety

- **Read-only against the codebase.** No code changes, no commits, no branch operations. The work product is Archon notes, not files.
- All writes are scoped to the seed's project — `Architecture/Arch-Phase-N` containers, sub-artifact children, blocker children under `Plans-Phase-N`, and a final write-back.
- Do not modify `Plans/` or `Prompts/` notes — they are inputs.
- Do not invent NFR numbers, SLAs, or design decisions. Preserve `[NEEDS CLARIFICATION]` markers from the prompts as inline notes in the matching deliverables.

## Failure modes to avoid

- Treating `[commit]` as a git commit — it's only a sub-artifact checkpoint here.
- Padding deliverables with content the plan didn't request.
- Skipping a sub-artifact silently because the codebase is thin — mark it `N/A — <reason>` and surface in the summary.
- Editing prior plans or prompts in-place — drift goes in a `Blocker —` child, not in the source plan.
- Running the codebase (executing scripts, dev servers) for "runtime traces" — read code only.
- Repeating the entire prompt or plan body in the deliverable — link by note id, don't duplicate.

## Cross-skill relationships

- **Upstream:** `archon-create-architecture-plans` produced the inputs.
- **Sibling:** `archon-clarify-prompts` can refine `Prompt-Phase-N` notes if many `[NEEDS CLARIFICATION]` markers carry into deliverables.
- **Orchestrator:** `archon-extract-architecture` runs all three architecture skills end-to-end.
- **Distinct from:** `archon-implement` (which writes git commits) — this skill writes Archon notes only, regardless of how many `[commit]` markers the plan has.

## Finish

Summary to the user: phases completed, sub-artifacts written, blockers (if any), open `[NEEDS CLARIFICATION]` markers, suggested next step, write-back note id.