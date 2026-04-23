import Dexie, { type Table } from "dexie";

const CACHE_MAX_ENTRIES = 256;

interface CompileEntry {
  cacheKey: string; // sha256(source + sdkVersion)
  compiled: string; // compiled JS source from @mdx-js/mdx
  compiledAt: number;
  bytes: number;
}

class MdxCacheDB extends Dexie {
  entries!: Table<CompileEntry, string>;
  constructor() {
    super("archon-mdx-cache");
    this.version(1).stores({
      entries: "cacheKey, compiledAt",
    });
  }
}

let dbSingleton: MdxCacheDB | null = null;

function db(): MdxCacheDB {
  if (!dbSingleton) dbSingleton = new MdxCacheDB();
  return dbSingleton;
}

export async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function getCompiled(cacheKey: string): Promise<string | undefined> {
  try {
    const row = await db().entries.get(cacheKey);
    return row?.compiled;
  } catch {
    return undefined;
  }
}

export async function putCompiled(cacheKey: string, compiled: string): Promise<void> {
  try {
    await db().entries.put({
      cacheKey,
      compiled,
      compiledAt: Date.now(),
      bytes: compiled.length,
    });
    await evictLRU();
  } catch {
    /* IndexedDB may be unavailable in test envs — silently fall back */
  }
}

async function evictLRU(): Promise<void> {
  const count = await db().entries.count();
  if (count <= CACHE_MAX_ENTRIES) return;
  const overflow = count - CACHE_MAX_ENTRIES;
  const oldest = await db().entries
    .orderBy("compiledAt")
    .limit(overflow)
    .primaryKeys();
  if (oldest.length > 0) await db().entries.bulkDelete(oldest);
}

export async function clearCompileCache(): Promise<void> {
  await db().entries.clear();
}
