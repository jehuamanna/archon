/** Bridges Primary shell editor column ↔ PluginIDE without a heavy shared store. */

export const IDE_SHELL_STATE_EVENT = "archon-ide-shell-state";

/** One workspace plugin folder; `fileList` null until lazy-loaded in the shell sidebar. */
export type IdeShellWorkspaceFolder = {
  name: string;
  fileList: string[] | null;
};

export type IdeShellStateDetail = {
  pluginFolder: string;
  /** All registered workspace folders with optional lazy file lists. */
  folders: IdeShellWorkspaceFolder[];
  /** Current plugin’s file list (same as entry in `folders` when loaded). */
  fileList: string[];
  activePath: string | null;
  /** Workspace id that `treeSelectedPaths` belong to (sidebar file tree). */
  treeSelectionWorkspace: string;
  treeSelectedPaths: string[];
  busy: boolean;
  dirtyTabCount: number;
  hasActiveTab: boolean;
  tscOnSave: boolean;
  formatOnSave: boolean;
  reloadOnSave: boolean;
};

export const IDE_SHELL_PLUGIN_EVENT = "archon-ide-shell-plugin";
export const IDE_SHELL_OPEN_FILE_EVENT = "archon-ide-shell-open-file";
export const IDE_SHELL_EXPAND_FOLDER_EVENT = "archon-ide-shell-expand-folder";
export const IDE_SHELL_ACTION_EVENT = "archon-ide-shell-action";
export const IDE_SHELL_TREE_SELECTION_EVENT = "archon-ide-shell-tree-selection";
export const IDE_SHELL_TREE_FS_OP_EVENT = "archon-ide-shell-tree-fs-op";

export type IdeShellOpenFileDetail =
  | string
  | { pluginFolder: string; relativePath: string };

export type IdeShellAction =
  | "save"
  | "saveAll"
  | "newFile"
  | "newFolder"
  | "importFiles"
  | "importFolder"
  /** Register a new plugin folder (always uses import-as-new-workspace). */
  | "importNewWorkspace"
  | "delete"
  | "rename"
  | "copy"
  | "cut"
  | "paste"
  | "copyDist"
  | "bundle"
  | "bundleReload"
  | "reloadRegistry"
  | "typecheck"
  | "installDeps"
  | "publishAsFile"
  | "loadParent"
  | "removeExternal"
  | "toggleTscOnSave"
  | "toggleFormatOnSave"
  | "toggleReloadOnSave";

export type IdeShellTreeSelectionDetail = {
  workspace: string;
  paths: string[];
};

export type IdeShellTreeFsOpDetail = {
  kind: "dndCopy" | "dndMove";
  fromPlugin: string;
  fromRel: string;
  fromIsDir: boolean;
  toPlugin: string;
  toDirRel: string;
};

export type IdeShellActionPayload = {
  targetPaths?: string[];
  targetWorkspace?: string;
  /** Paste / duplicate into this folder (relative to plugin root, no trailing slash). */
  pasteIntoDir?: string;
};

export function dispatchIdeShellPlugin(folder: string): void {
  window.dispatchEvent(
    new CustomEvent(IDE_SHELL_PLUGIN_EVENT, { detail: folder }),
  );
}

/** Open a file; pass `pluginFolder` when opening from another workspace’s tree (shell layout). */
export function dispatchIdeShellOpenFile(
  relativePath: string,
  pluginFolder?: string,
): void {
  const detail: IdeShellOpenFileDetail =
    pluginFolder != null && pluginFolder.length > 0
      ? { pluginFolder, relativePath }
      : relativePath;
  window.dispatchEvent(
    new CustomEvent(IDE_SHELL_OPEN_FILE_EVENT, { detail }),
  );
}

export function dispatchIdeShellExpandFolder(folder: string): void {
  window.dispatchEvent(
    new CustomEvent(IDE_SHELL_EXPAND_FOLDER_EVENT, { detail: folder }),
  );
}

export function dispatchIdeShellAction(
  type: IdeShellAction,
  payload?: IdeShellActionPayload,
): void {
  window.dispatchEvent(
    new CustomEvent(IDE_SHELL_ACTION_EVENT, {
      detail: { type, ...payload },
    }),
  );
}

export function dispatchIdeShellTreeSelection(
  detail: IdeShellTreeSelectionDetail,
): void {
  window.dispatchEvent(
    new CustomEvent(IDE_SHELL_TREE_SELECTION_EVENT, { detail }),
  );
}

export function dispatchIdeShellTreeFsOp(detail: IdeShellTreeFsOpDetail): void {
  window.dispatchEvent(
    new CustomEvent(IDE_SHELL_TREE_FS_OP_EVENT, { detail }),
  );
}
