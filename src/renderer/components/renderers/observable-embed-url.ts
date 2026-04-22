/** `workspace/note` or `@workspace/note` — Observable embed path segment. */
const OBSERVABLE_NOTEBOOK_RE = /^@?[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const OBSERVABLE_CELL_RE = /^[a-zA-Z0-9_-]*$/;

export function observableEmbedSrc(notebook: string, cell?: string): string | null {
  const nb = String(notebook ?? "").trim();
  if (!OBSERVABLE_NOTEBOOK_RE.test(nb)) return null;
  const path = nb.startsWith("@") ? nb.slice(1) : nb;
  const src = `https://observablehq.com/embed/@${path}`;
  if (cell !== undefined && cell !== null && String(cell).length > 0) {
    const c = String(cell).trim();
    if (!OBSERVABLE_CELL_RE.test(c)) return null;
    return `${src}?cell=${encodeURIComponent(c)}`;
  }
  return src;
}
