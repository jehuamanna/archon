#!/usr/bin/env node
// One-shot: pull each canonical SKILL.md from the Archon "Cross-Tool Skills /
// Canonical skills" tree, extract the fenced SKILL body, then (a) write it to
// skills/<name>/SKILL.md on disk and (b) PATCH the matching depth-1 child note
// under the "Skills" parent so project-tree notes carry the full skill source.
//
// Reads auth from ~/.config/archon/mcp-cloud-auth.json (same path the MCP
// server uses). Never logs the token.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const BASE = process.env.ARCHON_SYNC_API_BASE || "http://localhost:3000/api/v1";
const AUTH_PATH = join(homedir(), ".config/archon/mcp-cloud-auth.json");
const SKILLS_DIR = "/home/niveus/srv/archon/skills";
const ARCHON_SPACE_ID = "69eab6c02d8d5e5899eaacd0";

// Mapping: child noteId under `Skills` ← canonical noteId under `Canonical skills`.
// Each row also carries the on-disk skill dir name.
const MAPPINGS = [
  { childId: "f2828c8f-b9ce-4f79-8dcb-3ddaf43ccdc2", canonicalId: "0a581989-bab1-4157-8805-45c2d35e89fe", dir: "archon-use-seed-prompt",   title: "archon-use-seed-prompt" },
  { childId: "f6134dbc-12cb-4e34-9a30-5c25fd97b9c2", canonicalId: "eecb5dd0-fa0e-40a1-8f56-40527f99c59f", dir: "archon-create-prompts",    title: "archon-create-prompts" },
  { childId: "72d71dc9-ed22-45fa-8997-7f4eab86b7d6", canonicalId: "55b13341-6522-4219-8f58-80bec5b33e13", dir: "archon-create-plans",      title: "archon-create-plans" },
  { childId: "810c5cb2-86b1-4e91-84f8-8378f88faaa5", canonicalId: "634e35da-7243-48eb-b779-090f7b86e376", dir: "archon-create-test-cases", title: "archon-create-test-cases" },
  { childId: "44d2323a-8254-4251-b848-997aa62a0af0", canonicalId: "845206fd-79cf-4cb6-b861-f179552a1e0b", dir: "archon-execute-plans",     title: "archon-implement" },
  { childId: "73dbd14b-3fe9-4dff-b781-72620c4266b9", canonicalId: "e52a348a-eca0-4509-b481-ec52e8df48f8", dir: "archon-execute-test-cases", title: "archon-execute-test-cases" },
  { childId: "313aef15-c434-436b-b0a3-37345acc799d", canonicalId: "5fe0c1f0-3e52-44c8-8194-b721493c5d0c", dir: "archon-fix-bugs",          title: "archon-fix-bugs" },
  { childId: "0fc53b30-e1f4-4cf5-985e-258edfdcc0f1", canonicalId: "6cf6e8b0-7eb6-4ee6-bd7b-2c55ae255b2b", dir: "archon-cr-seed-prompts",   title: "archon-cr-seed-prompts" },
  { childId: "7a5714b2-8f1a-4684-92ed-a477603e6a6d", canonicalId: "1ba8d846-4274-43a3-b923-eb9b6c3ea72b", dir: "archon-execute-notes",     title: "archon-execute-notes" },
];

function loadAuth() {
  const raw = readFileSync(AUTH_PATH, "utf8");
  const j = JSON.parse(raw);
  const token = j.access_token || j.accessToken || j.token;
  const orgId = j.active_org_id || j.activeOrgId || null;
  if (typeof token !== "string" || !token) {
    throw new Error("auth file: no access token");
  }
  return { token, orgId };
}

function authHeaders(auth) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${auth.token}`,
    "X-Archon-Space": ARCHON_SPACE_ID,
  };
  if (auth.orgId) headers["X-Archon-Org"] = auth.orgId;
  return headers;
}

async function getNote(noteId, auth) {
  const res = await fetch(`${BASE}/wpn/notes/${encodeURIComponent(noteId)}`, {
    headers: authHeaders(auth),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${noteId} → ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  return j.note.content;
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

// Extract the fenced SKILL.md body from a canonical note's content.
// Opening fence may be ≥3 backticks; closer must be the same count to allow
// nested 3-backtick code blocks inside a 4-backtick SKILL wrapper.
function extractSkillBody(noteContent) {
  if (noteContent.startsWith("---\n")) {
    return noteContent;
  }
  const fenceRe = /(`{3,})markdown\n([\s\S]*?)\n\1(?!`)/g;
  let m;
  while ((m = fenceRe.exec(noteContent)) !== null) {
    const inner = m[2];
    if (inner.startsWith("---\n")) return inner;
  }
  throw new Error("no SKILL.md block found");
}

async function main() {
  const auth = loadAuth();
  const results = [];
  for (const m of MAPPINGS) {
    try {
      const canonical = await getNote(m.canonicalId, auth);
      const body = extractSkillBody(canonical);

      // Write canonical to disk.
      const filePath = join(SKILLS_DIR, m.dir, "SKILL.md");
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, body.endsWith("\n") ? body : body + "\n");

      // PATCH the child note with the same body.
      await patchNote(m.childId, body, auth);

      results.push({ title: m.title, bytes: body.length, ok: true });
      console.log(`ok   ${m.title}  (${body.length} bytes)`);
    } catch (e) {
      results.push({ title: m.title, ok: false, error: String(e.message || e) });
      console.log(`FAIL ${m.title}: ${e.message || e}`);
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} synced`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(2);
});
