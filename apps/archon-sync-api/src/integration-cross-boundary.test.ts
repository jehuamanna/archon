import "./load-root-env.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { ARCHON_SYNC_API_V1_PREFIX } from "./api-v1-prefix.js";
import { buildSyncApiApp } from "./build-app.js";
import {
  closeMongo,
  connectMongo,
  getWpnNotesCollection,
  getWpnProjectsCollection,
  getWpnWorkspacesCollection,
} from "./db.js";
import { dropActiveMongoDb, resolveTestMongoUri } from "./test-mongo-helper.js";

const jwtSecret = "dev-only-archon-sync-secret-min-32-chars!!";

type RegisterResult = { token: string; userId: string; defaultOrgId: string };

async function registerUser(
  app: FastifyInstance,
  email: string,
): Promise<RegisterResult> {
  const r = await app.inject({
    method: "POST",
    url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/register`,
    payload: { email, password: "password12345" },
  });
  assert.strictEqual(r.statusCode, 200, r.body);
  return JSON.parse(r.body) as RegisterResult;
}

async function createWorkspace(
  app: FastifyInstance,
  auth: Record<string, string>,
  name: string,
): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces`,
    headers: { ...auth, "content-type": "application/json" },
    payload: JSON.stringify({ name }),
  });
  assert.strictEqual(r.statusCode, 201, r.body);
  return (JSON.parse(r.body) as { workspace: { id: string } }).workspace.id;
}

async function createProject(
  app: FastifyInstance,
  auth: Record<string, string>,
  wsId: string,
  name: string,
): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/projects`,
    headers: { ...auth, "content-type": "application/json" },
    payload: JSON.stringify({ name }),
  });
  assert.strictEqual(r.statusCode, 201, r.body);
  return (JSON.parse(r.body) as { project: { id: string } }).project.id;
}

async function createRootNote(
  app: FastifyInstance,
  auth: Record<string, string>,
  projectId: string,
  title: string,
  content = "",
): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${projectId}/notes`,
    headers: { ...auth, "content-type": "application/json" },
    payload: JSON.stringify({
      type: "markdown",
      relation: "root",
      title,
      content,
    }),
  });
  assert.strictEqual(r.statusCode, 201, r.body);
  return (JSON.parse(r.body) as { id: string }).id;
}

async function createChildNote(
  app: FastifyInstance,
  auth: Record<string, string>,
  projectId: string,
  anchorId: string,
  title: string,
): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${projectId}/notes`,
    headers: { ...auth, "content-type": "application/json" },
    payload: JSON.stringify({
      type: "markdown",
      relation: "child",
      anchorId,
      title,
    }),
  });
  assert.strictEqual(r.statusCode, 201, r.body);
  return (JSON.parse(r.body) as { id: string }).id;
}

test(
  "Cross-boundary: project duplicate + move within same space, cross-space refused on PATCH",
  { timeout: 30_000 },
  async (t) => {
    const dbName = `archon_sync_xb_proj_it_${randomBytes(8).toString("hex")}`;
    let app: FastifyInstance | undefined;

    try {
      await connectMongo(resolveTestMongoUri(), dbName);
    } catch (err) {
      t.skip(`MongoDB not reachable: ${String(err)}`);
      return;
    }

    try {
      app = await buildSyncApiApp({
        jwtSecret,
        corsOrigin: "true",
        logger: false,
      });

      const admin = await registerUser(app, `xb-admin-${Date.now()}@xb.test`);
      const adminAuth = { authorization: `Bearer ${admin.token}` };

      // Two workspaces in the same (default) space.
      const wsSrc = await createWorkspace(app, adminAuth, "Src");
      const wsDst = await createWorkspace(app, adminAuth, "Dst");
      const projId = await createProject(app, adminAuth, wsSrc, "Proj");
      const rootNote = await createRootNote(
        app,
        adminAuth,
        projId,
        "root",
        "hello",
      );
      const childNote = await createChildNote(
        app,
        adminAuth,
        projId,
        rootNote,
        "child",
      );

      // Duplicate into source workspace (default target).
      const dupSelf = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${projId}/duplicate`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ newName: "Proj Copy" }),
      });
      assert.strictEqual(dupSelf.statusCode, 201, dupSelf.body);
      const dupSelfJson = JSON.parse(dupSelf.body) as {
        projectId: string;
        name: string;
      };
      assert.notStrictEqual(dupSelfJson.projectId, projId);
      assert.strictEqual(dupSelfJson.name, "Proj Copy");
      // Two fresh notes in the new project, with preserved parent linkage.
      const dupNotes = await getWpnNotesCollection()
        .find({ project_id: dupSelfJson.projectId })
        .toArray();
      assert.strictEqual(dupNotes.length, 2);
      const dupRoot = dupNotes.find((n) => n.parent_id === null);
      assert.ok(dupRoot, "duplicated root present");
      const dupChild = dupNotes.find((n) => n.parent_id === dupRoot!.id);
      assert.ok(dupChild, "duplicated child linked to duplicated root");
      assert.notStrictEqual(dupRoot.id, rootNote);
      assert.notStrictEqual(dupChild.id, childNote);

      // Duplicate into dst workspace (same space).
      const dupDst = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${projId}/duplicate`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ targetWorkspaceId: wsDst }),
      });
      assert.strictEqual(dupDst.statusCode, 201, dupDst.body);
      const dupDstJson = JSON.parse(dupDst.body) as { projectId: string };
      const dupDstProj = await getWpnProjectsCollection().findOne({
        id: dupDstJson.projectId,
      });
      assert.ok(dupDstProj);
      assert.strictEqual(dupDstProj.workspace_id, wsDst);

      // Move original project to dst workspace via PATCH — same-space allowed.
      const moveProj = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${projId}`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ workspace_id: wsDst }),
      });
      assert.strictEqual(moveProj.statusCode, 200, moveProj.body);
      const movedProj = await getWpnProjectsCollection().findOne({ id: projId });
      assert.ok(movedProj);
      assert.strictEqual(movedProj.workspace_id, wsDst);

      // Set up a second space in the same org and create a workspace in it.
      const engSpaceRes = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/spaces`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Eng" }),
      });
      assert.strictEqual(engSpaceRes.statusCode, 200, engSpaceRes.body);
      const engSpaceId = (JSON.parse(engSpaceRes.body) as { spaceId: string })
        .spaceId;

      const otherSpaceWs = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces`,
        headers: {
          ...adminAuth,
          "content-type": "application/json",
          "x-archon-org": admin.defaultOrgId,
          "x-archon-space": engSpaceId,
        },
        payload: JSON.stringify({ name: "Eng WS" }),
      });
      assert.strictEqual(otherSpaceWs.statusCode, 201, otherSpaceWs.body);
      const engWsId = (
        JSON.parse(otherSpaceWs.body) as { workspace: { id: string } }
      ).workspace.id;

      // PATCH cross-space must be rejected.
      const crossSpaceMove = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${projId}`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ workspace_id: engWsId }),
      });
      assert.strictEqual(
        crossSpaceMove.statusCode,
        400,
        `cross-space PATCH should 400: ${crossSpaceMove.body}`,
      );

      // Duplicate cross-space also rejected.
      const crossSpaceDup = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${projId}/duplicate`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ targetWorkspaceId: engWsId }),
      });
      assert.strictEqual(
        crossSpaceDup.statusCode,
        400,
        `cross-space duplicate should 400: ${crossSpaceDup.body}`,
      );
    } finally {
      if (app) {
        await app.close();
      }
      await dropActiveMongoDb();
      try {
        await closeMongo();
      } catch {
        /* ignore */
      }
    }
  },
);

