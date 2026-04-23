import type { Root } from "mdast";
import type { Plugin } from "unified";
import type { Node } from "unist";
import { visit } from "unist-util-visit";

const USER_FORBIDDEN = new Set([
  "mdxFlowExpression",
  "mdxTextExpression",
  "mdxjsEsm",
  "mdxJsxExpressionAttribute",
  "mdxJsxAttributeValueExpression",
]);

const ALWAYS_FORBIDDEN = new Set(["mdxjsEsm"]);

export type ArchonMdxTrustMode = "user" | "bundled" | "mini-app";

/**
 * Trust tiers:
 * - `user`     — workspace MDX: no expressions, no ESM, no JSX attribute expressions.
 * - `bundled`  — repo-seeded docs: expressions allowed; imports/exports forbidden (browser evaluate can't resolve modules).
 * - `mini-app` — MDX mini-app notes (type: "mdx"): expressions allowed so authors can use `{…}`
 *               for pure math/date/string formatting; ESM `import`/`export` still forbidden —
 *               SDK imports are pre-stripped by `remarkArchonMdxFacadeImports` and resolved via
 *               the MDXProvider component map.
 */
export function remarkArchonMdxTrust(mode: ArchonMdxTrustMode): Plugin<[], Root> {
  return function attacher() {
    return function transformer(tree: Root, file) {
      const set = mode === "user" ? USER_FORBIDDEN : ALWAYS_FORBIDDEN;
      visit(tree, (node) => {
        if (set.has(node.type)) {
          const msg =
            mode === "user"
              ? "MDX expressions and ESM are not allowed in workspace MDX notes (use bundled docs or static JSX props only)."
              : mode === "mini-app"
                ? "MDX import/export is not allowed in mini-app notes. Only `import … from \"@archon/mdx-sdk\"` (or `@archon/ui`/`@archon/date`) is permitted, and even those are stripped at compile time — components resolve via the host."
                : "MDX import/export is not allowed in Archon bundled docs.";
          file.fail(msg, node as Node, "archon:mdx-trust");
        }
      });
    };
  };
}
