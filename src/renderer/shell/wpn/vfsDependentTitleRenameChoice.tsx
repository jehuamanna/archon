import React, { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { getArchon } from "../../../shared/archon-host-access";

export type VfsDependentTitleRenameChoice = "rewrite" | "skip" | "cancel";

/**
 * Portal + promise prompt: when other notes link via `#/w/...` or `./...`, ask whether to rewrite those links.
 */
export function useVfsDependentTitleRenameChoice(): {
  prompt: (dependentNoteCount: number) => Promise<VfsDependentTitleRenameChoice>;
  portal: React.ReactPortal | null;
} {
  const [pending, setPending] = useState<{
    count: number;
    resolve: (v: VfsDependentTitleRenameChoice) => void;
  } | null>(null);

  const prompt = useCallback((dependentNoteCount: number) => {
    return new Promise<VfsDependentTitleRenameChoice>((resolve) => {
      setPending({ count: dependentNoteCount, resolve });
    });
  }, []);

  const finish = useCallback((v: VfsDependentTitleRenameChoice) => {
    setPending((cur) => {
      cur?.resolve(v);
      return null;
    });
  }, []);

  const portal =
    pending &&
    createPortal(
      <div
        className="fixed inset-0 z-[260] flex items-center justify-center bg-black/50 p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Update links in other notes"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            finish("cancel");
          }
        }}
      >
        <div className="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-lg">
          <p className="text-[13px] font-medium text-foreground">Rename note</p>
          <p className="mt-2 text-[12px] leading-snug text-muted-foreground">
            {pending.count} other note{pending.count === 1 ? "" : "s"} link to this note using its path
            (full workspace path or a short same-project link starting with ./). Update those links to match the new
            title?
          </p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            <button
              type="button"
              className="archon-btn-neutral order-1 rounded-md px-3 py-1.5 text-[12px] font-semibold sm:order-3"
              onClick={() => finish("rewrite")}
            >
              Update links
            </button>
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted/60 sm:order-2"
              onClick={() => finish("skip")}
            >
              Rename only
            </button>
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted/60 sm:order-1"
              onClick={() => finish("cancel")}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );

  return { prompt, portal };
}

export type WpnTitleRenameFlowOutcome = "cancelled" | "unchanged" | "renamed";

/**
 * If the title change would rewrite other notes, prompts; then runs `rename` with the chosen VFS policy.
 */
export async function runWpnNoteTitleRenameWithVfsDependentsFlow(args: {
  noteId: string;
  currentTitle: string;
  newTitle: string;
  prompt: (dependentNoteCount: number) => Promise<VfsDependentTitleRenameChoice>;
  rename: (updateVfsDependentLinks: boolean) => Promise<void>;
}): Promise<WpnTitleRenameFlowOutcome> {
  const trimmed = args.newTitle.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return "cancelled";
  }
  const cur = args.currentTitle.replace(/\s+/g, " ").trim();
  if (trimmed === cur) {
    return "unchanged";
  }

  let dependentNoteCount = 0;
  try {
    const archon = getArchon();
    if (typeof archon.wpnPreviewNoteTitleVfsImpact === "function") {
      const prev = await archon.wpnPreviewNoteTitleVfsImpact(args.noteId, trimmed);
      dependentNoteCount =
        typeof prev?.dependentNoteCount === "number" ? prev.dependentNoteCount : 0;
    }
  } catch {
    dependentNoteCount = 0;
  }

  if (dependentNoteCount === 0) {
    await args.rename(true);
    return "renamed";
  }

  const choice = await args.prompt(dependentNoteCount);
  if (choice === "cancel") {
    return "cancelled";
  }
  await args.rename(choice === "rewrite");
  return "renamed";
}
