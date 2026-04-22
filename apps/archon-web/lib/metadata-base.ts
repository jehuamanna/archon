import type { Metadata } from "next";

/**
 * Canonical site URL for absolute metadata (OG, etc.).
 * Prefer `NEXT_PUBLIC_ARCHON_SITE_URL` in production; Vercel provides `VERCEL_URL` during build.
 */
export function resolveMetadataBase(): Metadata["metadataBase"] {
  const explicit = process.env.NEXT_PUBLIC_ARCHON_SITE_URL?.trim();
  if (explicit) {
    try {
      return new URL(explicit);
    } catch {
      /* fall through */
    }
  }
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) {
    try {
      return new URL(`https://${vercel}`);
    } catch {
      /* fall through */
    }
  }
  return new URL("http://localhost:3000");
}
