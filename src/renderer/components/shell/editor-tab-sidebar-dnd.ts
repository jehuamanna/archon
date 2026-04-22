import type { DragEvent } from "react";
import type { DndPayload } from "./editor-tab-sidebar-constants";
import { TREE_DND_MIME } from "./editor-tab-sidebar-constants";

export function parseTreeDndPayload(ev: DragEvent): DndPayload | null {
  const raw = ev.dataTransfer.getData(TREE_DND_MIME);
  if (!raw) {
    return null;
  }
  try {
    const p = JSON.parse(raw) as DndPayload;
    if (
      p &&
      typeof p.fromPlugin === "string" &&
      typeof p.fromRel === "string" &&
      typeof p.fromIsDir === "boolean"
    ) {
      return p;
    }
  } catch {
    /* ignore */
  }
  return null;
}
