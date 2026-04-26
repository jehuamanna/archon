/**
 * `@archon/mdx-sdk` — schema-only declaration of the Archon MDX mini-app
 * surface. Safe to depend on from anywhere (no React, no runtime deps).
 *
 * - The author-facing import name (`@archon/mdx-sdk`) that MDX notes use is
 *   STILL this package — the host runtime resolves the symbols via its own
 *   MDXProvider component map at compile time.
 * - The actual React runtime (components + hooks) lives in
 *   `@archon/mdx-sdk-runtime` (private). Schema and runtime are separated so
 *   AI tools and validators can depend on the contract without pulling in
 *   the React implementation, and so the schema can be published openly.
 */
export { PROP_SPECS, type PropSpec, type ComponentPropSpec } from "./prop-specs.js";
export {
  ALLOWED_FACADE_IMPORTS,
  type AllowedFacadeImport,
  MDX_FORBIDDEN_CONSTRUCTS,
  STATE_LIMITS,
  STATE_KEY_RE,
  LOCAL_KEY_PREFIX,
} from "./validation.js";
export { buildMdxSdkJsonSchema, type ArchonMdxSdkSpec } from "./json-schema.js";
export { buildArchonMdxSystemPrompt } from "./system-prompt.js";

export const sdkVersion = "0.1.1";
