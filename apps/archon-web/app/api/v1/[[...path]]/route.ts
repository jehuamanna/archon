import { handleSyncApiRequest } from "../../../../lib/sync-api-route-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Vercel / long-running WPN batch — keep under your plan’s function cap. */
export const maxDuration = 60;

export function GET(request: Request) {
  return handleSyncApiRequest(request);
}

export function HEAD(request: Request) {
  return handleSyncApiRequest(request);
}

export function POST(request: Request) {
  return handleSyncApiRequest(request);
}

export function PUT(request: Request) {
  return handleSyncApiRequest(request);
}

export function PATCH(request: Request) {
  return handleSyncApiRequest(request);
}

export function DELETE(request: Request) {
  return handleSyncApiRequest(request);
}

export function OPTIONS(request: Request) {
  return handleSyncApiRequest(request);
}
