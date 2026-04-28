# MDX Mini-App — Hands-On Tutorial

Progressive examples, from trivially simple to genuinely useful. Every block is copy-paste-ready — create a new **MDX mini-app** note (Workspace owner only), toggle to **Code** view, paste, then flip back to **Builder** and click **Save**.

Open the same note in a second browser tab to watch live updates.

> **State keys you pick are shared across the project.** Pick project-unique keys for anything note-specific (e.g. `counter_todo` not `counter`).

---

## Level 0 — Hello World (no components)

MDX is a superset of markdown. You can paste plain markdown and it renders.

```mdx
# Hello

This is an **MDX mini-app** note. It can contain regular markdown…

- bullets
- `code`
- [links](https://archon.local)

…plus live components, which we'll add next.
```

---

## Level 1 — Your first component

Drop a Button. Nothing happens when you click it yet — that's Level 2.

```mdx
import { Button } from "@archon/mdx-sdk";

<Button label="Click me" />
```

---

## Level 2 — An input bound to state

Type into the input; the `<Value>` below updates live.

```mdx
import { Input, Value } from "@archon/mdx-sdk";

Type your name:

<Input onChange="greeter_name" placeholder="Your name" value="greeter_name" />

Hello, **<Value fallback="stranger" stateKey="greeter_name" />**!
```

Open the same note in a second tab and watch: whatever you type appears in the other tab within a second. That's the live Change-Stream channel in action.

---

## Level 3 — Checkbox (boolean state)

```mdx
import { Checkbox, Value } from "@archon/mdx-sdk";

<Checkbox label="Show advanced" onChange="demo_showAdvanced" value="demo_showAdvanced" />

Advanced mode is: **<Value fallback="off" stateKey="demo_showAdvanced" />**
```

---

## Level 4 — Select (enum state)

```mdx
import { Select, Value } from "@archon/mdx-sdk";

Priority:

<Select onChange="demo_priority" options="low,medium,high" value="demo_priority" />

Current: **<Value fallback="medium" stateKey="demo_priority" />**
```

---

## Level 5 — A counter

`<Button onClick="key">` increments a number state key on each click.

```mdx
import { Button, Value } from "@archon/mdx-sdk";

<Button label="+1" onClick="demo_counter" />

Clicked <Value fallback="0" stateKey="demo_counter" /> times.
```

Share this note's URL with a teammate and click from both tabs — the counter is shared.

---

## Level 6 — A shared to-do list

`<PushButton>` appends the typed input to a shared array. `<List>` renders it.

```mdx
import { Input, PushButton, List } from "@archon/mdx-sdk";

## Shared to-do

<List item="- {.}" stateKey="demo_todos" />

<Input onChange="demo_draft" placeholder="Add a task…" value="demo_draft" />
<PushButton clearFrom={true} fromKey="demo_draft" label="Add" toKey="demo_todos" />
```

> `item="- {.}"` uses `{.}` for primitive items (strings/numbers). For arrays of objects, use `{fieldName}`.

---

## Level 7 — A shared table

```mdx
import { Input, PushButton, Table } from "@archon/mdx-sdk";

## Customers

<Table columns="name,email,plan" stateKey="demo_customers" />
```

To seed `demo_customers` with example data, click **Save**, open the builder's **Code** view on a brand new note and use:

```mdx
import { Table } from "@archon/mdx-sdk";

<Table columns="name,email,plan" stateKey="demo_customers" />
```

Then pre-populate via a sibling mini-app or via `curl`:

```bash
curl -X PUT http://localhost:3000/api/v1/projects/<projectId>/mdx-state/demo_customers \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -H 'If-Match: 0' \
  -d '{"value":[{"name":"Ada","email":"ada@ex.com","plan":"pro"},{"name":"Ben","email":"ben@ex.com","plan":"free"}]}'
```

---

## Level 8 — A bar chart

```mdx
import { Chart, Value } from "@archon/mdx-sdk";

## Daily activity

<Chart kind="bar" stateKey="demo_chart" />

Total: <Value fallback="0" stateKey="demo_chart_total" />
```

Seed `demo_chart` with `[3, 7, 2, 9, 5]` via the same curl pattern.

---

## Level 9 — Embed another note

Create a sibling note called exactly `Onboarding Checklist`, then:

```mdx
import { NoteEmbed } from "@archon/mdx-sdk";

# Welcome

Read the checklist below, then get started.

<NoteEmbed title="Onboarding Checklist" />
```

Same-project only. Edits to the target note reflect here on reload.

---

## Level 10 — A simple expression

Inline JS expressions are allowed for **pure** computation using `Math`, `Date`, `JSON`, `Array`, `Object`, `String`, `Number`, `Boolean`. They **cannot** call `fetch`, touch `window`, or `eval`.

```mdx
Today is {new Date().toDateString()}.
The square root of 2 is {Math.sqrt(2).toFixed(4)}.
```

---

## Level 11 — Complete: Daily Standup

A working single-page standup board: name capture, yesterday/today/blockers, shared attendee list.

