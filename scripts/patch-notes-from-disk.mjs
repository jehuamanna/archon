#!/usr/bin/env node
// Patch a set of Archon notes with the content of a local SKILL.md file.
// Used to backfill child notes that have no canonical source inside Archon
// (authored locally and pushed back to the project tree).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.ARCHON_SYNC_API_BASE || "http://localhost:3000/api/v1";
const AUTH_PATH = join(homedir(), ".config/archon/mcp-cloud-auth.json");
const SKILLS_DIR = "/home/niveus/srv/archon/skills";
const ARCHON_SPACE_ID = "69eab6c02d8d5e5899eaacd0";

const MAPPINGS = [
  { childId: "961131d8-b925-4fab-b063-a74b7d6bb3b4", dir: "archon-clarify-prompts" },
  { childId: "0ca86fe7-37ac-4bc7-a465-1909312b8d98", dir: "archon-create-tasks" },
  { childId: "78b0ada2-fa2a-4a85-92c8-dd4d164fbe6f", dir: "archon-analyze" },
];

function loadAuth() {
  const j = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  const token = j.access_token || j.accessToken || j.token;
  const orgId = j.active_org_id || j.activeOrgId || null;
  if (typeof token !== "string" || !token) throw new Error("auth file: no access token");
  return { token, orgId };
}

function authHeaders(auth) {
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${auth.token}`,
    "X-Archon-Space": ARCHON_SPACE_ID,
  };
  if (auth.orgId) h["X-Archon-Org"] = auth.orgId;
  return h;
}

async function patchNote(noteId, content, auth) {
  const res = await fetch(`${BASE}/wpn/notes/${encodeURIComponent(noteId)}`, {
    method: "PATCH",
    headers: authHeaders(auth),
    body: JSON.stringify({ content }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PATCH ${noteId} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function main() {
  const auth = loadAuth();
  let ok = 0;
  for (const m of MAPPINGS) {
    const file = join(SKILLS_DIR, m.dir, "SKILL.md");
    const body = readFileSync(file, "utf8");
    try {
      await patchNote(m.childId, body, auth);
      console.log(`ok   ${m.dir}  (${body.length} bytes)`);
      ok++;
    } catch (e) {
      console.log(`FAIL ${m.dir}: ${e.message || e}`);
    }
  }
  console.log(`\n${ok}/${MAPPINGS.length} patched`);
  if (ok !== MAPPINGS.length) process.exit(1);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(2);
});
