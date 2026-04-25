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
};

/**
 * Persist an audit event. Best-effort: failures are swallowed so audit cannot
 * block the user-facing operation. Callers should record AFTER the mutation
 * succeeds so we never log phantom events.
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    await getDb().insert(auditEvents).values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: input.metadata ?? null,
      ts: new Date(),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[audit] insert failed", err);
  }
}
