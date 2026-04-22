import { getArchon } from "../../shared/archon-host-access";
/**
 * Dedupes concurrent and recent repeated fetches of note type lists (web: GET /notes/types/*).
 */

const TTL_MS = 30_000;

type CacheEntry<T> = { value: T; at: number };

let registeredCache: CacheEntry<string[]> | null = null;
let registeredInflight: Promise<string[]> | null = null;

let selectableCache: CacheEntry<string[]> | null = null;
let selectableInflight: Promise<string[]> | null = null;

export function invalidateArchonNoteTypesCaches(): void {
  registeredCache = null;
  selectableCache = null;
}

export async function getRegisteredTypesCached(): Promise<string[]> {
  const now = Date.now();
  if (registeredCache && now - registeredCache.at < TTL_MS) {
    return registeredCache.value;
  }
  if (registeredInflight) {
    return registeredInflight;
  }
  registeredInflight = (async () => {
    try {
      const t = await getArchon().getRegisteredTypes();
      const value = Array.isArray(t) ? t : [];
      registeredCache = { value, at: Date.now() };
      return value;
    } finally {
      registeredInflight = null;
    }
  })();
  return registeredInflight;
}

export async function getSelectableNoteTypesCached(): Promise<string[]> {
  const now = Date.now();
  if (selectableCache && now - selectableCache.at < TTL_MS) {
    return selectableCache.value;
  }
  if (selectableInflight) {
    return selectableInflight;
  }
  selectableInflight = (async () => {
    try {
      const t = await getArchon().getSelectableNoteTypes();
      const value = Array.isArray(t) ? t : [];
      selectableCache = { value, at: Date.now() };
      return value;
    } finally {
      selectableInflight = null;
    }
  })();
  return selectableInflight;
}
