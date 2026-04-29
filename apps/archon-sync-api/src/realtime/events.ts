/**
 * Realtime structural-event contract. Every WS subscriber on a space sees a
 * stream of these events for note + edge mutations within the space; the
 * issuing client may dedupe via the echoed `clientOpId`.
 *
 * Designed as a discriminated union so the client can switch on `type`
 * without runtime helpers. Keeping the shapes flat (no nested objects) keeps
 * payloads under PG NOTIFY's 8KB cap with room to spare.
 */
export type RealtimeEventBase = {
  /** Opaque caller-supplied id, echoed back so the issuing client can dedupe. */
  clientOpId?: string;
  /** Server-stamped UTC ISO timestamp. */
  emittedAt: string;
};

export type NoteCreatedEvent = RealtimeEventBase & {
  type: "note.created";
  noteId: string;
  projectId: string;
  parentId: string | null;
  title: string;
  noteType: string;
  siblingIndex: number;
  createdByUserId: string;
};

export type NoteMovedEvent = RealtimeEventBase & {
  type: "note.moved";
  noteId: string;
  projectId: string;
  fromParentId: string | null;
  toParentId: string | null;
  fromSiblingIndex: number | null;
  toSiblingIndex: number | null;
  byUserId: string;
};

export type NoteRenamedEvent = RealtimeEventBase & {
  type: "note.renamed";
  noteId: string;
  projectId: string;
  oldTitle: string;
  newTitle: string;
  byUserId: string;
};

export type NoteDeletedEvent = RealtimeEventBase & {
  type: "note.deleted";
  noteId: string;
  projectId: string;
  byUserId: string;
};

export type EdgeAddedEvent = RealtimeEventBase & {
  type: "edge.added";
  src: string;
  dst: string;
  kind: string;
  byUserId: string;
};

export type EdgeRemovedEvent = RealtimeEventBase & {
  type: "edge.removed";
  src: string;
  dst: string;
  kind: string;
  byUserId: string;
};

export type RealtimeEvent =
  | NoteCreatedEvent
  | NoteMovedEvent
  | NoteRenamedEvent
  | NoteDeletedEvent
  | EdgeAddedEvent
  | EdgeRemovedEvent;

/**
 * Canonical PG NOTIFY channel name for an org. Using a `rt:` prefix keeps
 * realtime channels separate from the existing `mdx:` channels so a
 * single connection LISTENing to multiple namespaces is visible at a glance.
 */
export function channelForOrg(orgId: string): string {
  return `rt:org:${orgId}`;
}
