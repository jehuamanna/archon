/**
 * PLAN-06 slice 2 — compact search hints attached to flat explorer note rows.
 *
 * The explorer's `WpnNoteListItemOut` deliberately omits `metadata` to keep
 * list payloads small. But slice 2 needs alt-text and caption matching in
 * the client-side filter, so this helper emits a tiny opt-in `search_hints`
 * object holding just those two strings (for image notes that set them).
 * Bandwidth overhead is bounded: at most two short strings per image note
 * and zero bytes for every other type.
 *
 * Kept pure so it can be unit-tested without spinning up Mongo.
 */

export type NoteSearchHints = {
  altText?: string;
  caption?: string;
};

const MAX_HINT_LENGTH = 512;

function trimHint(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_HINT_LENGTH
    ? trimmed.slice(0, MAX_HINT_LENGTH)
    : trimmed;
}

/**
 * Pull search-relevant metadata fields off a note doc. Returns `undefined`
 * when no hints apply — callers should omit the key rather than emit `{}`.
 * Currently only image notes contribute hints; other types return undefined.
 */
export function buildNoteSearchHints(args: {
  type: string;
  metadata: Record<string, unknown> | null | undefined;
}): NoteSearchHints | undefined {
  if (args.type !== "image" || !args.metadata) return undefined;
  const altText = trimHint(args.metadata.altText);
  const caption = trimHint(args.metadata.caption);
  if (altText === undefined && caption === undefined) return undefined;
  const out: NoteSearchHints = {};
  if (altText !== undefined) out.altText = altText;
  if (caption !== undefined) out.caption = caption;
  return out;
}
