import React, { useState } from "react";
import type { PluginIDEViewModel } from "./usePluginIDE";
import {
  PLUGIN_IDE_FORMAT_ON_SAVE_KEY,
  PLUGIN_IDE_RELOAD_ON_SAVE_KEY,
  PLUGIN_IDE_TOOLBAR_MENU_PANEL,
  PLUGIN_IDE_TSC_ON_SAVE_KEY,
} from "./plugin-ide-utils";
import { PublishToMarketModal } from "./PublishToMarketModal";

export function PluginIDEViewChrome({ vm }: { vm: PluginIDEViewModel }) {
  const [publishToMarketOpen, setPublishToMarketOpen] = useState(false);
  const {
    shellLayout,
    pluginFolder,
    setPluginFolder,
    folders,
    toolbarMenuRef,
    toolbarMenu,
    setToolbarMenu,
    activeTab,
    busy,
    dirtyTabCount,
    saveActive,
    saveAllDirtyTabs,
    setPathModal,
    onImportFiles,
    onImportFolder,
    onDeletePath,
    openRenameModal,
    copyToInternalClipboard,
    cutToInternalClipboard,
    pasteFromInternalClipboard,
    copyDistToFolder,
    runTypecheck,
    tscOnSave,
    setTscOnSave,
    formatOnSave,
    setFormatOnSave,
    reloadOnSave,
    setReloadOnSave,
    loadArchonFromParent,
    removeExternalRegistration,
    bundleLocalOnly,
    bundleAndReload,
    publishAsFile,
    reloadOnly,
    workspaceToolsControls,
    depsToolbarInner,
    activePath,
  } = vm;

  return (
    <>
      {!shellLayout ? (
        <header className="relative z-40 shrink-0 border-b border-border bg-background">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
            <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
              Plugin
              <select
                className="max-w-[14rem] rounded-sm border border-border bg-muted/50 px-2.5 py-1.5 text-[12px] text-foreground shadow-sm hover:bg-muted"
                value={pluginFolder}
                onChange={(e) => {
                  setPluginFolder(e.target.value);
                }}
              >
                <option value="">—</option>
                {folders.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <div
              ref={toolbarMenuRef}
              className="flex flex-wrap items-center gap-1"
            >
              <div className="relative">
                <button
                  type="button"
                  className="min-h-7 rounded-sm border border-border bg-muted/50 px-2.5 py-1 text-[12px] text-foreground shadow-sm hover:bg-muted"
                  aria-expanded={toolbarMenu === "file"}
                  aria-haspopup="true"
                  onClick={() =>
                    setToolbarMenu((m) => (m === "file" ? null : "file"))
                  }
                >
                  File
                </button>
                {toolbarMenu === "file" ? (
                  <div
                    className={PLUGIN_IDE_TOOLBAR_MENU_PANEL}
                    role="menu"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!activeTab || busy}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void saveActive();
                      }}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || busy || dirtyTabCount === 0}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void saveAllDirtyTabs();
                      }}
                    >
                      Save all
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || busy}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        setPathModal({ kind: "newFile", value: "newfile.js" });
                      }}
                    >
                      New file
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || busy}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        setPathModal({ kind: "newFolder", value: "lib" });
                      }}
                    >
                      New folder
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || busy}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void onImportFiles();
                      }}
                    >
                      Import file(s)
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void onImportFolder();
                      }}
                    >
                      Import folder
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || !activePath || busy}
                      className="w-full text-left px-3 py-2 text-sm text-foreground/90 hover:bg-muted disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void onDeletePath();
                      }}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || !activePath || busy}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        openRenameModal();
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || !activePath || busy}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void copyToInternalClipboard();
                      }}
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || !activePath || busy}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void cutToInternalClipboard();
                      }}
                    >
                      Cut
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || busy}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void pasteFromInternalClipboard();
                      }}
                    >
                      Paste
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || busy}
                      title="Copy dist/ contents via folder picker"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void copyDistToFolder();
                      }}
                    >
                      Copy dist…
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="relative">
                <button
                  type="button"
                  className="min-h-7 rounded-sm border border-border bg-muted/50 px-2.5 py-1 text-[12px] text-foreground shadow-sm hover:bg-muted"
                  aria-expanded={toolbarMenu === "edit"}
                  aria-haspopup="true"
                  onClick={() =>
                    setToolbarMenu((m) => (m === "edit" ? null : "edit"))
                  }
                >
                  Edit
                </button>
                {toolbarMenu === "edit" ? (
                  <div
                    className={PLUGIN_IDE_TOOLBAR_MENU_PANEL}
                    role="menu"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || busy}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void runTypecheck();
                      }}
                    >
                      Check types (TS)
                    </button>
                    <div
                      className="my-1 border-t border-border"
                      role="separator"
                      aria-hidden
                    />
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={tscOnSave}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40"
                      onClick={() => {
                        setToolbarMenu(null);
                        const v = !tscOnSave;
                        setTscOnSave(v);
                        if (v) {
                          localStorage.setItem(PLUGIN_IDE_TSC_ON_SAVE_KEY, "1");
                        } else {
                          localStorage.removeItem(PLUGIN_IDE_TSC_ON_SAVE_KEY);
                        }
                      }}
                    >
                      {tscOnSave ? "✓ " : ""}
                      Typecheck on save
                    </button>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={formatOnSave}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40"
                      onClick={() => {
                        setToolbarMenu(null);
                        const v = !formatOnSave;
                        setFormatOnSave(v);
                        if (v) {
                          localStorage.setItem(
                            PLUGIN_IDE_FORMAT_ON_SAVE_KEY,
                            "1",
                          );
                        } else {
                          localStorage.removeItem(PLUGIN_IDE_FORMAT_ON_SAVE_KEY);
                        }
                      }}
                    >
                      {formatOnSave ? "✓ " : ""}
                      Format on save (Prettier)
                    </button>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={reloadOnSave}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40"
                      onClick={() => {
                        setToolbarMenu(null);
                        const v = !reloadOnSave;
                        setReloadOnSave(v);
                        if (v) {
                          localStorage.setItem(
                            PLUGIN_IDE_RELOAD_ON_SAVE_KEY,
                            "1",
                          );
                        } else {
                          localStorage.removeItem(PLUGIN_IDE_RELOAD_ON_SAVE_KEY);
                        }
                      }}
                    >
                      {reloadOnSave ? "✓ " : ""}
                      Reload registry on save
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="relative">
                <button
                  type="button"
                  className="min-h-7 rounded-sm border border-border bg-muted/50 px-2.5 py-1 text-[12px] text-foreground shadow-sm hover:bg-muted"
                  aria-expanded={toolbarMenu === "build"}
                  aria-haspopup="true"
                  onClick={() =>
                    setToolbarMenu((m) => (m === "build" ? null : "build"))
                  }
                >
                  Build
                </button>
                {toolbarMenu === "build" ? (
                  <div
                    className={PLUGIN_IDE_TOOLBAR_MENU_PANEL}
                    role="menu"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      title="Pick parent folder; register subfolders with .archonplugin"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void loadArchonFromParent();
                      }}
                    >
                      Load parent (.archonplugin)
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || busy}
                      title="Remove external registration only (sources/ plugins are unchanged)"
                      className="w-full px-3 py-2 text-left text-sm text-foreground/90 hover:bg-muted disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void removeExternalRegistration();
                      }}
                    >
                      Remove external
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || busy}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void bundleLocalOnly();
                      }}
                    >
                      Bundle
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || busy}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-accent/80 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void bundleAndReload();
                      }}
                    >
                      Bundle &amp; reload
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || busy}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void publishAsFile();
                      }}
                    >
                      Publish as file…
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!pluginFolder || busy}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        setPublishToMarketOpen(true);
                      }}
                    >
                      Publish to market…
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50"
                      onClick={() => {
                        setToolbarMenu(null);
                        void reloadOnly();
                      }}
                    >
                      Reload registry
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {workspaceToolsControls}
            </div>
          </div>
        </header>
      ) : null}

      {shellLayout ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-4 py-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Plugin IDE
          </span>
          {workspaceToolsControls}
        </div>
      ) : null}

      <div className="relative z-10 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-border bg-muted/30 px-4 py-3">
        {depsToolbarInner}
      </div>

      <PublishToMarketModal
        open={publishToMarketOpen}
        onClose={() => setPublishToMarketOpen(false)}
        pluginName={pluginFolder || null}
      />
    </>
  );
}
