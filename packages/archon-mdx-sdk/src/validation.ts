/**
 * Validation rules for Archon MDX mini-app notes. These constants are the
 * single source of truth for what an authoring tool (human or AI) must
 * respect to produce MDX that the host renderer will accept. The renderer
 * enforces the same rules at compile time via remark plugins.
 */

/**
 * Bare specifiers an MDX note may import from. Anything else is rejected.
 *
 * NOTE: `@archon/mdx-sdk` here is the **in-MDX facade name** (the literal
 * string MDX authors type in their `import` line). It is intentionally
 * different from the npm distribution name of THIS schema package
 * (`@nodex-studio/mdx-sdk`). The renderer strips these imports at compile
 * time and resolves the symbols through a host-provided MDXProvider map —
 * the package the host ships from is decoupled from the facade name authors
 * see. Don't "fix" this to match the npm name.
 */
export const ALLOWED_FACADE_IMPORTS = [
  "@archon/ui",
  "@archon/date",
  "@archon/mdx-sdk",
] as const;

export type AllowedFacadeImport = (typeof ALLOWED_FACADE_IMPORTS)[number];

/**
 * Forbidden constructs in MDX source. Each rule includes a `why` so an AI
 * surfacing this error to the user can explain (or self-correct).
 */
export const MDX_FORBIDDEN_CONSTRUCTS = [
  {
    id: "no-export",
    pattern: "export ...",
    why: "MDX `export` is not allowed; mini-app notes have no public symbols.",
  },
  {
    id: "no-side-effect-import",
    pattern: 'import "..."',
    why: "Side-effect-only imports are not allowed.",
  },
  {
    id: "no-dynamic-import",
    pattern: "import('...')",
    why: "Dynamic `import()` is not allowed (sandbox escape).",
  },
  {
    id: "no-foreign-import",
    pattern: 'import ... from "x"',
    why: "Only @archon/ui, @archon/date, and @archon/mdx-sdk are importable.",
  },
] as const;

/** Per-key state limits enforced by the server. Kept here so authoring tools can self-cap. */
export const STATE_LIMITS = {
  KEY_MAX_BYTES: 64,
  /** Max serialized JSON bytes per state key. Larger values are rejected with HTTP 413. */
  VALUE_MAX_BYTES: 256 * 1024,
  MAX_KEYS_PER_PROJECT: 1000,
} as const;

/** Regex a `stateKey` value must match (mirrors the server route validator). */
export const STATE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Convention: keys whose name starts with `__` are local-only (not synced
 * to the server). Useful for transient draft state that doesn't need
 * cross-tab persistence — e.g. the input field of a `<PushButton>` flow.
 */
export const LOCAL_KEY_PREFIX = "__";
