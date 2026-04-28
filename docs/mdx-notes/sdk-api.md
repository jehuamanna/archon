# MDX Mini-App SDK — `@archon/mdx-sdk`

Authoring API exposed to MDX notes. State is **per-project KV**, writable by any project member; notes are authored only by workspace owners. Web-only, online required.

## Module

Virtual module name surfaced inside MDX notes: `@archon/mdx-sdk`.
Actual package path: `packages/archon-mdx-sdk/src/index.ts` (new).

## Component contract

Every SDK component runs inside an `<SDKProvider>` that exposes:

```ts
export interface SDKContext {
  project: { id: string; name: string; workspaceId: string };
  user: { id: string; email: string; displayName?: string };
}
```

No `workspace` handle. No `note` write handle.

## Hooks

```ts
// Primary state primitive — each key is its own row in mdx_state_head.
export function useProjectState<T>(
  key: string,
  initial?: T,
): [T, (next: T | ((prev: T) => T)) => void];

// Raw source of another note in the same project.
export function useNote(idOrTitle: string): {
  source: string;
  loading: boolean;
  error?: Error;
};

// Memoized external fetch. Cross-origin calls use credentials: "omit".
export interface QuerySpec {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: unknown;
}
export function useQuery<T = unknown>(spec: QuerySpec): {
  data?: T;
  loading: boolean;
  error?: Error;
};

export interface MutationSpec extends Omit<QuerySpec, "body"> {}
export function useMutation<TBody = unknown, TResp = unknown>(
  spec: MutationSpec,
): {
  mutate: (body: TBody) => Promise<TResp>;
  loading: boolean;
  error?: Error;
};

export function useBacklinks(noteId: string): {
  backlinks: Array<{ id: string; title: string }>;
  loading: boolean;
};

export function useCurrentUser(): { id: string; email: string; displayName?: string };

export function useProjectNotes(): {
  notes: Array<{ id: string; title: string; type: string }>;
  loading: boolean;
};
```

## Built-in components (v1)

Each component has a `propSpec` consumed by the builder inspector:

```ts
export interface PropSpec {
  [propName: string]: {
    type: "string" | "number" | "boolean" | "enum" | "stateKey" | "noteId";
    required?: boolean;
    enum?: readonly string[];
    default?: unknown;
    semantic?: string; // one-line doc
  };
}
```

| Component | Key props | Semantic |
|---|---|---|
| `<Input />` | `value: string`, `onChange: string`, `placeholder?: string` | Controlled text input; `onChange` is a `useProjectState` key to write. |
| `<Select />` | `options: enum[]`, `value: string`, `onChange: string` | Dropdown; same stateKey binding. |
| `<Checkbox />` | `label: string`, `value: boolean`, `onChange: string` | Same. |
| `<Button />` | `label: string`, `onClick?: string` | Click handler is a `useProjectState` key holding a command or counter. |
| `<Form />` | `fields: object[]`, `submit: string` | Renders children; `submit` is a stateKey the object is written to. |
| `<List />` | `stateKey: string`, `item?: string` | Renders an array under a stateKey; uses `item` as an MDX template. |
| `<Table />` | `stateKey: string`, `columns: enum[]` | Renders rows under a stateKey. |
| `<Chart />` | `stateKey: string`, `kind: enum("bar","line","pie")` | Simple viz over array state. |
| `<NoteEmbed />` | `id?: string`, `title?: string` | Embeds another note's source, rendered as markdown. Same-project only. |
| `<Markdown />` | `source: string` | Inline markdown; sanitized via rehype-sanitize. No `<script>`, no `javascript:` URLs. |

## Inline expression sandbox

Globals available inside `{…}`: `Math`, `Date`, `JSON`, `Array`, `Object`, `String`, `Number`, `Boolean`, plus the component's local scope (hook results + props). Blocked: `eval`, `Function`, `globalThis`, `import()`, `import.meta`, `window`, `document`, `fetch`, `require`.

Authors who need to fetch data use `useQuery`, not raw `fetch`.

## Mini-app example — project task tracker

```mdx
import { Input, Button, List, useProjectState } from "@archon/mdx-sdk";

# Team Tasks

<List stateKey="tasks" item="- [{done}] {title}" />

<Input
  value="draftTask"
  placeholder="Add a task…"
  onChange="draftTask"
/>
<Button
  label="Add"
  onClick="addTask"
/>

{tasks.length === 0 ? "No tasks yet." : `${tasks.filter(t => !t.done).length} open`}
```

State keys used: `tasks`, `draftTask`, `addTask`.

## Non-goals (v1)

- Custom user-defined components
- Remote component loading (no CDN)
- File uploads from inside a mini-app
- Cross-project data (same-project only per R3-Qa)
- Server-authored mutations (mini-app never runs on the server)
- Websockets directly from MDX (use `useQuery` polling if needed)
- Arbitrary `fetch` / raw network in expressions

## Versioning

- Semver-pinned in `packages/archon-mdx-sdk/package.json`.
- `sdkVersion` is exported from the SDK and fed into the compile cache key: `sha256(source + sdkVersion)`.
- Breaking changes bump major → every MDX note recompiles on open.
