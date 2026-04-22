/** Stable ref surface for shell + keyboard shortcuts (Plugin IDE). */
export type PluginIDEIdeActions = {
  saveActive: () => Promise<boolean>;
  saveAllDirtyTabs: () => Promise<boolean>;
  runTypecheck: () => Promise<void>;
  bundleLocalOnly: () => Promise<void>;
  bundleAndReload: () => Promise<void>;
  /** Publish plugin package (ZIP) via file picker */
  publishAsFile: () => Promise<void>;
  reloadOnly: () => Promise<void>;
  onImportFiles: () => Promise<void>;
  onImportFolder: () => Promise<void>;
  onImportFolderIntoWorkspace: () => Promise<void>;
  onImportNewWorkspace: () => Promise<void>;
  loadArchonFromParent: () => Promise<void>;
  removeExternalRegistration: (explicitId?: string) => Promise<void>;
  copyDistToFolder: () => Promise<void>;
  copyToInternalClipboard: (opts?: {
    paths?: string[];
    sourceWorkspace?: string;
  }) => Promise<void>;
  cutToInternalClipboard: (opts?: {
    paths?: string[];
    sourceWorkspace?: string;
  }) => Promise<void>;
  pasteFromInternalClipboard: (pasteIntoDir?: string) => Promise<void>;
  openRenameModal: (fromPath?: string) => void;
  runInstallDependencies: () => Promise<void>;
  onDeletePath: (
    explicitPaths?: string[],
    explicitWorkspace?: string,
  ) => Promise<void>;
  openNewFileModal: () => void;
  openNewFolderModal: () => void;
};
