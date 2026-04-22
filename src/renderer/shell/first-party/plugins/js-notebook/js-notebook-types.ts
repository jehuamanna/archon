export function makeNotebookCellId(): string {
  return `${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

export type NotebookCellKind = "js" | "md";

/** Persisted shape (JSON in notes / localStorage). */
export type NotebookCell = {
  id: string;
  name: string;
  inputs: string[];
  body: string;
  kind?: NotebookCellKind;
};

/** Prefer the function form when updating from inputs so fast typing never reads stale `cells`. */
export type NotebookCellsUpdate = NotebookCell[] | ((prev: NotebookCell[]) => NotebookCell[]);

export type NormalizedNotebookCell = {
  id: string;
  name: string;
  inputs: string[];
  body: string;
  kind: NotebookCellKind;
};

export function normalizeNotebookCells(cells: NotebookCell[]): NormalizedNotebookCell[] {
  const seen = new Set<string>();
  return cells
    .map((c) => {
      const trimmed = String(c.name || "").trim();
      const slug = c.id.replace(/\W/g, "") || "id";
      const name = trimmed || `cell_${slug.slice(0, 24)}`;
      return {
        id: c.id,
        name,
        inputs: (c.inputs || []).map((x) => String(x || "").trim()).filter(Boolean),
        body: String(c.body || "").trim(),
        kind: c.kind === "md" ? ("md" satisfies NotebookCellKind) : ("js" satisfies NotebookCellKind),
      };
    })
    .map((c): NormalizedNotebookCell => {
      let n = c.name;
      while (seen.has(n)) n = `${n}_`;
      seen.add(n);
      return {
        id: c.id,
        name: n,
        inputs: c.inputs,
        body: c.body,
        kind: c.kind === "md" ? "md" : "js",
      };
    });
}
