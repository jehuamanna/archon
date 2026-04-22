export const TREE_DND_MIME = "application/x-archon-tree-dnd";

export type DndPayload = {
  fromPlugin: string;
  fromRel: string;
  fromIsDir: boolean;
};

export const menuBtn =
  "min-h-7 rounded-sm border border-input bg-background px-2 py-1 text-[11px] text-foreground hover:bg-muted/50";
export const menuPortalPanel =
  "fixed z-[60000] w-[min(18rem,calc(100vw-12px))] rounded-md border border-border bg-background py-1 shadow-lg";
export const menuItem =
  "block w-full px-3 py-2 text-left text-sm hover:bg-muted/40 disabled:opacity-50";

export const PLUGIN_TREE_ROOT_OFFSET_CLASS =
  "ml-[30px] border-l border-sidebar-border/50 pl-2";
export const TREE_DEPTH_PAD_BASE = 4;
export const TREE_DEPTH_STEP_PX = 14;

/** Right-clicked the plugin workspace title row (not a file path). */
export const WORKSPACE_TITLE_CTX_PATH = "\0workspace-title";

export type TreeCtxMenu = {
  top: number;
  left: number;
  workspace: string;
  path: string;
  isDir: boolean;
};
