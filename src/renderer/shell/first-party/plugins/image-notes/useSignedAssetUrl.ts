import { useEffect, useRef, useState } from "react";
import { signImageAsset } from "./upload-image-asset";

/**
 * Module-local cache of presigned GET URLs, keyed by R2 key. Survives
 * editor remounts; cleared only on reload. Each entry is re-signed ~30s
 * before expiry so users don't see 403s mid-view.
 *
 * Plan 04: bounded to {@link MAX_ENTRIES} via LRU by last access. `Map`
 * preserves insertion order — to bump recency, `delete` then `set`.
 */
type CacheEntry = { url: string; expiresAt: number; inflight?: Promise<string> };
const cache = new Map<string, CacheEntry>();
const PREEMPT_MS = 30_000;
const MAX_ENTRIES = 200;

function touchRecency(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
}

function evictIfOver(): void {
  while (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    const oldest = cache.get(oldestKey);
    if (oldest?.inflight) {
      // In-flight entry — re-insert at the tail and stop evicting.
      cache.delete(oldestKey);
      cache.set(oldestKey, oldest);
      break;
    }
    cache.delete(oldestKey);
  }
}

async function resolveSigned(key: string): Promise<string> {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt - PREEMPT_MS > now) {
    touchRecency(key, existing);
    return existing.url;
  }
  if (existing?.inflight) {
    touchRecency(key, existing);
    return existing.inflight;
  }
  const inflight = (async () => {
    try {
      const { url, expiresAt } = await signImageAsset({ key, ttlSec: 900 });
      cache.set(key, { url, expiresAt });
      evictIfOver();
      return url;
    } finally {
      const cur = cache.get(key);
      if (cur) delete cur.inflight;
    }
  })();
  cache.set(key, {
    url: existing?.url ?? "",
    expiresAt: existing?.expiresAt ?? 0,
    inflight,
  });
  evictIfOver();
  return inflight;
}

export type SignedAssetUrlState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; error: string };

/**
 * Fetch and cache a presigned GET URL for an R2 key. Re-signs proactively
 * before TTL expiry. Returns `{ status: "idle" }` for null/empty keys so
 * callers can render an empty state without branching on undefined.
 *
 * Test seam: {@link _resetSignedAssetUrlCacheForTesting}.
 */
export function useSignedAssetUrl(key: string | null | undefined): SignedAssetUrlState {
  const [state, setState] = useState<SignedAssetUrlState>(() =>
    key ? { status: "loading" } : { status: "idle" },
  );
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    const active: string | null = key ?? null;
    keyRef.current = active;
    if (!active) {
      setState({ status: "idle" });
      return;
    }
    const activeKey: string = active;
    setState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    let cancelled = false;
    let reSignTimer: ReturnType<typeof setTimeout> | null = null;

    function kickOff() {
      resolveSigned(activeKey)
        .then((url) => {
          if (cancelled || keyRef.current !== activeKey) return;
          setState({ status: "ready", url });
          const entry = cache.get(activeKey);
          if (entry) {
            const ms = Math.max(5_000, entry.expiresAt - PREEMPT_MS - Date.now());
            reSignTimer = setTimeout(kickOff, ms);
          }
        })
        .catch((err: unknown) => {
          if (cancelled || keyRef.current !== activeKey) return;
          setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
        });
    }
    kickOff();

    return () => {
      cancelled = true;
      if (reSignTimer) clearTimeout(reSignTimer);
    };
  }, [key]);

  return state;
}

/** Test-only cache reset. */
export function _resetSignedAssetUrlCacheForTesting(): void {
  cache.clear();
}
