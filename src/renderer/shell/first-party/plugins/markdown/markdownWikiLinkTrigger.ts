/**
 * Returns the start index of `[[` and the filter text after it when the user is in “wiki link” input
 * (no `]` between `[[` and the caret).
 */
export function findActiveWikiLinkTrigger(
  value: string,
  cursor: number,
): { start: number; filter: string } | null {
  if (cursor < 2) return null;
  const before = value.slice(0, cursor);
  const idx = before.lastIndexOf("[[");
  if (idx < 0) return null;
  const segment = value.slice(idx + 2, cursor);
  if (segment.includes("]")) return null;
  return { start: idx, filter: segment };
}
