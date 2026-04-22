import React from "react";
import type { ShellViewComponentProps } from "../../../views/ShellViewRegistry";

export function NotesExplorerMainShellView(_props: ShellViewComponentProps): React.ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-[13px] font-medium text-foreground">Notes</p>
      <p className="max-w-sm text-[12px] text-muted-foreground">
        Choose a note in the sidebar to open it here. Use the command palette or{" "}
        <span className="font-mono text-[11px]">archon.notesExplorer.open</span> to show this workspace.
      </p>
    </div>
  );
}
