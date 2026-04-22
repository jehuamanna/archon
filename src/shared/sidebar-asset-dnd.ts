import type { DragEvent } from "react";

export const DND_ASSET_MIME = "application/x-archon-asset";

export type SidebarAssetDragPayload = {
  fromProject: string;
  fromRel: string;
};

export function parseSidebarAssetDragPayload(
  e: DragEvent,
): SidebarAssetDragPayload | null {
  const raw = e.dataTransfer.getData(DND_ASSET_MIME);
  if (!raw) {
    return null;
  }
  try {
    const o = JSON.parse(raw) as unknown;
    if (
      !o ||
      typeof o !== "object" ||
      typeof (o as SidebarAssetDragPayload).fromProject !== "string" ||
      typeof (o as SidebarAssetDragPayload).fromRel !== "string"
    ) {
      return null;
    }
    return o as SidebarAssetDragPayload;
  } catch {
    return null;
  }
}
