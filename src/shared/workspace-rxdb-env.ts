export function isLocalRxdbWpnMirrorEnabledEnv(): boolean {
  try {
    return (
      process.env.ARCHON_LOCAL_RXDB_WPN === "1" ||
      process.env.ARCHON_LOCAL_RXDB_WPN === "true"
    );
  } catch {
    return false;
  }
}

export const WORKSPACE_RXDB_AUTHORITY_ENV = "ARCHON_WORKSPACE_RXDB_AUTHORITY";

export function isWorkspaceRxdbAuthorityEnvEnabled(): boolean {
  try {
    return process.env[WORKSPACE_RXDB_AUTHORITY_ENV] === "1";
  } catch {
    return false;
  }
}
