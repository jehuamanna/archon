import * as crypto from "node:crypto";
import { getDb } from "./pg.js";
import { auditEvents } from "./db/schema.js";
import type { AuditAction } from "./org-schemas.js";

export type RecordAuditInput = {
  orgId: string;
  actorUserId: string;
  action: AuditAction;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown> | null;
  /**
   * Optional principal block. When supplied, the principal merges into
   * `metadata.principal` so downstream readers can distinguish user vs MCP
   * authorship without joining other tables.
   */
  principal?: { type: "user" | "mcp"; metadata?: Record<string, unknown> };
};

/**
 * Persist an audit event. Best-effort: failures are swallowed so audit cannot
 * block the user-facing operation. Callers should record AFTER the mutation
 * succeeds so we never log phantom events.
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  const merged: Record<string, unknown> | null = (() => {
    if (!input.metadata && !input.principal) return null;
    const base: Record<string, unknown> = { ...(input.metadata ?? {}) };
    if (input.principal) base.principal = input.principal;
    return base;
  })();
  try {
    await getDb().insert(auditEvents).values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: merged,
      ts: new Date(),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[audit] insert failed", err);
  }
}
