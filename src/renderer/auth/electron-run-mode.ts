/** Persisted choice on first launch (Electron only). */
export const ELECTRON_RUN_MODE_STORAGE_KEY = "archon.electron.runMode";

/** User-facing profiles: Scratch (ephemeral), Local (disk vault + IPC), Cloud (sync-api WPN). */
export type ElectronRunModeChoice = "scratch" | "local" | "cloud";

export type ElectronRunMode = ElectronRunModeChoice | "unset";

function normalizeAndMigrateStoredValue(raw: string | null): ElectronRunMode {
  if (raw === "scratch" || raw === "local" || raw === "cloud") {
    return raw;
  }
  /** Legacy `notes` → Local vault (same on-disk + IPC behavior as before). */
  if (raw === "notes") {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(ELECTRON_RUN_MODE_STORAGE_KEY, "local");
    }
    return "local";
  }
  return "unset";
}

export function readElectronRunMode(): ElectronRunMode {
  if (typeof window === "undefined") {
    return "unset";
  }
  const v = localStorage.getItem(ELECTRON_RUN_MODE_STORAGE_KEY);
  return normalizeAndMigrateStoredValue(v);
}

export function writeElectronRunMode(mode: ElectronRunModeChoice): void {
  localStorage.setItem(ELECTRON_RUN_MODE_STORAGE_KEY, mode);
}

/** Next launch (and in-memory state) treats run mode as unset → Electron welcome / run-mode picker. */
export function clearElectronRunMode(): void {
  if (typeof window === "undefined") {
    return;
  }
  localStorage.removeItem(ELECTRON_RUN_MODE_STORAGE_KEY);
}
