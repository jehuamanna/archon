import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseMdxToBuilderDoc } from "./parse.js";
import { serializeBuilderDoc } from "./serialize.js";

function roundTrip(source: string): string {
  const doc = parseMdxToBuilderDoc(source);
  return serializeBuilderDoc(doc);
}

describe("builder AST — parse/serialize", () => {
  test("empty source", () => {
    const out = roundTrip("");
    assert.equal(out, "\n");
  });

  test("editable component round-trips", () => {
    const src =
      `import { Button } from "@archon/mdx-sdk";\n\n<Button label="Hi" />\n`;
    const out = roundTrip(src);
    assert.ok(out.includes('import { Button } from "@archon/mdx-sdk";'));
    assert.ok(out.includes('<Button label="Hi" />'));
  });

  test("unknown tag preserved verbatim as advanced", () => {
    const src = `<CustomThing foo="1" bar={x + 2}>stuff</CustomThing>\n`;
    const out = roundTrip(src);
    assert.ok(out.includes("CustomThing"));
    assert.ok(out.includes("bar={x + 2}"));
  });

  test("inline expression preserved verbatim", () => {
    const src = `Hello {user.name.toUpperCase()}!\n`;
    const out = roundTrip(src);
    assert.ok(out.includes("{user.name.toUpperCase()}"));
  });

  test("mix of editable + advanced + markdown", () => {
    const src = [
      `import { Button } from "@archon/mdx-sdk";`,
      ``,
      `# Hello`,
      ``,
      `<Button label="Go" />`,
      ``,
      `{user.name}`,
      ``,
      `<Unknown prop={foo}>x</Unknown>`,
      ``,
    ].join("\n");
    const out = roundTrip(src);
    assert.ok(out.includes("# Hello"));
    assert.ok(out.includes('<Button label="Go" />'));
    assert.ok(out.includes("{user.name}"));
    assert.ok(out.includes("<Unknown prop={foo}>x</Unknown>"));
  });

  test("prop order is alphabetized on serialize", () => {
    const src = `<Input value="v" placeholder="p" onChange="c" />\n`;
    const out = roundTrip(src);
    // onChange < placeholder < value alphabetically.
    const idxOnChange = out.indexOf("onChange");
    const idxPlaceholder = out.indexOf("placeholder");
    const idxValue = out.indexOf("value");
    assert.ok(idxOnChange < idxPlaceholder && idxPlaceholder < idxValue);
  });

  test("number prop uses JSX expression", () => {
    const src = `<Chart stateKey="s" kind="bar" />\n`;
    const doc = parseMdxToBuilderDoc(src);
    const editable = doc.body.find((n) => n.kind === "editable");
    assert.ok(editable, "expected an editable node");
    if (editable && editable.kind === "editable") {
      editable.props.width = 42;
    }
    const out = serializeBuilderDoc(doc);
    assert.ok(out.includes("width={42}"));
  });

  test("parse is a fixed point for editable-only docs after one round", () => {
    const src = `import { Button } from "@archon/mdx-sdk";\n\n<Button label="Hi" />\n`;
    const first = roundTrip(src);
    const second = roundTrip(first);
    assert.equal(first, second);
  });
});
