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

export type ArchonMdxTrustMode = "user" | "bundled";

/**
 * User-tier MDX: no `{expressions}`, no ESM, no JSX attribute expressions.
 * Bundled-tier: expressions allowed, but imports/exports still forbidden (browser evaluate cannot resolve modules).
 */
export function remarkArchonMdxTrust(mode: ArchonMdxTrustMode): Plugin<[], Root> {
  return function attacher() {
    return function transformer(tree: Root, file) {
      const set = mode === "user" ? USER_FORBIDDEN : ALWAYS_FORBIDDEN;
      visit(tree, (node) => {
        if (set.has(node.type)) {
          file.fail(
            mode === "user"
              ? "MDX expressions and ESM are not allowed in workspace MDX notes (use bundled docs or static JSX props only)."
              : "MDX import/export is not allowed in Archon bundled docs.",
            node as Node,
            "archon:mdx-trust",
          );
        }
      });
    };
  };
}
