import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { newHistory, pushState, redo, undo } from "./history.js";
import type { BuilderDoc } from "./ast.js";

function doc(tag: string): BuilderDoc {
  return {
    imports: { kind: "import", names: [] },
    body: [{ kind: "markdown", id: tag, source: tag }],
  };
}

describe("builder history", () => {
  test("undo returns null when past is empty", () => {
    const h = newHistory();
    assert.equal(undo(h, doc("a")), null);
  });

  test("redo returns null when future is empty", () => {
    const h = newHistory();
    assert.equal(redo(h, doc("a")), null);
  });

  test("push then undo restores prior state", () => {
    let h = newHistory();
    const a = doc("a");
    h = pushState(h, a);
    const current = doc("b");
    const r = undo(h, current);
    assert.ok(r);
    assert.equal(r?.restored.body[0].id, "a");
    assert.equal(r?.history.future.length, 1);
  });

  test("undo then redo gets back to same state", () => {
    let h = newHistory();
    const a = doc("a");
    h = pushState(h, a);
    const r1 = undo(h, doc("b"));
    assert.ok(r1);
    if (r1) {
      const r2 = redo(r1.history, r1.restored);
      assert.ok(r2);
      assert.equal(r2?.restored.body[0].id, "b");
    }
  });
});
