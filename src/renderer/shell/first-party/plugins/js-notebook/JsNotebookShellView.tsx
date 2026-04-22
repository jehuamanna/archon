import React, { useCallback, useState } from "react";
import { useArchonContributionRegistry } from "../../../ArchonContributionContext";
import type { ShellViewComponentProps } from "../../../views/ShellViewRegistry";
import { JsNotebookWorkspace } from "./JsNotebookWorkspace";
import { makeNotebookCellId, type NotebookCell, type NotebookCellsUpdate } from "./js-notebook-types";

const LS_KEY = "archon.jsNotebook.cells.v1";
const LS_KEY_LEGACY = "archon.observableNotebook.cells.v1";

function safeParse(raw: string | null, fb: NotebookCell[]): NotebookCell[] {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? (v as NotebookCell[]) : fb;
  } catch {
    return fb;
  }
}

function readCellsFromStorage(): NotebookCell[] {
  if (typeof localStorage === "undefined") return [];
  const rawNew = localStorage.getItem(LS_KEY);
  if (rawNew) {
    const parsed = safeParse(rawNew, []);
    if (parsed.length) return parsed;
  }
  const rawLegacy = localStorage.getItem(LS_KEY_LEGACY);
  if (rawLegacy) {
    const parsed = safeParse(rawLegacy, []);
    if (parsed.length) {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(parsed));
      } catch {
        /* ignore */
      }
    }
    return parsed;
  }
  return [];
}

function defaults(): NotebookCell[] {
  return [
    { id: makeNotebookCellId(), name: "x", inputs: [], body: "42", kind: "js" },
    { id: makeNotebookCellId(), name: "y", inputs: ["x"], body: "x + 1", kind: "js" },
    { id: makeNotebookCellId(), name: "view", inputs: ["y"], body: "'y = ' + y", kind: "js" },
  ];
}

export function JsNotebookShellView(_props: ShellViewComponentProps): React.ReactElement {
  const contrib = useArchonContributionRegistry();
  const [cells, setCells] = useState<NotebookCell[]>(() => {
    const fromStore = readCellsFromStorage();
    return fromStore.length ? fromStore : defaults();
  });

  const persist = useCallback((nextOrUpdater: NotebookCellsUpdate) => {
    setCells((prev) => {
      const next = typeof nextOrUpdater === "function" ? nextOrUpdater(prev) : nextOrUpdater;
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const invokeCommand = useCallback(
    (commandId: string, args?: Record<string, unknown>) =>
      Promise.resolve(contrib.invokeCommand(commandId, args)).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[JsNotebook]", commandId, err);
      }),
    [contrib],
  );

  return (
    <JsNotebookWorkspace
      cells={cells}
      onCellsChange={persist}
      invokeCommand={invokeCommand}
      modeLineScopeId="archon.shell.js-notebook-scratch"
      executeOnMount
      toolbarHint={<span>Scratch (not a project note)</span>}
    />
  );
}
