import type { MetadataRoute } from "next";

/** Required for `output: "export"` (Electron static web build). */
export const dynamic = "force-static";

/** Default: allow indexing; override with env if you ship a private deployment. */
export default function robots(): MetadataRoute.Robots {
  const disallowAll = process.env.ARCHON_ROBOTS_NOINDEX === "1";
  if (disallowAll) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return { rules: { userAgent: "*", allow: "/" } };
}
