# Drag-and-Drop Builder — UX Spec

Target: workspace owners authoring `mdx` notes. Hard requirement: edits must produce **human-readable MDX** that round-trips exactly (decision R1-8).

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  [Code / Builder toggle]                             [Save] [Preview]    │
├──────────────┬────────────────────────────────────────┬──────────────────┤
│              │                                        │                  │
│   PALETTE    │               CANVAS                   │    INSPECTOR     │
│              │                                        │                  │
│  Form        │  ┌──────────────────────────────────┐ │  Component:      │
│   Input      │  │ # Team Tasks                     │ │   Input          │
│   Select     │  │                                  │ │                  │
│   Checkbox   │  │ <List stateKey="tasks" .../>     │ │  Props:          │
│   Button     │  │                                  │ │   value          │
│              │  │ <Input value="draft" ... />      │ │   placeholder    │
│  Display     │  │                                  │ │   onChange       │
│   List       │  │ <Button label="Add" ... />       │ │                  │
│   Table      │  │                                  │ │  State keys:     │
│   Chart      │  │ {advanced: expression}   [read]  │ │   ⚠ tasks also   │
│   Markdown   │  │                                  │ │   used by Team   │
│   NoteEmbed  │  │                                  │ │   Todos          │
│              │  └──────────────────────────────────┘ │                  │
│              │                                        │                  │
└──────────────┴────────────────────────────────────────┴──────────────────┘
```

## Interaction model

1. **Drag from palette** → drop zones highlight on the canvas. Three kinds:
   - `before` / `after` a sibling (horizontal line indicator)
   - `into` a container (Form, List's item template) — container bounding box tints
2. **Click element** → inspector populates with fields from `propSpec`.
3. **Drag by handle** to reorder; keyboard equivalent: `Tab` to focus, `Space` to grab, arrow keys to move, `Enter` to drop.
4. **Delete key** on focused element removes (with one-shot undo banner).
5. **Ctrl/Cmd + Z / Y** — undo/redo; history capped to 100.
6. **Esc** — deselect.

## Round-trip guarantee

- Builder-editable subset: JSX elements whose tag matches a known `@archon/mdx-sdk` component with a registered `propSpec`, plus plain markdown text nodes and `import { … } from "@archon/mdx-sdk";` at the top.
- **Advanced nodes** (anything else — inline expressions `{expr}`, unknown JSX, raw `<script>`-stripped HTML, etc.) are shown on the canvas as a greyed "advanced" chip with the first line of their source. They are **preserved byte-for-byte** on save. The inspector shows them read-only with a "Edit in Code toggle" link.
- Serialization rules:
  - 2-space indent
  - Alphabetized prop order within each element
  - Double-quoted string props; no single-quote swap
  - Trailing newline
  - Unchanged advanced nodes are emitted with their original text

## Code toggle

Top-bar button swaps canvas for a CodeMirror editor showing raw MDX. On blur or explicit "Apply":

- If MDX re-parses cleanly, AST replaces builder state and canvas re-renders.
- If parse fails, the canvas stays hidden and a red banner shows the parse error with line numbers. Save is disabled until either the error is fixed or the user reverts.

## Keyboard story

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Move focus across palette → canvas elements → inspector fields |
| `Enter` | Select focused element; on palette, pick it for drop |
| `Space` | Grab for keyboard drag |
| Arrow keys | Move grabbed element across drop targets |
| `Delete` / `Backspace` | Remove focused element |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `Ctrl+/` | Toggle Code view |
| `Esc` | Deselect / cancel drag |

## Owner vs. non-owner matrix

| View | Palette | Inspector | Save | Code toggle |
|---|---|---|---|---|
| Workspace owner on own note | ✓ | ✓ | ✓ | ✓ |
| Non-owner on any MDX note | — | — | — | — (renderer only) |
| Read-only-on-import owner | — | — | — | View raw source (no builder) |
| Workspace owner, flag off | — | — | — | Falls back to raw source |

Non-owners always see the rendered output via the runtime (Phase 3). The builder chrome never mounts for them.

## Top 5 UX risks and mitigations

1. **Nested-drop ambiguity** — multiple drop targets overlap when a List is inside a Form inside a canvas. Mitigation: only the deepest drop target under the cursor highlights; `Alt` key cycles outward. Keyboard grab uses a breadcrumb of containers.
2. **Prop-type mismatches** — user types `"42"` into a `number` field. Mitigation: inspector validates against `propSpec` on blur; invalid values flash red and are not committed.
3. **Expression loss on round-trip** — a `{user.role === "admin" && <Admin />}` in source could tempt the builder to "simplify". Mitigation: any node the parser classifies as non-builder-editable is preserved as an advanced chip, never mutated.
4. **Silent MDX loss** — a save path that reformats advanced nodes could corrupt them. Mitigation: the serializer emits advanced nodes by substring-slicing the original source using source positions; it never re-synthesizes them. Unit test: fixture corpus with parse → serialize fixed-point.
5. **State-key collisions across notes** — two notes both use `useProjectState("tasks")`. Mitigation: when the user types a stateKey prop, inspector calls `GET /project/:id/mdx-state` and shows a live warning listing other notes that use the same key.
