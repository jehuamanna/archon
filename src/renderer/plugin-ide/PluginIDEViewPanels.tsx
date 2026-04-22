import React from "react";
import { createPortal } from "react-dom";
import Editor from "@monaco-editor/react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { joinFileUri } from "../../shared/file-uri";
import NoteTypeReactRenderer from "../components/renderers/NoteTypeReactRenderer";
import { monacoBeforeMount } from "./plugin-ide-monaco";
import {
  NODE_MODULES_LIST_MARKER,
  PLUGIN_IDE_FILES_COLLAPSED_KEY,
  languageForPath,
} from "./plugin-ide-utils";
import type { PluginIDEViewModel } from "./usePluginIDE";

export function PluginIDEViewPanels({ vm }: { vm: PluginIDEViewModel }) {
  const {
    shellLayout,
    filesPanelRef,
    toggleFilesPanel,
    fileList,
    openFile,
    activePath,
    tabs,
    setActivePath,
    closeTab,
    dirtyTabCount,
    activeTab,
    workspaceRootFileUri,
    monacoTheme,
    handleEditorMount,
    markDirtyFromContent,
    previewExpanded,
    setPreviewExpanded,
    previewType,
    setPreviewType,
    types,
    previewNote,
    pluginFolder,
    previewRev,
    previewAssetProjectRoot,
  } = vm;

  return (
    <>
      <PanelGroup
        direction="horizontal"
        autoSaveId={
          shellLayout ? "plugin-ide-panels-shell" : "plugin-ide-panels"
        }
        className="flex-1 min-h-0"
      >
        {!shellLayout ? (
          <>
            <Panel
              ref={filesPanelRef}
              collapsible
              collapsedSize={0}
              minSize={10}
              defaultSize={18}
              className="min-w-0"
              onCollapse={() =>
                localStorage.setItem(PLUGIN_IDE_FILES_COLLAPSED_KEY, "1")
              }
              onExpand={() =>
                localStorage.removeItem(PLUGIN_IDE_FILES_COLLAPSED_KEY)
              }
            >
              <aside className="flex h-full flex-col overflow-y-auto border-r border-border bg-sidebar">
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Files
                  </span>
                  <button
                    type="button"
                    className="rounded-sm p-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="Collapse or expand file list"
                    aria-label="Toggle file sidebar"
                    onClick={toggleFilesPanel}
                  >
                    ◀▶
                  </button>
                </div>
                <ul className="min-h-0 flex-1 overflow-y-auto py-1">
                  {fileList.map((f) => (
                    <li key={f}>
                      {f === NODE_MODULES_LIST_MARKER ? (
                        <div
                          className="cursor-default border-l-2 border-transparent py-[5px] pl-4 pr-3 font-mono text-[13px] leading-snug text-muted-foreground"
                          title="npm dependencies (folder exists on disk; not listed here)"
                        >
                          {f}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void openFile(f)}
                          className={`w-full truncate border-l-2 py-[5px] pl-4 pr-3 text-left font-mono text-[13px] leading-snug transition-colors hover:bg-muted/50 ${
                            activePath === f
                              ? "border-primary bg-muted/60 font-medium text-foreground"
                              : "border-transparent text-foreground"
                          }`}
                          title={f}
                        >
                          {f}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </aside>
            </Panel>

            <PanelResizeHandle className="archon-panel-sash relative w-1 shrink-0 bg-transparent transition-colors before:absolute before:inset-y-0 before:left-1/2 before:z-10 before:w-px before:-translate-x-1/2 before:bg-border before:transition-colors hover:before:bg-resize-handle-hover data-[panel-resize-handle-active=true]:before:bg-resize-handle-active" />
          </>
        ) : null}

        <Panel
          defaultSize={shellLayout ? 58 : 52}
          minSize={30}
          className="min-w-0"
        >
          <div className="h-full flex flex-col min-h-0">
            <div
              className="flex shrink-0 overflow-x-auto border-b border-border bg-muted/80"
              role="tablist"
            >
              {tabs.map((t) => {
                const dirty = t.content !== t.savedContent;
                const base = t.relativePath.split("/").pop() ?? t.relativePath;
                return (
                  <div
                    key={t.relativePath}
                    title={
                      dirty
                        ? `${t.relativePath} (unsaved)`
                        : t.relativePath
                    }
                    className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap border-r border-border px-3 py-2 font-mono text-[12px] ${
                      activePath === t.relativePath
                        ? "border-b-transparent bg-background text-foreground"
                        : "bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                    }`}
                    onClick={() => setActivePath(t.relativePath)}
                    role="tab"
                    tabIndex={0}
                    aria-selected={activePath === t.relativePath}
                  >
                    <span>
                      {dirty ? "* " : ""}
                      {base}
                    </span>
                    <button
                      type="button"
                      className="px-1 text-muted-foreground hover:text-foreground"
                      aria-label="Close tab"
                      onClick={(e) => closeTab(t.relativePath, e)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
            {dirtyTabCount > 0 ? (
              <div className="shrink-0 border-b border-border bg-muted/40 px-4 py-1.5 text-[11px] text-foreground/90">
                {dirtyTabCount} unsaved file
                {dirtyTabCount === 1 ? "" : "s"}
              </div>
            ) : null}
            <div className="flex-1 min-h-0">
              {activeTab ? (
                <Editor
                  key={`${workspaceRootFileUri}:${activeTab.relativePath}:${monacoTheme}`}
                  height="100%"
                  theme={monacoTheme}
                  path={
                    workspaceRootFileUri
                      ? joinFileUri(
                          workspaceRootFileUri,
                          activeTab.relativePath,
                        )
                      : activeTab.relativePath
                  }
                  language={languageForPath(activeTab.relativePath)}
                  value={activeTab.content}
                  beforeMount={monacoBeforeMount}
                  onMount={handleEditorMount}
                  onChange={(v) => markDirtyFromContent(v)}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    tabSize: 2,
                    quickSuggestions: true,
                    suggestOnTriggerCharacters: true,
                    acceptSuggestionOnCommitCharacter: true,
                    tabCompletion: "on",
                    parameterHints: { enabled: true },
                  }}
                />
              ) : (
                <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                  Select a plugin and open a file
                </div>
              )}
            </div>
          </div>
        </Panel>

        <PanelResizeHandle className="archon-panel-sash relative w-1 shrink-0 bg-transparent transition-colors before:absolute before:inset-y-0 before:left-1/2 before:z-10 before:w-px before:-translate-x-1/2 before:bg-border before:transition-colors hover:before:bg-resize-handle-hover data-[panel-resize-handle-active=true]:before:bg-resize-handle-active" />

        <Panel defaultSize={30} minSize={18} className="min-w-0">
          <aside className="flex h-full min-h-0 flex-col border-l border-border bg-sidebar">
            <div className="shrink-0 border-b border-border px-4 py-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Preview note type
                </label>
                <button
                  type="button"
                  className="shrink-0 rounded-sm border border-input bg-background px-2 py-1 text-[10px] hover:bg-muted/50"
                  onClick={() => setPreviewExpanded((x) => !x)}
                >
                  {previewExpanded ? "Restore" : "Maximize"}
                </button>
              </div>
              <select
                className="w-full rounded-sm border border-input bg-background px-2.5 py-2 text-[12px]"
                value={previewType}
                onChange={(e) => setPreviewType(e.target.value)}
              >
                {types.length === 0 ? (
                  <option value="">No types registered</option>
                ) : (
                  types.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {previewExpanded &&
              previewNote &&
              types.includes(previewType) ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-muted-foreground">
                  <p>Preview is fullscreen over the app.</p>
                  <p className="text-[10px]">Press Escape or Restore to exit.</p>
                </div>
              ) : previewNote && types.includes(previewType) ? (
                <NoteTypeReactRenderer
                  key={`${pluginFolder}-${previewType}-${previewRev}`}
                  note={previewNote}
                  persistToNotesStore={false}
                  assetProjectRoot={previewAssetProjectRoot}
                />
              ) : (
                <div className="px-4 py-4 text-[11px] leading-relaxed text-muted-foreground">
                  Reload registry after bundling to register types, then pick a
                  type to preview.
                </div>
              )}
            </div>
          </aside>
        </Panel>
      </PanelGroup>

      {previewExpanded &&
      previewNote &&
      types.includes(previewType) &&
      typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[2147483000] flex min-h-0 flex-col bg-background text-foreground shadow-2xl"
              role="dialog"
              aria-label="Plugin preview fullscreen"
            >
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/80 px-4 py-2">
                <span className="text-[12px] font-medium">
                  Preview · {previewType}
                </span>
                <button
                  type="button"
                  className="rounded-sm border border-input bg-background px-3 py-1 text-[11px] hover:bg-muted/50"
                  onClick={() => setPreviewExpanded(false)}
                >
                  Restore
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <NoteTypeReactRenderer
                  key={`fs-${pluginFolder}-${previewType}-${previewRev}`}
                  note={previewNote}
                  persistToNotesStore={false}
                  assetProjectRoot={previewAssetProjectRoot}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
