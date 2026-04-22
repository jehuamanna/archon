import type { PluginIDEProps } from "./PluginIDE.types";
import { usePluginIDECoreState } from "./usePluginIDE.coreState";
import { usePluginIDEWorkspaceLifecycle } from "./usePluginIDE.workspaceLifecycle";
import { usePluginIDEOpenSaveAndNpm } from "./usePluginIDE.openSaveAndNpm";
import { usePluginIDEBundleDiskAndTabs } from "./usePluginIDE.bundleDiskAndTabs";
import { usePluginIDEMonacoTypecheck } from "./usePluginIDE.monacoTypecheck";
import { usePluginIDEImportPathAndClipboard } from "./usePluginIDE.importPathAndClipboard";
import { usePluginIDEDistDepsAndRename } from "./usePluginIDE.distDepsAndRename";
import { usePluginIDETreeScaffoldAndTools } from "./usePluginIDE.treeScaffoldAndTools";
import { usePluginIDEShellLayoutEffects } from "./usePluginIDE.shellLayoutEffects";
import { usePluginIDEDepsBarAndKeys } from "./usePluginIDE.depsBarAndKeys";

export function usePluginIDE(props: PluginIDEProps) {
  const core = usePluginIDECoreState(props);
  const workspaceLifecycle = usePluginIDEWorkspaceLifecycle(core);
  const openSaveAndNpm = usePluginIDEOpenSaveAndNpm(workspaceLifecycle);
  const bundleDiskAndTabs = usePluginIDEBundleDiskAndTabs(openSaveAndNpm);
  const monacoTypecheck = usePluginIDEMonacoTypecheck(bundleDiskAndTabs);
  const importPathAndClipboard =
    usePluginIDEImportPathAndClipboard(monacoTypecheck);
  const distDepsAndRename = usePluginIDEDistDepsAndRename(importPathAndClipboard);
  const treeScaffoldAndTools = usePluginIDETreeScaffoldAndTools(distDepsAndRename);
  const shellLayoutEffects = usePluginIDEShellLayoutEffects(treeScaffoldAndTools);
  return usePluginIDEDepsBarAndKeys(shellLayoutEffects);
}

export type PluginIDEViewModel = ReturnType<typeof usePluginIDE>;
