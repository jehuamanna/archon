import assert from "node:assert/strict";
import test from "node:test";
import { createProcessor } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import { remarkArchonMdxFacadeImports } from "./remark-archon-mdx-facade-imports.ts";
import { remarkArchonMdxTrust } from "./remark-archon-mdx-trust.ts";

function workspaceMdxPlugins() {
  return [remarkGfm, remarkMdx, remarkArchonMdxFacadeImports(), remarkArchonMdxTrust("user")];
}

test("user tier rejects flow expression", async () => {
  const proc = createProcessor({
    remarkPlugins: [remarkGfm, remarkArchonMdxTrust("user")],
  });
  await assert.rejects(() => proc.process("{1 + 1}"), /MDX expressions and ESM are not allowed/);
});

test("user tier rejects text expression", async () => {
  const proc = createProcessor({
    remarkPlugins: [remarkGfm, remarkArchonMdxTrust("user")],
  });
  await assert.rejects(() => proc.process("Hello {1 + 1}"), /MDX expressions and ESM are not allowed/);
});

test("bundled tier allows expressions", async () => {
  const proc = createProcessor({
    remarkPlugins: [remarkGfm, remarkArchonMdxTrust("bundled")],
  });
  const out = await proc.process("{2 + 2}");
  assert.match(String(out), /2 \+ 2/);
});

test("bundled tier rejects import", async () => {
  const proc = createProcessor({
    remarkPlugins: [remarkGfm, remarkArchonMdxTrust("bundled")],
  });
  await assert.rejects(() => proc.process(`import x from "y"\n\n# Hi`), /import\/export is not allowed/);
});

test("workspace pipeline accepts @archon/ui facade import (stripped before trust)", async () => {
  const proc = createProcessor({
    remarkPlugins: workspaceMdxPlugins(),
  });
  const out = await proc.process("import { Button } from '@archon/ui'\n\n# Hi");
  assert.match(String(out), /Hi/);
});

test("workspace pipeline rejects non-facade import", async () => {
  const proc = createProcessor({
    remarkPlugins: workspaceMdxPlugins(),
  });
  await assert.rejects(
    () => proc.process(`import d from "dayjs"\n\n# Hi`),
    /not allowed/,
  );
});

