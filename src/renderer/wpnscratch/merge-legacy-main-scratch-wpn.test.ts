import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergeLegacyMainScratchWpnIntoScratchBundle,
  type LegacyMainScratchWpnBundle,
} from "./merge-legacy-main-scratch-wpn.ts";
import type { WpnNoteRow, WpnProjectRow, WpnWorkspaceRow } from "../../shared/wpn-v2-types.ts";

const baseWs = (id: string): WpnWorkspaceRow => ({
  id,
  name: "W",
  sort_index: 0,
  color_token: null,
  created_at_ms: 1,
  updated_at_ms: 1,
});

const baseProj = (id: string, wid: string): WpnProjectRow => ({
  id,
  workspace_id: wid,
  name: "P",
  sort_index: 0,
  color_token: null,
  created_at_ms: 1,
  updated_at_ms: 1,
});

const baseNote = (id: string, pid: string): WpnNoteRow => ({
  id,
  project_id: pid,
  parent_id: null,
  type: "markdown",
  title: "T",
  content: "",
  metadata_json: null,
  sibling_index: 0,
  created_at_ms: 1,
  updated_at_ms: 1,
});

describe("mergeLegacyMainScratchWpnIntoScratchBundle", () => {
  it("adds legacy rows when existing is empty", () => {
    const legacy: LegacyMainScratchWpnBundle = {
      workspaces: [baseWs("w1")],
      projects: [baseProj("p1", "w1")],
      notes: [baseNote("n1", "p1")],
      explorer: [{ project_id: "p1", expanded_ids: ["n1"] }],
    };
    const out = mergeLegacyMainScratchWpnIntoScratchBundle(
      { workspaces: [], projects: [], notes: [], explorer: [] },
      legacy,
    );
    assert.equal(out.workspaces.length, 1);
    assert.equal(out.projects.length, 1);
    assert.equal(out.notes.length, 1);
    assert.equal(out.explorer.length, 1);
  });

  it("keeps existing on id collision (idempotent)", () => {
    const existingWs = baseWs("w1");
    existingWs.name = "Existing";
    const legacy: LegacyMainScratchWpnBundle = {
      workspaces: [{ ...baseWs("w1"), name: "Legacy" }],
      projects: [],
      notes: [],
      explorer: [],
    };
    const out = mergeLegacyMainScratchWpnIntoScratchBundle(
      { workspaces: [existingWs], projects: [], notes: [], explorer: [] },
      legacy,
    );
    assert.equal(out.workspaces.length, 1);
    assert.equal(out.workspaces[0]!.name, "Existing");
  });

  it("merges disjoint ids", () => {
    const legacy: LegacyMainScratchWpnBundle = {
      workspaces: [baseWs("w2")],
      projects: [baseProj("p2", "w2")],
      notes: [],
      explorer: [],
    };
    const out = mergeLegacyMainScratchWpnIntoScratchBundle(
      {
        workspaces: [baseWs("w1")],
        projects: [baseProj("p1", "w1")],
        notes: [],
        explorer: [],
      },
      legacy,
    );
    assert.equal(out.workspaces.length, 2);
    assert.equal(out.projects.length, 2);
  });
});
