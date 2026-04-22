export type NotesMainPane =
  | { kind: "note" }
  | { kind: "asset"; relativePath: string; projectRoot: string };
