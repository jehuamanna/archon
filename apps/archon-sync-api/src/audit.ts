import { getAuditEventsCollection } from "./db.js";
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
    await getAuditEventsCollection().insertOne({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: input.metadata ?? null,
      ts: new Date(),
    } as never);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[audit] insert failed", err);
  }
}