test(
  "Cross-boundary: duplicate workspace copies every project + note with fresh ids",
  { timeout: 30_000 },
  async (t) => {
    const dbName = `archon_sync_xb_ws_it_${randomBytes(8).toString("hex")}`;
    let app: FastifyInstance | undefined;

    try {
      await connectMongo(resolveTestMongoUri(), dbName);
    } catch (err) {
      t.skip(`MongoDB not reachable: ${String(err)}`);
      return;
    }

    try {
      app = await buildSyncApiApp({
        jwtSecret,
        corsOrigin: "true",
        logger: false,
      });
      const admin = await registerUser(app, `xb-ws-${Date.now()}@xb.test`);
      const adminAuth = { authorization: `Bearer ${admin.token}` };

      const wsId = await createWorkspace(app, adminAuth, "Root WS");
      const p1 = await createProject(app, adminAuth, wsId, "P1");
      const p2 = await createProject(app, adminAuth, wsId, "P2");
      const p1Root = await createRootNote(app, adminAuth, p1, "p1-root");
      await createChildNote(app, adminAuth, p1, p1Root, "p1-child");
      await createRootNote(app, adminAuth, p2, "p2-only");

      // Same-space duplicate.
      const dupRes = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/duplicate`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ newName: "Root WS Copy" }),
      });
      assert.strictEqual(dupRes.statusCode, 201, dupRes.body);
      const dupJson = JSON.parse(dupRes.body) as {
        workspaceId: string;
        name: string;
        projects: { projectId: string; name: string; sourceProjectId: string }[];
      };
      assert.notStrictEqual(dupJson.workspaceId, wsId);
      assert.strictEqual(dupJson.name, "Root WS Copy");
      assert.strictEqual(dupJson.projects.length, 2);

      // Every project id is new; every note id is new; note counts match.
      const srcProjIds = new Set([p1, p2]);
      const newProjIds = dupJson.projects.map((p) => p.projectId);
      for (const pid of newProjIds) {
        assert.ok(!srcProjIds.has(pid), "new project ids distinct");
      }
      const newWsProjects = await getWpnProjectsCollection()
        .find({ workspace_id: dupJson.workspaceId })
        .toArray();
      assert.strictEqual(newWsProjects.length, 2);
      const newNotes = await getWpnNotesCollection()
        .find({ project_id: { $in: newProjIds } })
        .toArray();
      assert.strictEqual(newNotes.length, 3);
      const origNotes = await getWpnNotesCollection()
        .find({ project_id: { $in: [p1, p2] } })
        .toArray();
      const origNoteIds = new Set(origNotes.map((n) => n.id));
      for (const n of newNotes) {
        assert.ok(!origNoteIds.has(n.id), "duplicated note id must be fresh");
      }

      // Workspace row carries a new id + creatorUserId = caller.
      const newWsDoc = await getWpnWorkspacesCollection().findOne({
        id: dupJson.workspaceId,
      });
      assert.ok(newWsDoc);
      assert.strictEqual(newWsDoc.creatorUserId, admin.userId);
    } finally {
      if (app) {
        await app.close();
      }
      await dropActiveMongoDb();
      try {
        await closeMongo();
      } catch {
        /* ignore */
      }
    }
  },
);
