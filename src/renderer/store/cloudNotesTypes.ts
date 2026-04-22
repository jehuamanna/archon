/** Matches `@archon/sync-api` notes collection (soft-delete aware). */
export type CloudNoteDoc = {
  id: string;
  updatedAt: number;
  deleted: boolean;
  version: number;
  title: string;
  content: string;
  type: "markdown" | "text" | "code";
};

export function isCloudNoteDoc(x: unknown): x is CloudNoteDoc {
  if (!x || typeof x !== "object") {
    return false;
  }
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.updatedAt === "number" &&
    typeof o.deleted === "boolean" &&
    typeof o.version === "number" &&
    typeof o.title === "string" &&
    typeof o.content === "string" &&
    (o.type === "markdown" || o.type === "text" || o.type === "code")
  );
}
