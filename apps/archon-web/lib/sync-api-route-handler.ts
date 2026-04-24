import fs from "node:fs";
import path from "node:path";
import {
  buildSyncApiApp,
  ensureMongoConnected,
  envString,
  requireJwtSecret,
} from "@archon/sync-api";
import type { FastifyInstance } from "fastify";
import type { InjectOptions } from "light-my-request";

type GlobalWithSync = typeof globalThis & {
  __archonSyncFastifyApp?: FastifyInstance;
  __archonSyncFastifyPromise?: Promise<FastifyInstance>;
};

function ensureBundledDocsPath(): void {
  if (process.env.ARCHON_BUNDLED_DOCS_DIR?.trim()) {
    return;
  }
  const candidates = [
    path.join(process.cwd(), "bundled-plugin-authoring"),
    path.join(process.cwd(), "apps", "archon-web", "bundled-plugin-authoring"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, "manifest.json"))) {
      process.env.ARCHON_BUNDLED_DOCS_DIR = p;
      return;
    }
  }
}

async function getSyncApiApp(): Promise<FastifyInstance> {
  const g = globalThis as GlobalWithSync;
  if (g.__archonSyncFastifyApp) {
    return g.__archonSyncFastifyApp;
  }
  g.__archonSyncFastifyPromise ??= (async () => {
    if (process.env.VERCEL === "1") {
      process.env.ARCHON_SYNC_API_SERVERLESS ??= "1";
    }
    ensureBundledDocsPath();
    const jwtSecret = requireJwtSecret();
    const corsOrigin = envString("CORS_ORIGIN", "true");
    const verbose =
      process.env.ARCHON_SYNC_API_VERBOSE === "1" ||
      process.env.NODE_ENV !== "production";
    const app = await buildSyncApiApp({
      jwtSecret,
      corsOrigin,
      logger: verbose,
    });
    g.__archonSyncFastifyApp = app;
    return app;
  })();
  return g.__archonSyncFastifyPromise;
}

function injectHeadersFromRequest(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (value) {
      headers[key] = value;
    }
  });
  return headers;
}

/**
 * Forward a Web `Request` to the Fastify sync-api app (same routes as `apps/archon-sync-api` Docker service).
 */
export async function handleSyncApiRequest(request: Request): Promise<Response> {
  await ensureMongoConnected();
  const app = await getSyncApiApp();

  const u = new URL(request.url);
  const injectUrl = u.pathname + u.search;

  let payload: string | Buffer | undefined;
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const buf = await request.arrayBuffer();
    payload = buf.byteLength > 0 ? Buffer.from(buf) : undefined;
  }

  const res = await app.inject({
    method: request.method as InjectOptions["method"],
    url: injectUrl,
    headers: injectHeadersFromRequest(request),
    payload,
  });

  const out = new Headers();
  for (const [key, val] of Object.entries(res.headers)) {
    if (val === undefined) {
      continue;
    }
    if (Array.isArray(val)) {
      for (const v of val) {
        out.append(key, v);
      }
    } else {
      out.set(key, String(val));
    }
  }

  // Always read `res.rawPayload` (Buffer), never `res.body` / `res.payload`
  // (string). The string form is UTF-8-decoded by light-my-request, which
  // corrupts binary responses (e.g. the export zip) by replacing every
  // invalid UTF-8 byte with U+FFFD. Uint8Array preserves bytes losslessly
  // for both binary and text responses; Content-Type is carried by `out`.
  const raw: Buffer | undefined = res.rawPayload;
  const body: BodyInit | null =
    res.statusCode === 204 || raw === undefined || raw.length === 0
      ? null
      : new Uint8Array(raw);

  return new Response(body, {
    status: res.statusCode,
    headers: out,
  });
}
