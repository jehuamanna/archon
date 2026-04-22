import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  clearPersistedMcpAuth,
  readPersistedMcpAuth,
  writePersistedMcpAuth,
} from "./mcp-cloud-auth-persist.js";

describe("mcp-cloud-auth-persist", () => {
  const origKey = process.env.ARCHON_MCP_TOKEN_ENCRYPTION_KEY;
  const tmp = path.join(os.tmpdir(), `mcp-auth-test-${Date.now()}.json`);

  afterEach(() => {
    if (origKey === undefined) {
      delete process.env.ARCHON_MCP_TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.ARCHON_MCP_TOKEN_ENCRYPTION_KEY = origKey;
    }
    clearPersistedMcpAuth(tmp);
  });

  it("writes and reads plain JSON", () => {
    delete process.env.ARCHON_MCP_TOKEN_ENCRYPTION_KEY;
    writePersistedMcpAuth(tmp, { accessToken: "a", refreshToken: "r" });
    const r = readPersistedMcpAuth(tmp);
    assert.deepEqual(r, { accessToken: "a", refreshToken: "r" });
  });

  it("writes and reads with encryption key", () => {
    process.env.ARCHON_MCP_TOKEN_ENCRYPTION_KEY = "unit-test-secret-key-material";
    writePersistedMcpAuth(tmp, { accessToken: "tok", refreshToken: "ref" });
    assert.ok(!fs.readFileSync(tmp, "utf8").includes("tok"));
    const r = readPersistedMcpAuth(tmp);
    assert.deepEqual(r, { accessToken: "tok", refreshToken: "ref" });
  });

  it("clear removes file", () => {
    delete process.env.ARCHON_MCP_TOKEN_ENCRYPTION_KEY;
    writePersistedMcpAuth(tmp, { accessToken: "x", refreshToken: "" });
    clearPersistedMcpAuth(tmp);
    assert.equal(readPersistedMcpAuth(tmp), null);
  });
});
