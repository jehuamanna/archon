/**
 * In-memory presence map for the realtime stack. Each space carries a map of
 * `userId → state`; subscribers register a callback and receive snapshots on
 * every change. The 30s TTL reap is the safety net for connections that
 * disappear without firing the WS close handler.
 *
 * Single-instance only — multi-instance presence needs a shared store
 * (Redis pub/sub or similar). That's deferred per the Phase-4 plan.
 */
export interface PresenceState {
  noteId?: string;
  cursorOffset?: number;
  displayName?: string;
  color?: string;
  lastSeenAt: number;
}

const PRESENCE_TTL_MS = 30_000;
const REAP_INTERVAL_MS = 5_000;

const presenceMap = new Map<string, Map<string, PresenceState>>();
type Subscriber = (
  snapshot: Array<{ userId: string; state: PresenceState }>,
) => void;
const subscribers = new Map<string, Set<Subscriber>>();

function notifySpace(spaceId: string): void {
  const subs = subscribers.get(spaceId);
  if (!subs || subs.size === 0) return;
  const snapshot = snapshotPresence(spaceId);
  for (const cb of subs) {
    try {
      cb(snapshot);
    } catch {
      /* ignore subscriber errors */
    }
  }
}

export function setPresence(
  spaceId: string,
  userId: string,
  state: Omit<PresenceState, "lastSeenAt">,
): void {
  let inner = presenceMap.get(spaceId);
  if (!inner) {
    inner = new Map();
    presenceMap.set(spaceId, inner);
  }
  inner.set(userId, { ...state, lastSeenAt: Date.now() });
  notifySpace(spaceId);
}

export function dropPresence(spaceId: string, userId: string): void {
  const inner = presenceMap.get(spaceId);
  if (!inner) return;
  if (inner.delete(userId)) {
    if (inner.size === 0) presenceMap.delete(spaceId);
    notifySpace(spaceId);
  }
}

export function snapshotPresence(
  spaceId: string,
): Array<{ userId: string; state: PresenceState }> {
  const inner = presenceMap.get(spaceId);
  if (!inner) return [];
  const out: Array<{ userId: string; state: PresenceState }> = [];
  for (const [userId, state] of inner) {
    out.push({ userId, state });
  }
  return out;
}

export function onPresenceChange(spaceId: string, cb: Subscriber): () => void {
  let set = subscribers.get(spaceId);
  if (!set) {
    set = new Set();
    subscribers.set(spaceId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set && set.size === 0) subscribers.delete(spaceId);
  };
}

/** Drop entries older than `PRESENCE_TTL_MS`; called by the reap interval. */
export function reapPresence(): void {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  for (const [spaceId, inner] of presenceMap) {
    let dirty = false;
    for (const [userId, state] of inner) {
      if (state.lastSeenAt < cutoff) {
        inner.delete(userId);
        dirty = true;
      }
    }
    if (inner.size === 0) presenceMap.delete(spaceId);
    if (dirty) notifySpace(spaceId);
  }
}

let _reapTimer: NodeJS.Timeout | null = null;
export function startPresenceReaper(): void {
  if (_reapTimer) return;
  _reapTimer = setInterval(reapPresence, REAP_INTERVAL_MS);
  _reapTimer.unref();
}

export function stopPresenceReaper(): void {
  if (_reapTimer) {
    clearInterval(_reapTimer);
    _reapTimer = null;
  }
}

/** Test helper — drop all presence + subscribers between tests. */
export function _resetPresenceForTests(): void {
  presenceMap.clear();
  subscribers.clear();
  stopPresenceReaper();
}
