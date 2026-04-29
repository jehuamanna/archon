/**
 * Build Content-Security-Policy for the web shell.
 * In production, `connect-src` must include any absolute sync API origin (cross-origin fetch).
 */
function tryOrigin(raw: string | undefined): string | null {
  const t = raw?.trim();
  if (!t) {
    return null;
  }
  try {
    return new URL(t).origin;
  } catch {
    return null;
  }
}

function r2AssetSources(): string[] {
  const out: string[] = [];
  const explicit = tryOrigin(process.env.R2_PUBLIC_BASE);
  if (explicit) out.push(explicit);
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  if (accountId) {
    out.push(`https://${accountId}.r2.cloudflarestorage.com`);
    /**
     * `@aws-sdk/client-s3` defaults to virtual-host style for presigned URLs
     * (`forcePathStyle: false`), so R2 serves them from
     * `<bucket>.<accountId>.r2.cloudflarestorage.com`. The wildcard covers
     * that host pattern without pinning to a specific bucket name.
     */
    out.push(`https://*.${accountId}.r2.cloudflarestorage.com`);
  }
  return out;
}

function syncOriginAsWs(httpOrigin: string | null): string | null {
  if (!httpOrigin) return null;
  if (httpOrigin.startsWith("https://")) return `wss://${httpOrigin.slice(8)}`;
  if (httpOrigin.startsWith("http://")) return `ws://${httpOrigin.slice(7)}`;
  return null;
}

export function buildContentSecurityPolicy(): string {
  const syncOrigin = tryOrigin(process.env.NEXT_PUBLIC_ARCHON_SYNC_API_URL);
  const syncWsOrigin = syncOriginAsWs(syncOrigin);
  const r2Sources = r2AssetSources();

  const connectParts = [
    "'self'",
    "archon-pdf-worker:",
    "blob:",
    "https://api.github.com",
    ...(syncOrigin ? [syncOrigin] : []),
    ...(syncWsOrigin ? [syncWsOrigin] : []),
    ...r2Sources,
  ];
  if (process.env.NODE_ENV !== "production") {
    /**
     * Scheme-only sources allow any `http:` / `ws:` origin so dev access from
     * LAN IPs (e.g. `http://172.16.5.144:3000` hitting sync-api on the same
     * host:4010) isn't blocked. Production keeps the explicit `syncOrigin`
     * allowlist above.
     */
    connectParts.push("http:", "https:", "ws:", "wss:");
  }

  const imgParts = ["'self'", "data:", "blob:", "archon-asset:", ...r2Sources];
  const mediaParts = ["'self'", "data:", "blob:", "archon-asset:", ...r2Sources];

  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
    "script-src-elem 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgParts.join(" ")}`,
    `media-src ${mediaParts.join(" ")}`,
    "font-src 'self' data:",
    `connect-src ${connectParts.join(" ")}`,
    "worker-src 'self' blob: archon-pdf-worker:",
    "frame-src 'self' archon-asset: blob: data: about: https://observablehq.com https://*.observablehq.com",
    "object-src 'self' archon-asset: blob: data:",
  ].join("; ");
}
