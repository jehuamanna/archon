/**
 * Zero-cost-when-off tracer for diagnosing WPN refresh / overlay routing.
 * Enable in DevTools with `window.__ARCHON_WPN_TRACE__ = true`.
 */
export function wpnTrace(event: string, data?: unknown): void {
  if (typeof window === "undefined") return;
  if (!(window as Window & { __ARCHON_WPN_TRACE__?: boolean }).__ARCHON_WPN_TRACE__) {
    return;
  }
  if (data === undefined) {
    console.debug(`[wpn.trace] ${event}`);
  } else {
    console.debug(`[wpn.trace] ${event}`, data);
  }
}
