import React from "react";
import { createPortal } from "react-dom";
import type { PluginIDEViewModel } from "./usePluginIDE";

export function PluginIDEViewOverlays({ vm }: { vm: PluginIDEViewModel }) {
  const {
    diskConflictPath,
    busy,
    resolveDiskConflictKeepMine,
    resolveDiskConflictReload,
    pathModal,
    setPathModal,
    submitPathModal,
    tscDiagnostics,
    openFile,
  } = vm;

  return (
    <>
      {diskConflictPath && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
          <div
            className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-xl"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="disk-conflict-title"
          >
            <h3
              id="disk-conflict-title"
              className="text-lg font-semibold text-foreground mb-2"
            >
              File changed on disk
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              <code className="text-xs font-mono bg-muted px-1">
                {diskConflictPath}
              </code>{" "}
              was modified outside the editor while you have unsaved changes.
            </p>
            <div className="flex flex-wrap gap-2 justify-end">
              <button
                type="button"
                className="px-3 py-1.5 text-sm rounded bg-muted text-foreground hover:bg-muted"
                disabled={busy}
                onClick={() => void resolveDiskConflictKeepMine()}
              >
                Keep mine
              </button>
              <button
                type="button"
                className="archon-btn-neutral px-3 py-1.5 text-sm rounded font-semibold disabled:opacity-50"
                disabled={busy}
                onClick={() => void resolveDiskConflictReload()}
              >
                Reload from disk
              </button>
            </div>
          </div>
        </div>
      )}

      {pathModal &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[60000] flex items-center justify-center bg-black/40 p-4">
            <div
              className="bg-background rounded-lg shadow-xl max-w-md w-full p-5 border border-border"
              role="dialog"
              aria-modal="true"
              aria-labelledby="path-modal-title"
            >
              <h3
                id="path-modal-title"
                className="text-lg font-semibold text-foreground mb-2"
              >
                {pathModal.kind === "newFile"
                  ? "New file"
                  : pathModal.kind === "newFolder"
                    ? "New folder"
                    : "Rename"}
              </h3>
              <p className="text-sm text-muted-foreground mb-3">
                {pathModal.kind === "rename"
                  ? "New path relative to plugin root."
                  : (
                      <>
                        Path relative to plugin root (use{" "}
                        <code className="text-xs bg-muted px-1">/</code> for
                        subfolders).
                      </>
                    )}
              </p>
              <input
                type="text"
                className="w-full border border-input rounded px-2 py-2 text-sm font-mono mb-4"
                value={pathModal.value}
                onChange={(e) =>
                  setPathModal({
                    ...pathModal,
                    value: e.target.value,
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitPathModal();
                  }
                }}
                autoFocus
              />
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm rounded bg-muted text-foreground hover:bg-muted"
                  onClick={() => setPathModal(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="archon-btn-neutral-strong rounded px-3 py-1.5 text-sm"
                  disabled={busy}
                  onClick={() => void submitPathModal()}
                >
                  Create
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {tscDiagnostics.length > 0 && (
        <div className="max-h-40 shrink-0 overflow-y-auto border-b border-border bg-muted/50 px-4 py-3 text-[11px]">
          <div className="mb-2 font-semibold text-foreground">
            Problems ({tscDiagnostics.length})
          </div>
          <ul className="space-y-1 text-foreground">
            {tscDiagnostics.map((d, i) => (
              <li key={`${d.relativePath}-${d.line}-${d.column}-${i}`}>
                <button
                  type="button"
                  className="text-left w-full hover:underline break-words"
                  onClick={() => void openFile(d.relativePath)}
                >
                  <span
                    className={
                      d.category === "error"
                        ? "font-medium text-foreground"
                        : "text-foreground/80"
                    }
                  >
                    {d.relativePath}({d.line},{d.column})
                  </span>{" "}
                  {d.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
