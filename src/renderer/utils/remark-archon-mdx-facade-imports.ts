import type { Root } from "mdast";
import type { Plugin } from "unified";
import type { Parent } from "unist";
import type { VFile } from "vfile";
import { visit } from "unist-util-visit";

const IMPORT_FROM_RE = /from\s+['"]([^'"]+)['"]/g;
const EXPORT_RE = /^\s*export\b/m;

/** Specifiers note-authored MDX may import (stripped before evaluate; components come from MDXProvider map). */
const ALLOWED_FACADE = /^@archon\/(ui|date|mdx-sdk)$/;

function validateAndStripMdxjsEsm(
  node: { type: string; value?: string },
  file: VFile,
): void {
  const src = typeof node.value === "string" ? node.value : "";
  if (EXPORT_RE.test(src)) {
    file.fail("MDX export is not allowed in Archon workspace MDX.", node, "archon:mdx-facade-import");
  }
  let m: RegExpExecArray | null;
  const importFrom = new RegExp(IMPORT_FROM_RE);
  let sawImport = false;
  while ((m = importFrom.exec(src)) !== null) {
    sawImport = true;
    const spec = m[1] ?? "";
    if (!ALLOWED_FACADE.test(spec)) {
      file.fail(
        `MDX import "${spec}" is not allowed. Use only @archon/ui, @archon/date, or @archon/mdx-sdk (virtual facades; components are provided by the host).`,
        node,
        "archon:mdx-facade-import",
      );
    }
  }
  if (/\bimport\s+['"]/.test(src) && !/from\s+['"]/.test(src)) {
    file.fail("Side-effect-only MDX imports are not allowed.", node, "archon:mdx-facade-import");
  }
  if (/\bimport\s*\(/.test(src)) {
    file.fail("Dynamic import() is not allowed in MDX.", node, "archon:mdx-facade-import");
  }
  if (/\bimport\b/.test(src) && !sawImport) {
    file.fail("Unsupported MDX import syntax.", node, "archon:mdx-facade-import");
  }
}

/**
 * Validates `import … from '@archon/*'` facades and removes `mdxjsEsm` nodes so remark trust rules
 * (which forbid ESM) still pass; JSX uses MDXProvider / component map for those symbols.
 */
export function remarkArchonMdxFacadeImports(): Plugin<[], Root> {
  return function attacher() {
    return function transformer(tree: Root, file) {
      const removals: Array<{ parent: Parent; index: number }> = [];
      visit(tree, "mdxjsEsm", (node, index, parent) => {
        validateAndStripMdxjsEsm(node, file);
        if (parent && typeof index === "number" && Array.isArray((parent as Parent).children)) {
          removals.push({ parent: parent as Parent, index });
        }
      });
      removals
        .sort((a, b) => b.index - a.index)
        .forEach(({ parent, index }) => {
          parent.children.splice(index, 1);
        });
    };
  };
}
