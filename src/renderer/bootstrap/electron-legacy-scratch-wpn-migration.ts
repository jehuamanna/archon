/**
 * One-shot: copy in-memory WPN from legacy Electron temp-dir scratch into IndexedDB, then clear main scratch.
 * Runs before `installElectronArchonIdbScratchProxy` so `window.Archon` is still the raw preload API.
 */
export async function runElectronLegacyScratchWpnMigrationOnce(): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }
  if (!navigator.userAgent.includes("Electron")) {
    return;
  }
  const nx = window.Archon;
  if (!nx?.pullLegacyScratchWpnMigrationPayload || !nx.ackLegacyScratchWpnMigrationImported) {
    return;
  }
  try {
    const r = await nx.pullLegacyScratchWpnMigrationPayload();
    if (!r.ok) {
      return;
    }
    const { applyLegacyMainScratchWpnMigration } = await import(
      "../wpnscratch/wpn-scratch-store"
    );
    await applyLegacyMainScratchWpnMigration(r.bundle);
    const ack = await nx.ackLegacyScratchWpnMigrationImported();
    if (!ack.ok) {
      console.warn("[archon] legacy scratch WPN migration ack failed:", ack.error);
    }
  } catch (e) {
    console.warn("[archon] legacy scratch WPN migration failed:", e);
  }
}
