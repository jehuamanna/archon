# MDX Mini-App Cookbook

Four recipes using only the v1 SDK (`@archon/mdx-sdk`). Each one is copy-paste runnable in a fresh MDX note.

## Recipe 1 — Project Task Tracker

**What it does:** shared to-do list for the project. Every member sees + edits the same tasks; updates appear live.

**State keys used:** `tasks` (array), `draftTitle` (string).

```mdx
import { Input, Button, List, Markdown } from "@archon/mdx-sdk";

# Team Tasks

<List item="- {title}" stateKey="tasks" />

<Input onChange="draftTitle" placeholder="What needs doing?" value="draftTitle" />
<Button label="Add task" onClick="addTaskAction" />

<Markdown source="Keep entries short — they're shared across the team." />
```

> **Note.** This recipe demonstrates the shape. A production version would use a `<Form>` wrapper and push the draft into `tasks` via an onSubmit handler; v1's `<Button onClick>` increments a counter key — wiring the "Add" action to actually append to `tasks` is expected evolution in v1.1.

---

## Recipe 2 — Meeting Notes with Shared Attendee List

**What it does:** notes area + a live attendee list. Multiple members can add attendees at the same time.

**State keys used:** `attendees` (array), `draftAttendee` (string), `notesBody` (string).

```mdx
import { Input, Button, List, Markdown } from "@archon/mdx-sdk";

# Meeting — 2026-04-23

## Attendees

<List item="- {name}" stateKey="attendees" />

<Input onChange="draftAttendee" placeholder="Name" value="draftAttendee" />
<Button label="Add attendee" onClick="addAttendee" />

## Notes

<Input onChange="notesBody" placeholder="Paste meeting notes here…" value="notesBody" />

<Markdown source="Notes are shared — anyone can edit." />
```

---

## Recipe 3 — Lightweight CRM

**What it does:** a contact table. Columns: name, email, owner. Rows live in project state.

**State keys used:** `contacts` (array of `{name, email, owner}`).

```mdx
import { Table, Markdown } from "@archon/mdx-sdk";

# Customer CRM

<Table columns="name,email,owner" stateKey="contacts" />

<Markdown source="Edit the list via an admin sheet — v1 of the builder doesn't yet support in-row editing." />
```

> **Note.** v1 renders the table from project state. Adding new rows uses the same `<Input>` + `<Button>` pattern as Recipe 1; a full row editor is coming in v1.1.

---

## Recipe 4 — Daily Journal with NoteEmbed

**What it does:** today's journal entry + an embed of another note (e.g. "Reading List"). Shows how to pull content from a sibling note in the same project.

**State keys used:** `journal_today` (string).

```mdx
import { Input, NoteEmbed, Markdown } from "@archon/mdx-sdk";

# Daily Journal

<Input onChange="journal_today" placeholder="What happened today?" value="journal_today" />

## Reading list

<NoteEmbed title="Reading List" />

<Markdown source="The Reading List note lives in the same project — edits there show up here on reload." />
```

> **Note.** `<NoteEmbed>` resolves same-project only (decision R3-Qa). Cross-project import is deferred.

---

## Common pitfalls

- **State key collisions.** Two notes using `useProjectState("tasks")` share the same data. The builder's inspector surfaces collisions via a warning; pick project-unique keys for anything note-specific (`tasks-marketing` vs. `tasks`).
- **Large state.** Individual keys have a 256MB soft cap (413 past). Split large datasets into per-record keys (`order_<id>`) rather than one giant array.
- **Rate limit.** Interactive mini-apps rarely approach the 20/s (burst 50) ceiling; batch writes if you do.
- **External APIs.** `useQuery({ url: "https://…" })` works only for CORS-permitting endpoints. There's no backend proxy in v1.
- **`fetch` in expressions.** Not available by design (see decision R4-Qa). Use `useQuery` at the component level and render the resolved data.
