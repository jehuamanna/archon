export function envString(name: string, fallback = ""): string {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : fallback;
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
