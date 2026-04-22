import React, { useMemo } from "react";
import { PLUGIN_IDE_FILES_COLLAPSED_KEY } from "./plugin-ide-utils";
import { usePluginIDEKeyboardShortcuts } from "./usePluginIDE.keyboard";
import { usePluginIDEShellLayoutEffects } from "./usePluginIDE.shellLayoutEffects";

export function usePluginIDEDepsBarAndKeys(p: ReturnType<typeof usePluginIDEShellLayoutEffects>) {
  const {
    addAsDevDep,
    addRegistryDependency,
    bundleAndReload,
    bundleLocalOnly,
    busy,
    copyDistToFolder,
    copyToInternalClipboard,
    cutToInternalClipboard,
    filesPanelRef,
    ideActionsRef,
    installedPkgs,
    loadArchonFromParent,
    npmLoading,
    npmMenuOpen,
    npmQuery,
    npmResults,
    npmWrapRef,
    onDeletePath,
    onImportFiles,
    pasteFromInternalClipboard,
    pluginFolder,
    reloadOnly,
    runInstallDependencies,
    runTypecheck,
    saveActive,
    saveAllDirtyTabs,
    setAddAsDevDep,
    setNpmMenuOpen,
    setNpmQuery,
  } = p;

  usePluginIDEKeyboardShortcuts(ideActionsRef);

  const qLower = npmQuery.trim().toLowerCase();
  const filteredInstalled = useMemo(() => {
    if (qLower.length < 2) {
      return installedPkgs.slice(0, 15);
    }
    return installedPkgs.filter((p) => p.name.toLowerCase().includes(qLower));
  }, [installedPkgs, qLower]);

  const toggleFilesPanel = () => {
    const p = filesPanelRef.current;
    if (!p) {
      return;
    }
    if (p.isCollapsed()) {
      p.expand();
      localStorage.removeItem(PLUGIN_IDE_FILES_COLLAPSED_KEY);
    } else {
      p.collapse();
      localStorage.setItem(PLUGIN_IDE_FILES_COLLAPSED_KEY, "1");
    }
  };

  const depsToolbarInner = (
    <>
      <span className="text-[12px] font-semibold text-foreground">
        Dependencies
      </span>
      <div
        ref={npmWrapRef}
        className="relative isolate z-0 flex-1 min-w-[14rem] max-w-xl"
      >
        <input
          type="search"
          className="w-full rounded-sm border border-input bg-background px-3 py-2 text-[12px] text-foreground placeholder:text-muted-foreground"
          placeholder="Search npm (2+ chars) or installed packages…"
          value={npmQuery}
          onChange={(e) => setNpmQuery(e.target.value)}
          onFocus={() => setNpmMenuOpen(true)}
          disabled={!pluginFolder || busy}
        />
        {npmMenuOpen && pluginFolder && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-auto rounded-md border border-border bg-background shadow-xl text-sm">
            {filteredInstalled.length > 0 && (
              <div className="p-2 border-b border-border bg-background">
                <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">
                  Installed
                </div>
                <ul>
                  {filteredInstalled.map((p) => (
                    <li
                      key={`${p.name}-${p.dev ? "d" : "p"}`}
                      className="px-2 py-1 text-foreground font-mono text-xs"
                    >
                      {p.name}
                      <span className="text-muted-foreground">
                        @{p.range}
                        {p.dev ? " (dev)" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {npmQuery.trim().length >= 2 && (
              <div className="p-2 bg-background">
                <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">
                  npm registry
                </div>
                {npmLoading ? (
                  <div className="text-muted-foreground text-xs px-2 py-2">
                    Searching…
                  </div>
                ) : npmResults.length === 0 ? (
                  <div className="text-muted-foreground text-xs px-2 py-2">
                    No results
                  </div>
                ) : (
                  <ul>
                    {npmResults.map((r) => (
                      <li key={r.name}>
                        <button
                          type="button"
                          className="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left hover:bg-accent/50"
                          onClick={() => void addRegistryDependency(r)}
                          disabled={busy}
                        >
                          <span className="font-mono text-foreground">
                            {r.name}
                            <span className="text-muted-foreground font-normal">
                              @{r.version}
                            </span>
                          </span>
                          {r.description ? (
                            <span className="text-xs text-muted-foreground line-clamp-2">
                              {r.description}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <label className="flex cursor-pointer select-none items-center gap-2 whitespace-nowrap text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          checked={addAsDevDep}
          onChange={(e) => setAddAsDevDep(e.target.checked)}
          className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded border border-input bg-muted [accent-color:hsl(220_6%_32%)] dark:[accent-color:hsl(220_6%_68%)]"
        />
        devDependency
      </label>
      <button
        type="button"
        disabled={!pluginFolder || busy}
        onClick={() => void runInstallDependencies()}
        title="Install dependencies (⇧I)"
        className="min-h-7 shrink-0 rounded-sm border border-border bg-muted/50 px-2.5 py-1 text-[12px] text-foreground shadow-sm hover:bg-muted disabled:opacity-50"
      >
        Install dependencies
      </button>
      <button
        type="button"
        disabled={!pluginFolder || busy}
        onClick={() => void bundleAndReload()}
        title="Bundle workspace and reload registry (⇧E)"
        className="min-h-7 shrink-0 rounded-sm border border-border bg-muted/50 px-2.5 py-1 text-[12px] text-foreground shadow-sm hover:bg-muted disabled:opacity-50"
      >
        Build &amp; load
      </button>
    </>
  );

  return {
    ...p,
    depsToolbarInner,
    filteredInstalled,
    toggleFilesPanel,
  };
}
