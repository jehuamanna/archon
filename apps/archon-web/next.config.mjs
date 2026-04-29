import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";

// @next/env is CJS; `createRequire` avoids ESM named/default import mismatches in Docker `next build`.
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
loadEnvConfig(repoRoot, process.env.NODE_ENV !== "production");
const staticExport = process.env.ARCHON_NEXT_STATIC_EXPORT === "1";

const envHeadlessOrigin =
  process.env.ARCHON_HEADLESS_API_ORIGIN?.trim().replace(/\/$/, "") || "";

/**
 * When set, Next proxies /api/v1 and /marketplace/files to that origin (legacy dev only).
 * Default web dev (`npm run dev:web`) uses sync-api + `NEXT_PUBLIC_ARCHON_WEB_BACKEND=sync-only` — leave unset.
 * Prefer archon-gateway on :8080 with `NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN=1` (relative /api/v1, no rewrite in Next).
 *
 * **Vercel:** `ARCHON_HEADLESS_API_ORIGIN` is ignored unless `ARCHON_ALLOW_HEADLESS_REWRITE_ON_VERCEL=1`.
 * Otherwise an accidental env value proxies `/api/v1` to an older host and new routes (e.g. MCP
 * `POST /auth/mcp/device/start`) return 404 from that backend.
 */
let headlessApiOrigin = envHeadlessOrigin;
if (
  process.env.VERCEL === "1" &&
  envHeadlessOrigin &&
  process.env.ARCHON_ALLOW_HEADLESS_REWRITE_ON_VERCEL !== "1"
) {
  console.warn(
    "[archon] Ignoring ARCHON_HEADLESS_API_ORIGIN on Vercel so /api/v1 uses colocated sync-api. " +
      "Set ARCHON_ALLOW_HEADLESS_REWRITE_ON_VERCEL=1 only if you intentionally proxy /api/v1 elsewhere.",
  );
  headlessApiOrigin = "";
}

const securityHeaders =
  process.env.VERCEL === "1"
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : [];

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(staticExport ? { output: "export", assetPrefix: "./" } : {}),
  poweredByHeader: false,
  /**
   * Electron and some browsers load `http://127.0.0.1:3000` while dev defaults to `localhost`;
   * without this, Next 16 blocks `/_next/*` dev assets and the app can break or show wrong UI.
   */
  allowedDevOrigins: ["127.0.0.1", "localhost", "172.16.5.144"],
  transpilePackages: [
    "@archon/platform",
    "@archon/mdx-sdk-runtime",
    "@nodex-studio/mdx-sdk",
    "rxdb",
    "dexie",
  ],
  images: { unoptimized: true },
  async headers() {
    if (staticExport) {
      return [];
    }
    const base = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=()",
      },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "X-DNS-Prefetch-Control", value: "on" },
    ];
    return [
      {
        source: "/:path*",
        headers: [...securityHeaders, ...base],
      },
    ];
  },
  async rewrites() {
    if (staticExport || !headlessApiOrigin) {
      return [];
    }
    return [
      {
        source: "/api/v1/:path*",
        destination: `${headlessApiOrigin}/api/v1/:path*`,
      },
      {
        source: "/marketplace/files/:path*",
        destination: `${headlessApiOrigin}/marketplace/files/:path*`,
      },
    ];
  },
  experimental: {
    externalDir: true,
  },
  turbopack: {
    resolveAlias: {
      "@archon/ui-types": "../../src/shared/archon-preload-public-types.ts",
      "@archon/platform": "../../packages/archon-platform/src/index.ts",
      // Next resolves `node` for Client Component SSR; esnode pulls fs/path. Force browser build.
      "broadcast-channel": "../../node_modules/broadcast-channel/dist/esbrowser/index.js",
    },
  },
};

export default nextConfig;
