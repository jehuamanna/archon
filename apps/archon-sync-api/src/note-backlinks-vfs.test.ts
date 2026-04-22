import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildVfsBacklinkTarget,
  contentReferencesTargetViaVfs,
  normalizeVfsSegment,
} from "./note-backlinks-vfs.js";

const target = buildVfsBacklinkTarget({
  projectId: "proj-1",
  workspaceName: "Testing",
  projectName: "Image",
  title: "jehu",
});

describe("contentReferencesTargetViaVfs", () => {
  it("matches a same-project relative image embed to a target in the same project", () => {
    const content = "Intro text.\n\n![jehu](#/w/./jehu)\n\nOutro.";
    const ok = contentReferencesTargetViaVfs(
      content,
      { projectId: "proj-1" },
      target,
    );
    assert.equal(ok, true);
  });

  it("does not match a same-project relative ref when embedder is in a different project", () => {
    const content = "![jehu](#/w/./jehu)";
    const ok = contentReferencesTargetViaVfs(
      content,
      { projectId: "proj-other" },
      target,
    );
    assert.equal(ok, false);
  });

  it("matches an absolute canonical vFS embed across projects", () => {
    const content = "![j](#/w/Testing/Image/jehu)";
    const ok = contentReferencesTargetViaVfs(
      content,
      { projectId: "proj-elsewhere" },
      target,
    );
    assert.equal(ok, true);
  });

  it("does not match when workspace or project segment differs", () => {
    const content = "![j](#/w/Testing/OtherProject/jehu)";
    const ok = contentReferencesTargetViaVfs(
      content,
      { projectId: "proj-elsewhere" },
      target,
    );
    assert.equal(ok, false);
  });

  it("ignores tree-relative refs in slice 3a (documented limit)", () => {
    const content = "![j](#/w/../jehu)";
    const ok = contentReferencesTargetViaVfs(
      content,
      { projectId: "proj-1" },
      target,
    );
    assert.equal(ok, false);
  });

  it("ignores hrefs that aren't vFS (#/n/, plain URLs, bare text)", () => {
    const content = [
      "[direct](#/n/6d196a6b-eb3b-46b5-baf3-ce80c1bc79c5)",
      "[ext](https://example.com/jehu)",
      "Just text with jehu in it.",
    ].join("\n");
    const ok = contentReferencesTargetViaVfs(
      content,
      { projectId: "proj-1" },
      target,
    );
    assert.equal(ok, false);
  });

  it("matches the first hit and short-circuits (multiple embeds ok)", () => {
    const content = [
      "![a](https://example.com/a.png)",
      "![jehu](#/w/./jehu)",
      "![z](#/w/./jehu)",
    ].join("\n");
    const ok = contentReferencesTargetViaVfs(
      content,
      { projectId: "proj-1" },
      target,
    );
    assert.equal(ok, true);
  });

  it("returns false on empty content without throwing", () => {
    assert.equal(
      contentReferencesTargetViaVfs("", { projectId: "proj-1" }, target),
      false,
    );
  });

  it("normalizes slashes in title segments (U+2215 substitution)", () => {
    // Title with a literal forward slash should normalize consistently on
    // both sides (target + ref parse) so the match still fires.
    const slashyTarget = buildVfsBacklinkTarget({
      projectId: "proj-1",
      workspaceName: "WS",
      projectName: "P",
      title: "a/b",
    });
    const encoded = encodeURIComponent("a/b");
    const content = `![x](#/w/WS/P/${encoded})`;
    const ok = contentReferencesTargetViaVfs(
      content,
      { projectId: "proj-elsewhere" },
      slashyTarget,
    );
    assert.equal(ok, true);
  });

  it("buildVfsBacklinkTarget produces U+2215 in every segment derived from raw forward slashes", () => {
    const t = buildVfsBacklinkTarget({
      projectId: "p",
      workspaceName: "w/1",
      projectName: "p/2",
      title: "t/3",
    });
    assert.ok(!t.canonicalAbsolutePath.includes("/w/")); // no raw "w/"
    // Exactly 2 separator slashes between the 3 normalized segments.
    const parts = t.canonicalAbsolutePath.split("/");
    assert.equal(parts.length, 3);
    assert.equal(parts[0], normalizeVfsSegment("w/1", "Workspace"));
    assert.equal(parts[1], normalizeVfsSegment("p/2", "Project"));
    assert.equal(parts[2], normalizeVfsSegment("t/3", "Untitled"));
  });
});
