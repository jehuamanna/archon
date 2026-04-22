import assert from "node:assert/strict";
import test from "node:test";
import type { ShellTabInstance } from "../../registries/ShellTabsRegistry";
import {
  DOCUMENTATION_SHELL_TAB_TYPE_ID,
  documentationShareHashFragment,
  documentationStateFromPathSegments,
  hashDocumentationPathFromState,
  readDocumentationStateFromTab,
} from "./documentationShellHash.ts";

function docsTab(state: unknown): ShellTabInstance {
  return {
    instanceId: "i1",
    tabTypeId: DOCUMENTATION_SHELL_TAB_TYPE_ID,
    title: "Docs",
    state,
  };
}

test("documentationStateFromPathSegments parses hub heading", () => {
  assert.deepEqual(documentationStateFromPathSegments(["h", "overview"]), {
    view: "hub",
    headingSlug: "overview",
  });
});

test("documentationStateFromPathSegments parses command and optional slug", () => {
  assert.deepEqual(documentationStateFromPathSegments(["c", "archon.docs.open"]), {
    view: "command",
    commandId: "archon.docs.open",
  });
  assert.deepEqual(documentationStateFromPathSegments(["c", "archon.docs.open", "returns"]), {
    view: "command",
    commandId: "archon.docs.open",
    headingSlug: "returns",
  });
});

test("documentationStateFromPathSegments parses bundled note", () => {
  assert.deepEqual(documentationStateFromPathSegments(["n", "archon-docs-hub-overview"]), {
    view: "bundled",
    noteId: "archon-docs-hub-overview",
  });
});

test("documentationStateFromPathSegments parses bundled vfs path and optional heading", () => {
  assert.deepEqual(documentationStateFromPathSegments(["p", "Documentation", "Hub", "Overview"]), {
    view: "bundled",
    bundledVfsPath: "Documentation/Hub/Overview",
  });
  assert.deepEqual(
    documentationStateFromPathSegments(["p", "Documentation", "Hub", "Overview", "section-slug"]),
    {
      view: "bundled",
      bundledVfsPath: "Documentation/Hub/Overview",
      headingSlug: "section-slug",
    },
  );
});

test("hashDocumentationPathFromState round-trips command id with encoding", () => {
  const st = { view: "command" as const, commandId: "a.b", headingSlug: "args" };
  const path = hashDocumentationPathFromState(st);
  assert.equal(path, `/c/${encodeURIComponent("a.b")}/args`);
  const segs = path.split("/").filter(Boolean);
  assert.equal(segs[0], "c");
  const parsed = documentationStateFromPathSegments(segs);
  assert.deepEqual(parsed, st);
});

test("hashDocumentationPathFromState round-trips bundled note with heading slug", () => {
  const st = {
    view: "bundled" as const,
    noteId: "archon-bundled-plugin-complete-guide",
    headingSlug: "3-packaged-plugins-zip-marketplace",
  };
  const path = hashDocumentationPathFromState(st);
  assert.equal(path, "/n/archon-bundled-plugin-complete-guide/3-packaged-plugins-zip-marketplace");
  const segs = path.split("/").filter(Boolean);
  const parsed = documentationStateFromPathSegments(segs);
  assert.deepEqual(parsed, st);
});

/** Matches `hashForActiveTab` for documentation tabs (see shellTabUrlSync); kept here to avoid importing that module in node:test (ESM path resolution). */
test("documentationShareHashFragment uses bare tab type id for portable deep links", () => {
  assert.equal(
    documentationShareHashFragment({ view: "bundled", noteId: "archon-user-guide-layout" }),
    "#/t/plugin.documentation.tab/n/archon-user-guide-layout",
  );
  assert.equal(
    documentationShareHashFragment({
      view: "bundled",
      noteId: "archon-bundled-plugin-complete-guide",
      headingSlug: "3-packaged-plugins-zip-marketplace",
    }),
    "#/t/plugin.documentation.tab/n/archon-bundled-plugin-complete-guide/3-packaged-plugins-zip-marketplace",
  );
  assert.equal(
    documentationShareHashFragment({ view: "command", commandId: "archon.docs.open" }),
    "#/t/plugin.documentation.tab/c/archon.docs.open",
  );
});

test("readDocumentationStateFromTab ignores invalid documentation payloads", () => {
  assert.equal(readDocumentationStateFromTab(null), null);
  assert.equal(readDocumentationStateFromTab(docsTab({})), null);
  assert.equal(readDocumentationStateFromTab(docsTab({ documentation: {} })), null);
  assert.equal(readDocumentationStateFromTab(docsTab({ documentation: { view: "hub" } })), null);
  assert.deepEqual(
    readDocumentationStateFromTab(docsTab({ documentation: { view: "bundled", noteId: "n1" } })),
    { view: "bundled", noteId: "n1" },
  );
  assert.deepEqual(
    readDocumentationStateFromTab(
      docsTab({ documentation: { view: "bundled", bundledResolvingLogicalId: "archon-companion-user-guide" } }),
    ),
    { view: "bundled", bundledResolvingLogicalId: "archon-companion-user-guide" },
  );
});

test("hashDocumentationPathFromState omits ephemeral bundled resolving state from URL", () => {
  assert.equal(
    hashDocumentationPathFromState({
      view: "bundled",
      bundledResolvingLogicalId: "archon-companion-user-guide",
    }),
    "",
  );
});

test("hashDocumentationPathFromState encodes bundled vfs path", () => {
  const st = {
    view: "bundled" as const,
    bundledVfsPath: "Documentation/Hub/Overview",
    headingSlug: "intro",
  };
  const path = hashDocumentationPathFromState(st);
  assert.equal(path, "/p/Documentation/Hub/Overview/intro");
  const parsed = documentationStateFromPathSegments(path.split("/").filter(Boolean));
  assert.deepEqual(parsed, st);
});

test("readDocumentationStateFromTab reads bundledVfsPath", () => {
  assert.deepEqual(
    readDocumentationStateFromTab(
      docsTab({ documentation: { view: "bundled", bundledVfsPath: "A/B/C" } }),
    ),
    { view: "bundled", bundledVfsPath: "A/B/C" },
  );
});

test("documentationShareHashFragment includes p/ for vfs-only bundled state", () => {
  assert.equal(
    documentationShareHashFragment({ view: "bundled", bundledVfsPath: "X/Y/Z" }),
    "#/t/plugin.documentation.tab/p/X/Y/Z",
  );
});

test("documentation tab shell hash prefixes bundled deep link with instance id", () => {
  const instanceId = "plugin.documentation.tab:1775282179238:d01c6b6af71c18";
  const st = {
    view: "bundled" as const,
    noteId: "archon-bundled-plugin-complete-guide",
    headingSlug: "3-packaged-plugins-zip-marketplace",
  };
  const tail = hashDocumentationPathFromState(st);
  assert.equal(
    `#/t/${instanceId}${tail}`,
    "#/t/plugin.documentation.tab:1775282179238:d01c6b6af71c18/n/archon-bundled-plugin-complete-guide/3-packaged-plugins-zip-marketplace",
  );
});
