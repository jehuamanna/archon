# Getting Started — MDX Mini-App Notes

A 5-minute walkthrough. You'll create a small counter mini-app, save it, and watch the count update live for anyone else viewing the note.

**You need:** workspace-owner access and the `mdxMiniApp` flag enabled on your workspace (ask an admin).

## 1. Turn the feature on

Workspace admin opens **Workspace settings → Experimental** and toggles **MDX mini-app notes** on.

## 2. Create a note

In the Notes explorer, click **New note → MDX mini-app**. A blank canvas opens with an empty palette on the left.

## 3. Drop a Button

Drag **Button** from the **Form** group onto the canvas. The inspector on the right shows the Button's props.

In the inspector:
- **label** — type `Click me`
- **onClick** — type `clicks`

## 4. Show the count

Drop a **Markdown** component below the Button. In its **source** field paste:

```
You've clicked {clicks} times.
```

Click **Save** (top-right).

## 5. See it live

- Open the note in a second browser tab (or have a project teammate open it).
- Click the button in the first tab.
- The second tab updates within ~1 second.

That's it — you have a shared counter backed by `useProjectState("clicks")` and live-updated via WebSocket.

## What just happened

- The builder serialized your tree to readable MDX (`<Button label="Click me" onClick="clicks" />` + a Markdown block).
- On save, the MDX source was stored in the note's `content`.
- On render, the web MDX runtime compiled it once (cached in IndexedDB via sha256 content hash) and mounted the SDK components.
- `<Button onClick="clicks">` increments the project-scoped state key `clicks`, which writes to `mdx_state_head` in Postgres.
- A `pg_notify` fanout pushes the write over a WebSocket to every open viewer, who sees the new value within ~1s.

## Troubleshooting

- **Builder won't mount** — you're not a workspace owner, or the flag is off.
- **"Preview disabled" banner** — global kill switch is on (ops rollback); ask ops.
- **Count doesn't update in the other tab** — WebSocket may have dropped. The client reconnects automatically; reload if needed.
- **Save fails with 429** — you're hitting the rate limit (20 writes/sec burst 50). Slow down or batch.

## Next

- **Cookbook** — four complete recipes: project task tracker, meeting notes with attendees, a light CRM, and a daily journal that embeds other notes.
- **API reference** — `docs/mdx-notes/sdk-api.md` has the full hook and component list.
