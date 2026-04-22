import assert from "node:assert/strict";
import test from "node:test";
import { parseEphemeralShellTabInstanceId } from "./shellTabInstanceParse.ts";

test("parseEphemeralShellTabInstanceId extracts tab type from shared link id", () => {
  assert.equal(
    parseEphemeralShellTabInstanceId("plugin.documentation.tab:1775179236442:70592d94b3bae"),
    "plugin.documentation.tab",
  );
});

test("parseEphemeralShellTabInstanceId returns null for bare tab type id", () => {
  assert.equal(parseEphemeralShellTabInstanceId("plugin.documentation.tab"), null);
});

test("parseEphemeralShellTabInstanceId rejects implausible timestamp segment", () => {
  assert.equal(parseEphemeralShellTabInstanceId("shell.tab.welcome:1:abcd"), null);
});
