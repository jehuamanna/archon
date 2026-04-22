import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkspaceSlotWpnArrays } from "./wpn-slot-json-parse.ts";

test("parseWorkspaceSlotWpnArrays extracts WPN arrays from slot JSON", () => {
  const json = JSON.stringify({
    fileVersion: 1,
    workspaces: [
      {
        id: "ws-1",
        owner_id: "u1",
        name: "Main",
        sort_index: 0,
        color_token: null,
        created_at_ms: 1,
        updated_at_ms: 2,
      },
    ],
    projects: [
      {
        id: "p1",
        workspace_id: "ws-1",
        name: "Inbox",
        sort_index: 0,
        color_token: null,
        created_at_ms: 3,
        updated_at_ms: 4,
      },
    ],
    notes: [
      {
        id: "n1",
        project_id: "p1",
        parent_id: null,
        type: "markdown",
        title: "Hello",
        content: "body",
        metadata_json: null,
        sibling_index: 0,
        created_at_ms: 5,
        updated_at_ms: 6,
      },
    ],
    explorer: [{ project_id: "p1", expanded_ids: ["n1"] }],
  });
  const p = parseWorkspaceSlotWpnArrays(json);
  assert.equal(p.workspaces.length, 1);
  assert.equal(p.workspaces[0]!.id, "ws-1");
  assert.equal(p.projects[0]!.id, "p1");
  assert.equal(p.notes[0]!.title, "Hello");
  assert.deepEqual(p.explorer[0]!.expanded_ids, ["n1"]);
});
