/** When set in the main process, `WorkspaceStore.persist` omits legacy flat-tree JSON (WPN-only on disk). */
export function isWpnOnlyFileVaultEnv(): boolean {
  try {
    return process.env.ARCHON_WPN_ONLY_FILE_VAULT === "1";
  } catch {
    return false;
  }
}

/** Opt out of automatic legacy flat → WPN migration on project open (default: migration runs when eligible). */
export function isLegacyFlatToWpnMigrationDisabled(): boolean {
  try {
    return process.env.ARCHON_MIGRATE_LEGACY_FLAT_TO_WPN === "0";
  } catch {
    return false;
  }
}
