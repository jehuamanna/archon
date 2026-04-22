/** Default WPN row owner when `ARCHON_WPN_DEFAULT_OWNER` is unset (server / Electron main). */
export function getWpnOwnerId(): string {
  const raw = process.env.ARCHON_WPN_DEFAULT_OWNER?.trim();
  return raw && raw.length > 0 ? raw : "jehu";
}
