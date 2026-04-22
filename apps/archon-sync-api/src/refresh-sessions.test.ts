import assert from "node:assert";
import { describe, it, afterEach } from "node:test";
import {
  buildSessionsAfterAppend,
  rotateRefreshSession,
  userHasRefreshJti,
} from "./refresh-sessions.js";

describe("refresh-sessions", () => {
  const prevMax = process.env.ARCHON_MAX_REFRESH_SESSIONS;

  afterEach(() => {
    if (prevMax === undefined) {
      delete process.env.ARCHON_MAX_REFRESH_SESSIONS;
    } else {
      process.env.ARCHON_MAX_REFRESH_SESSIONS = prevMax;
    }
  });

  it("userHasRefreshJti accepts legacy activeRefreshJti", () => {
    assert.equal(userHasRefreshJti({ activeRefreshJti: "j1" }, "j1"), true);
    assert.equal(userHasRefreshJti({ activeRefreshJti: "j1" }, "j2"), false);
  });

  it("userHasRefreshJti accepts refreshSessions array", () => {
    assert.equal(
      userHasRefreshJti(
        { refreshSessions: [{ jti: "x", createdAt: new Date() }] },
        "x",
      ),
      true,
    );
  });

  it("rotateRefreshSession migrates legacy single jti", () => {
    const next = rotateRefreshSession({ activeRefreshJti: "old" }, "old", "new");
    assert(next);
    assert.equal(next.length, 1);
    assert.equal(next[0]!.jti, "new");
  });

  it("buildSessionsAfterAppend evicts oldest when over cap", () => {
    process.env.ARCHON_MAX_REFRESH_SESSIONS = "2";
    const next = buildSessionsAfterAppend(
      {
        refreshSessions: [
          { jti: "a", createdAt: new Date(0) },
          { jti: "b", createdAt: new Date(1000) },
        ],
      },
      "c",
    );
    assert.equal(next.length, 2);
    assert.deepEqual(
      next.map((s) => s.jti).sort(),
      ["b", "c"],
    );
  });
});
