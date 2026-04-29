export function envString(name: string, fallback = ""): string {
  const v = process.env[name];
  console.log(`[ENV] envString(${name}) = ${v ? "[redacted]" : "(empty)"} (fallback = ${fallback})`);
  return typeof v === "string" ? v.trim() : fallback;
}
console.log("Postgres connection string:", process.env.DATABASE_URL ? "[redacted]" : "(empty)");


/**
 * Canonical Postgres connection string for sync-api. Reads `DATABASE_URL`
 * (the post-cutover env var per Plans-Phase-1 item 19); falls back to the
 * local-pg compose default for dev.
 */
export function databaseUrl(): string {
  const v = envString("DATABASE_URL");
  if (v.length > 0) return v;
  return "postgres://archon:archon@localhost:5432/archon_sync";
}

export function requireJwtSecret(): string {
  const s = envString("JWT_SECRET");
  const nodeEnv = envString("NODE_ENV", "development");
  if (s.length < 32 && nodeEnv === "production") {
    throw new Error("JWT_SECRET must be at least 32 characters in production");
  }
  if (s.length === 0) {
    if (nodeEnv === "production") {
      throw new Error("JWT_SECRET is required in production");
    }
    return "dev-only-archon-sync-secret-min-32-chars!!";
  }
  return s;
}

export function isImageNotesFeatureEnabled(): boolean {
  return envString("ARCHON_FEATURE_IMAGE_NOTES") === "1";
}

/**
 * Maximum total image-asset bytes allowed inside a single `/wpn/export` bundle.
 * Caps disk-scratch + network + client-download cost. 500 MiB default; override
 * via `ARCHON_EXPORT_MAX_BYTES` (accepts plain decimal bytes).
 */
export function exportMaxAssetBytes(): number {
  const raw = envString("ARCHON_EXPORT_MAX_BYTES");
  if (!raw) return 500 * 1024 * 1024;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 500 * 1024 * 1024;
  return Math.floor(parsed);
}

/**
 * Fail-fast at server startup when the image-notes feature flag is on but R2
 * env vars are absent — matches the JWT_SECRET pattern above. Silent when the
 * flag is off so non-image-notes deploys don't need R2 creds.
 */
export function requireImageNotesEnv(): void {
  if (!isImageNotesFeatureEnabled()) return;
  const required = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
  ];
  const missing = required.filter((k) => !envString(k));
  if (missing.length > 0) {
    throw new Error(
      `ARCHON_FEATURE_IMAGE_NOTES=1 but missing R2 env vars: ${missing.join(", ")}`,
    );
  }
}