```mdx
import { Input, Checkbox, PushButton, List, Value } from "@archon/mdx-sdk";

# Daily Standup

**Date:** {new Date().toDateString()}

## Who's here

<List item="- {.}" stateKey="standup_attendees" />

<Input onChange="standup_draftName" placeholder="Your name" value="standup_draftName" />
<PushButton clearFrom={true} fromKey="standup_draftName" label="I'm here" toKey="standup_attendees" />

## Yesterday

<Input onChange="standup_yesterday" placeholder="What did you finish?" value="standup_yesterday" />

## Today

<Input onChange="standup_today" placeholder="What are you working on?" value="standup_today" />

## Blockers

<Checkbox label="I'm blocked" onChange="standup_blocked" value="standup_blocked" />

Blocked? **<Value fallback="no" stateKey="standup_blocked" />**
```

---

## Level 12 — Complete: Reading List

Lightweight backlog with add / mark-read / stats.

```mdx
import { Input, PushButton, List, Value, Button } from "@archon/mdx-sdk";

# Reading List

## Unread

<List item="- {.}" stateKey="reading_unread" />

<Input onChange="reading_draft" placeholder="Add an article title or URL" value="reading_draft" />
<PushButton clearFrom={true} fromKey="reading_draft" label="Queue it" toKey="reading_unread" />

## Stats

Items queued today: <Value fallback="0" stateKey="reading_added_today" />

<Button label="+1 added today" onClick="reading_added_today" />
```

---

## Level 13 — Complete: Team Pulse Dashboard

A real-feeling dashboard that mixes charts, tables, and shared input. Safe to share with the team.

```mdx
import { Chart, Table, Input, PushButton, Value, Checkbox, Select } from "@archon/mdx-sdk";

# Team Pulse — Week of {new Date().toDateString()}

## Mood pulse

Rate this week's mood:

<Select onChange="pulse_my_mood" options="1,2,3,4,5" value="pulse_my_mood" />

<Input onChange="pulse_draft_note" placeholder="(optional) one-line note" value="pulse_draft_note" />
<PushButton clearFrom={true} fromKey="pulse_draft_note" label="Submit note" toKey="pulse_notes" />

**Your mood:** <Value fallback="(not set)" stateKey="pulse_my_mood" />

## Team mood history (last entries)

<Chart kind="bar" stateKey="pulse_history" />

## Notes from the team

<Table columns="who,text,when" stateKey="pulse_note_rows" />

## Wins

<Input onChange="pulse_win_draft" placeholder="Share a win" value="pulse_win_draft" />
<PushButton clearFrom={true} fromKey="pulse_win_draft" label="Share" toKey="pulse_wins" />

_Wins this week:_

<Chart kind="line" stateKey="pulse_win_counts" />

## Retro checkbox

<Checkbox label="I'm ready for retro" onChange="pulse_ready_retro" value="pulse_ready_retro" />

Team status: **<Value fallback="gathering" stateKey="pulse_ready_retro" />**
```

---

## Cheat sheet

### Components

| Tag | Reads | Writes | Notes |
|---|---|---|---|
| `<Input value="k" onChange="k" />` | `k` | `k` | Text field |
| `<Select options="a,b,c" value="k" onChange="k" />` | `k` | `k` | Dropdown |
| `<Checkbox value="k" onChange="k" label="…" />` | `k` | `k` | Boolean |
| `<Button label="…" onClick="k" />` | — | `k` (counter) | Increments `k` |
| `<PushButton fromKey="f" toKey="t" label="…" />` | `f`, `t` | `t`, `f` (if `clearFrom`) | Appends `f` to array `t` |
| `<Value stateKey="k" fallback="…" />` | `k` | — | Displays `k` |
| `<List stateKey="k" item="- {name}" />` | `k` (array) | — | Renders each item with template |
| `<Table stateKey="k" columns="a,b" />` | `k` (rows) | — | Simple table |
| `<Chart stateKey="k" kind="bar\|line\|pie" />` | `k` (numbers) | — | Minimal chart |
| `<NoteEmbed title="…" />` | target note | — | Same-project only |
| `<Markdown source="…" />` | — | — | Renders markdown source |

### Expressions

Allowed in `{...}`: `Math`, `Date`, `JSON`, `Array`, `Object`, `String`, `Number`, `Boolean`, plus component-local scope.

Blocked: `fetch`, `window`, `document`, `eval`, `Function`, `globalThis`, `import()`, `require`.

### Tips

- **Scope state keys** — prefix with a note-specific stub (`standup_…`, `pulse_…`) to avoid cross-note collisions. The builder warns you about existing keys.
- **Builder's Code toggle** — `Ctrl+/` swaps between Builder and raw MDX. Use Code for anything more than simple drop-and-edit.
- **Live updates** — every `<Value>`, `<List>`, `<Table>`, `<Chart>` reading the same key updates across all open tabs within ~1 second.
- **Safe by default** — you can't break the app from an MDX note. If a component errors, you'll see a fallback tile; siblings keep rendering.
- **State persists** — state lives in Postgres per project. Deleting the note does not delete its state keys. Use a fresh key name if you want a clean start.

---

## Where to go next

- **API reference** → [`sdk-api.md`](./sdk-api.md)
- **Cookbook** → [`cookbook.md`](./cookbook.md)
- **Builder UX spec** → [`builder-ux.md`](./builder-ux.md)
