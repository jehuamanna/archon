import type { ObjectId } from "mongodb";
import { z } from "zod";

export type NotificationType = "org_invite";

export type NotificationStatus = "unread" | "read" | "consumed" | "dismissed";

export type OrgInviteNotificationPayload = {
  inviteId: string;
  orgId: string;
  orgName: string;
  inviterUserId: string;
  inviterDisplayName: string;
  inviterEmail: string;
  role: "admin" | "member";
  spaceGrants: { spaceId: string; spaceName: string; role: "owner" | "member" | "viewer" }[];
  expiresAt: string;
};

export type NotificationDoc = {
  _id: ObjectId;
  userId: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  link: string;
  status: NotificationStatus;
  createdAt: Date;
  readAt?: Date;
  consumedAt?: Date;
  dismissedAt?: Date;
  /** Idempotency key (e.g. "org_invite:<inviteId>") for upsert-on-insert. */
  dedupeKey?: string;
};

export const notificationStatusSchema = z.enum([
  "unread",
  "read",
  "consumed",
  "dismissed",
]);

export const listNotificationsQuery = z.object({
  since: z.string().min(1).max(64).optional(),
  unread: z.enum(["0", "1"]).optional(),
  includeConsumed: z.enum(["0", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const markNotificationsReadBody = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuery>;
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadBody>;
