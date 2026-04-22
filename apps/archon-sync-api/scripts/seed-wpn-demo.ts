/**
 * Inserts a sample workspace → project → note for the given Mongo user id (JWT `sub` / register `userId`).
 * Usage: set MONGODB_URI in repo root `.env`, or pass env inline: MONGODB_URI=... npx tsx scripts/seed-wpn-demo.ts <userHexId>
 */
import "../src/load-root-env.js";
import * as crypto from "node:crypto";
import { connectMongo, closeMongo } from "../src/db.js";
import {
  getWpnNotesCollection,
  getWpnProjectsCollection,
  getWpnWorkspacesCollection,
} from "../src/db.js";

function envString(name: string, fallback = ""): string {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : fallback;
}

function nowMs(): number {
  return Date.now();
}

function newId(): string {
  return crypto.randomUUID();
}

async function main(): Promise<void> {
  const userId = process.argv[2]?.trim();
  if (!userId) {
    console.error("Usage: tsx scripts/seed-wpn-demo.ts <userHexId>");
    process.exit(1);
  }
  const uri = envString("MONGODB_URI", "mongodb://127.0.0.1:27017");
  const dbName = envString("MONGODB_DB", "archon_sync");
  await connectMongo(uri, dbName);
  const wsCol = getWpnWorkspacesCollection();
  const existing = await wsCol.countDocuments({ userId });
  if (existing > 0) {
    console.info(`User ${userId} already has ${existing} workspace(s); skip seed.`);
    await closeMongo();
    return;
  }
  const t = nowMs();
  const wsId = newId();
  const projId = newId();
  const noteId = newId();
  await wsCol.insertOne({
    id: wsId,
    userId,
    name: "Demo workspace",
    sort_index: 0,
    color_token: null,
    created_at_ms: t,
    updated_at_ms: t,
  });
  await getWpnProjectsCollection().insertOne({
    id: projId,
    userId,
    workspace_id: wsId,
    name: "Demo project",
    sort_index: 0,
    color_token: null,
    created_at_ms: t,
    updated_at_ms: t,
  });
  await getWpnNotesCollection().insertOne({
    id: noteId,
    userId,
    project_id: projId,
    parent_id: null,
    type: "markdown",
    title: "Welcome",
    content: "# Demo\n\nSeeded note for Mongo WPN P1 reads.",
    metadata: null,
    sibling_index: 0,
    created_at_ms: t,
    updated_at_ms: t,
  });
  console.info(`Seeded workspace ${wsId}, project ${projId}, note ${noteId} for user ${userId}`);
  await closeMongo();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
