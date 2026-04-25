import "./load-root-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { ARCHON_SYNC_API_V1_PREFIX } from "./api-v1-prefix.js";
import { verifyAccessToken } from "./auth.js";
import { buildSyncApiApp } from "./build-app.js";
import { setupPgTestSchema, type TestPgSchemaContext } from "./test-pg-helper.js";

const jwtSecret = "dev-only-archon-sync-secret-min-32-chars!!";
const PFX = ARCHON_SYNC_API_V1_PREFIX;

type RegisterResponse = {
  token: string;
  userId: string;
  defaultOrgId: string;
  defaultSpaceId: string;
};

async function registerUser(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<RegisterResponse & { email: string }> {
  const res = await app.inject({
    method: "POST",
    url: `${PFX}/auth/register`,
    payload: { email, password },
  });
  assert.strictEqual(res.statusCode, 200, res.body);
  return { ...(JSON.parse(res.body) as RegisterResponse), email };
}

test(
  "Phase 8: cross-org invite with space grants, notifications, decline path",
  { timeout: 30_000 },
  async (t) => {
    let app: FastifyInstance | undefined;
    let ctx: TestPgSchemaContext | undefined;
    try {
      ctx = await setupPgTestSchema();
    } catch (err) {
      t.skip(`Postgres not reachable: ${String(err)}`);
      return;
    }

    try {
      app = await buildSyncApiApp({ jwtSecret, corsOrigin: "true", logger: false });

      const adminA = await registerUser(
        app,
        `admin-a-${Date.now()}@nx.test`,
        "password12345",
      );
      const userB = await registerUser(
        app,
        `user-b-${Date.now()}@nx.test`,
        "password12345",
      );
      const aAuth = { authorization: `Bearer ${adminA.token}` };
      const bAuth = { authorization: `Bearer ${userB.token}` };

      const createSpace = await app.inject({
        method: "POST",
        url: `${PFX}/orgs/${adminA.defaultOrgId}/spaces`,
        headers: { ...aAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Shared Space" }),
      });
      assert.strictEqual(createSpace.statusCode, 200, createSpace.body);
      const { spaceId: sharedSpaceId } = JSON.parse(createSpace.body) as {
        spaceId: string;
      };

      // Cross-org grant must be rejected — userB's default space is in Org B.
      const badGrant = await app.inject({
        method: "POST",
        url: `${PFX}/orgs/${adminA.defaultOrgId}/invites`,
        headers: { ...aAuth, "content-type": "application/json" },
        payload: JSON.stringify({
          email: `someone-${Date.now()}@nx.test`,
          role: "member",
          spaceGrants: [{ spaceId: userB.defaultSpaceId, role: "member" }],
        }),
      });
      assert.strictEqual(badGrant.statusCode, 400, badGrant.body);

      const createInvite = await app.inject({
        method: "POST",
        url: `${PFX}/orgs/${adminA.defaultOrgId}/invites`,
        headers: { ...aAuth, "content-type": "application/json" },
        payload: JSON.stringify({
          email: userB.email,
          role: "member",
          spaceGrants: [
            { spaceId: adminA.defaultSpaceId, role: "member" },
            { spaceId: sharedSpaceId, role: "viewer" },
          ],
        }),
      });
      assert.strictEqual(createInvite.statusCode, 200, createInvite.body);
      const inviteJson = JSON.parse(createInvite.body) as {
        inviteId: string;
        token: string;
        spaceGrants: { spaceId: string; role: string }[];
      };
      assert.strictEqual(inviteJson.spaceGrants.length, 2);

      // Notification must appear for user B.
      const notifs = await app.inject({
        method: "GET",
        url: `${PFX}/me/notifications?unread=1`,
        headers: bAuth,
      });
      assert.strictEqual(notifs.statusCode, 200, notifs.body);
      const notifsJson = JSON.parse(notifs.body) as {
        notifications: Array<{
          id: string;
          type: string;
          link: string;
          status: string;
          payload: {
            inviteId: string;
            orgName: string;
            spaceGrants: { spaceName: string; role: string }[];
            inviterDisplayName: string;
            inviterEmail: string;
          };
        }>;
        unreadCount: number;
      };
      assert.strictEqual(notifsJson.unreadCount, 1);
      assert.strictEqual(notifsJson.notifications.length, 1);
      const notif = notifsJson.notifications[0]!;
      assert.strictEqual(notif.type, "org_invite");
      assert.strictEqual(notif.payload.inviteId, inviteJson.inviteId);
      assert.strictEqual(notif.payload.inviterEmail, adminA.email);
      assert.strictEqual(notif.payload.spaceGrants.length, 2);
      assert.match(notif.link, /^\/invite\//);

      // Preview includes inviter + named space grants.
      const preview = await app.inject({
        method: "GET",
        url: `${PFX}/auth/invites/preview?token=${encodeURIComponent(inviteJson.token)}`,
      });
      assert.strictEqual(preview.statusCode, 200, preview.body);
      const previewJson = JSON.parse(preview.body) as {
        inviter: { email: string; displayName: string };
        spaceGrants: Array<{ spaceId: string; spaceName: string; role: string }>;
        needsPassword: boolean;
      };
      assert.strictEqual(previewJson.inviter.email, adminA.email);
      assert.strictEqual(previewJson.needsPassword, false);
      assert.strictEqual(previewJson.spaceGrants.length, 2);

      // Mark unread → read.
      const markRead = await app.inject({
        method: "POST",
        url: `${PFX}/me/notifications/read`,
        headers: { ...bAuth, "content-type": "application/json" },
        payload: JSON.stringify({ ids: [notif.id] }),
      });
      assert.strictEqual(markRead.statusCode, 200);
      assert.strictEqual(
        (JSON.parse(markRead.body) as { updated: number }).updated,
        1,
      );

      // Decline: first succeeds, second is 404 (idempotent).
      const decline = await app.inject({
        method: "POST",
        url: `${PFX}/auth/decline-invite`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ token: inviteJson.token }),
      });
      assert.strictEqual(decline.statusCode, 200, decline.body);
      const declineAgain = await app.inject({
        method: "POST",
        url: `${PFX}/auth/decline-invite`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ token: inviteJson.token }),
      });
      assert.strictEqual(declineAgain.statusCode, 404);

      const postDeclineNotifs = await app.inject({
        method: "GET",
        url: `${PFX}/me/notifications?unread=1`,
        headers: bAuth,
      });
      const postDeclineJson = JSON.parse(postDeclineNotifs.body) as {
        unreadCount: number;
      };
      assert.strictEqual(postDeclineJson.unreadCount, 0);

      // Admin sees status=declined in the invite list.
      const list = await app.inject({
        method: "GET",
        url: `${PFX}/orgs/${adminA.defaultOrgId}/invites`,
        headers: aAuth,
      });
      const listJson = JSON.parse(list.body) as {
        invites: Array<{ inviteId: string; status: string }>;
      };
      const row = listJson.invites.find((r) => r.inviteId === inviteJson.inviteId);
      assert.ok(row);
      assert.strictEqual(row.status, "declined");

      // Fresh invite — B accepts.
      const reInvite = await app.inject({
        method: "POST",
        url: `${PFX}/orgs/${adminA.defaultOrgId}/invites`,
        headers: { ...aAuth, "content-type": "application/json" },
        payload: JSON.stringify({
          email: userB.email,
          role: "member",
          spaceGrants: [{ spaceId: sharedSpaceId, role: "viewer" }],
        }),
      });
      assert.strictEqual(reInvite.statusCode, 200, reInvite.body);
      const reInviteJson = JSON.parse(reInvite.body) as { token: string };

      const accept = await app.inject({
        method: "POST",
        url: `${PFX}/auth/accept-invite`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ token: reInviteJson.token }),
      });
      assert.strictEqual(accept.statusCode, 200, accept.body);
      const acceptJson = JSON.parse(accept.body) as {
        token: string;
        orgId: string;
        role: string;
        createdUser: boolean;
        spaceGrants: Array<{ spaceId: string; role: string }>;
      };
      assert.strictEqual(acceptJson.orgId, adminA.defaultOrgId);
      assert.strictEqual(acceptJson.createdUser, false);
      assert.strictEqual(acceptJson.spaceGrants.length, 1);

      // Phase 8: accept-invite must mint a JWT that carries BOTH activeOrgId
      // and activeSpaceId, pointing at a space the invitee can actually read.
      // When the invite grants any spaces, the active space must be one of
      // those grants (prefer the org default if granted, else the first
      // grant). Landing the invitee on the org's default when they have no
      // membership there leaves `/wpn/*` returning an empty tree.
      const acceptClaims = verifyAccessToken(jwtSecret, acceptJson.token);
      assert.strictEqual(acceptClaims.activeOrgId, adminA.defaultOrgId);
      assert.strictEqual(acceptClaims.activeSpaceId, sharedSpaceId);

      // Round-trip the switcher: B → own org → inviter's org. Each /orgs/active
      // response must carry a non-empty activeSpaceId matching the target org.
      const bAcceptAuth = { authorization: `Bearer ${acceptJson.token}` };
      const switchToOwn = await app.inject({
        method: "POST",
        url: `${PFX}/orgs/active`,
        headers: { ...bAcceptAuth, "content-type": "application/json" },
        payload: JSON.stringify({ orgId: userB.defaultOrgId }),
      });
      assert.strictEqual(switchToOwn.statusCode, 200, switchToOwn.body);
      const switchToOwnJson = JSON.parse(switchToOwn.body) as {
        token: string;
        activeOrgId: string;
        activeSpaceId: string;
      };
      assert.strictEqual(switchToOwnJson.activeOrgId, userB.defaultOrgId);
      assert.strictEqual(switchToOwnJson.activeSpaceId, userB.defaultSpaceId);
      const ownClaims = verifyAccessToken(jwtSecret, switchToOwnJson.token);
      assert.strictEqual(ownClaims.activeOrgId, userB.defaultOrgId);
      assert.strictEqual(ownClaims.activeSpaceId, userB.defaultSpaceId);

      const switchToInviter = await app.inject({
        method: "POST",
        url: `${PFX}/orgs/active`,
        headers: {
          authorization: `Bearer ${switchToOwnJson.token}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ orgId: adminA.defaultOrgId }),
      });
      assert.strictEqual(switchToInviter.statusCode, 200, switchToInviter.body);
      const switchToInviterJson = JSON.parse(switchToInviter.body) as {
        token: string;
        activeOrgId: string;
        activeSpaceId: string;
      };
      assert.strictEqual(switchToInviterJson.activeOrgId, adminA.defaultOrgId);
      // Switching back to the inviter restores `lastActiveSpaceByOrg[A]`,
      // which accept-invite set to the granted space (sharedSpaceId), not the
      // org default — that's where the invitee can actually read.
      assert.strictEqual(switchToInviterJson.activeSpaceId, sharedSpaceId);

      // Phase 8: /wpn/full-tree must return 200 with the expected shape for
      // either active org. Pre-fix, the second and third calls returned
      // `{workspaces:[], projects:[], ...}` with an 83B body because the scope
      // resolved to null; now the shape is populated-but-maybe-empty (real
      // empty is indistinguishable here since no workspaces were created —
      // the regression-guard is the 200 + claim assertions above).
      const tree = await app.inject({
        method: "GET",
        url: `${PFX}/wpn/full-tree`,
        headers: { authorization: `Bearer ${switchToInviterJson.token}` },
      });
      assert.strictEqual(tree.statusCode, 200, tree.body);
      const treeJson = JSON.parse(tree.body) as {
        workspaces: unknown[];
        projects: unknown[];
        notesByProjectId: Record<string, unknown>;
        explorerStateByProjectId: Record<string, unknown>;
      };
      assert.ok(Array.isArray(treeJson.workspaces));
      assert.ok(Array.isArray(treeJson.projects));

      // B now belongs to both orgs.
      const bOrgsAfter = await app.inject({
        method: "GET",
        url: `${PFX}/orgs/me`,
        headers: bAuth,
      });
      const bOrgsAfterJson = JSON.parse(bOrgsAfter.body) as {
        orgs: Array<{ orgId: string; role: string }>;
      };
      assert.ok(
        bOrgsAfterJson.orgs.some((o) => o.orgId === adminA.defaultOrgId),
      );
      assert.ok(
        bOrgsAfterJson.orgs.some((o) => o.orgId === userB.defaultOrgId),
      );

      // Re-accept the same token → 404 or 409.
      const acceptAgain = await app.inject({
        method: "POST",
        url: `${PFX}/auth/accept-invite`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ token: reInviteJson.token }),
      });
      assert.ok(
        acceptAgain.statusCode === 404 || acceptAgain.statusCode === 409,
        `expected 404/409 on re-accept, got ${acceptAgain.statusCode}`,
      );
    } finally {
      if (app) {
        await app.close();
      }
      await ctx?.teardown();
    }
  },
);
