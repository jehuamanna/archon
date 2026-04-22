export const runtime = "nodejs";

/** Liveness probe (matches standalone `archon-sync-api` `GET /health`). */
export function GET() {
  return Response.json({ ok: true, service: "archon-sync-api" });
}
