import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  dispatchIdeShellExpandFolder,
  dispatchIdeShellOpenFile,
  dispatchIdeShellPlugin,
  dispatchIdeShellTreeFsOp,
  dispatchIdeShellTreeSelection,
  IDE_SHELL_STATE_EVENT,
  type IdeShellStateDetail,
} from "../../plugin-ide/ideShellBridge";
import {
  menuBtn,
  WORKSPACE_TITLE_CTX_PATH,
  type TreeCtxMenu,
} from "./editor-tab-sidebar-constants";
import { parseTreeDndPayload } from "./editor-tab-sidebar-dnd";
import { EditorTabCtxMenuPortal } from "./EditorTabSidebarCtxPortal";
import { EditorTabMenuPortal } from "./EditorTabSidebarMenuPortal";
import { renderEditorTabSidebarTreeNodes } from "./EditorTabSidebarPluginTree";
import {
  buildFileTree,
  collectTreePaths,
  isNodeModulesListMarker,
} from "./editor-tab-sidebar-tree";
import { PLUGIN_TREE_ROOT_OFFSET_CLASS } from "./editor-tab-sidebar-constants";

const EditorTabSidebar: React.FC = () => {
  const [state, setState] = useState<IdeShellStateDetail>({
    pluginFolder: "",
    folders: [],
    fileList: [],
    activePath: null,
    treeSelectionWorkspace: "",
    treeSelectedPaths: [],
    busy: false,
    dirtyTabCount: 0,
    hasActiveTab: false,
    tscOnSave: false,
    formatOnSave: false,
    reloadOnSave: false,
  });
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>(
    {},
  );
  const [menu, setMenu] = useState<null | "file" | "edit" | "build">(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [ctxMenu, setCtxMenu] = useState<TreeCtxMenu | null>(null);
  const fileBtnRef = useRef<HTMLButtonElement | null>(null);
  const editBtnRef = useRef<HTMLButtonElement | null>(null);
  const buildBtnRef = useRef<HTMLButtonElement | null>(null);
  const menuPortalRef = useRef<HTMLDivElement | null>(null);
  const ctxPortalRef = useRef<HTMLDivElement | null>(null);
  const lastTreeClickRef = useRef<{ workspace: string; path: string } | null>(
    null,
  );

  useEffect(() => {
    const onState = (e: Event) => {
      const d = (e as CustomEvent<IdeShellStateDetail>).detail;
      if (d && typeof d === "object") {
        setState({
          ...d,
          treeSelectedPaths: d.treeSelectedPaths ?? [],
          treeSelectionWorkspace: d.treeSelectionWorkspace ?? "",
        });
      }
    };
    window.addEventListener(IDE_SHELL_STATE_EVENT, onState);
    return () => window.removeEventListener(IDE_SHELL_STATE_EVENT, onState);
  }, []);

  useLayoutEffect(() => {
    if (!menu) {
      setMenuPos(null);
      return;
    }
    const ref =
      menu === "file"
        ? fileBtnRef
        : menu === "edit"
          ? editBtnRef
          : buildBtnRef;
    const el = ref.current;
    if (!el) {
      setMenuPos(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 2, left: r.left });
  }, [menu]);

  useEffect(() => {
    if (!menu) {
      return;
    }
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as Node;
      const portal = menuPortalRef.current;
      if (
        portal?.contains(t) ||
        fileBtnRef.current?.contains(t) ||
        editBtnRef.current?.contains(t) ||
        buildBtnRef.current?.contains(t)
      ) {
        return;
      }
      setMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setMenu(null);
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    if (!ctxMenu) {
      return;
    }
    const onDown = (ev: MouseEvent) => {
      if (ev.button !== 0) {
        return;
      }
      const t = ev.target as Node;
      if (ctxPortalRef.current?.contains(t)) {
        return;
      }
      setCtxMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setCtxMenu(null);
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  useEffect(() => {
    if (!menu) {
      return;
    }
    const close = (): void => {
      setMenu(null);
    };
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  useEffect(() => {
    if (state.pluginFolder) {
      setExpandedFolders((prev) => ({
        ...prev,
        [state.pluginFolder]: true,
      }));
    }
  }, [state.pluginFolder]);

  const pf = state.pluginFolder;
  const busy = state.busy;
  const hasOpen = state.hasActiveTab;
  const dirty = state.dirtyTabCount;

  const canPathOp =
    !!pf &&
    !busy &&
    (!!state.activePath ||
      (state.treeSelectionWorkspace === pf &&
        state.treeSelectedPaths.length > 0));

  const singleTreeTarget =
    state.treeSelectionWorkspace === pf && state.treeSelectedPaths.length === 1
      ? state.treeSelectedPaths[0]
      : null;
  const canRename = !!pf && !busy && (!!singleTreeTarget || !!state.activePath);

  const toggleFolderExpanded = (folderName: string): void => {
    setExpandedFolders((prev) => {
      const nextOpen = !prev[folderName];
      if (nextOpen) {
        const entry = state.folders.find((f) => f.name === folderName);
        if (entry && entry.fileList == null) {
          dispatchIdeShellExpandFolder(folderName);
        }
      }
      return { ...prev, [folderName]: nextOpen };
    });
  };

  const handleTreeClick = (
    ev: React.MouseEvent,
    workspace: string,
    relPath: string,
    isDir: boolean,
    orderedPaths: string[],
  ): void => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (ev.shiftKey && lastTreeClickRef.current?.workspace === workspace) {
      const anchor = lastTreeClickRef.current.path;
      const ia = orderedPaths.indexOf(anchor);
      const ib = orderedPaths.indexOf(relPath);
      if (ia >= 0 && ib >= 0) {
        const lo = Math.min(ia, ib);
        const hi = Math.max(ia, ib);
        const range = orderedPaths.slice(lo, hi + 1);
        dispatchIdeShellTreeSelection({ workspace, paths: range });
        lastTreeClickRef.current = { workspace, path: relPath };
        if (!isDir) {
          if (!isNodeModulesListMarker(relPath)) {
            dispatchIdeShellOpenFile(relPath, workspace);
          }
        } else {
          dispatchIdeShellPlugin(workspace);
        }
        return;
      }
    }
    if (mod && state.treeSelectionWorkspace === workspace) {
      const set = new Set(state.treeSelectedPaths);
      if (set.has(relPath)) {
        set.delete(relPath);
      } else {
        set.add(relPath);
      }
      const next = [...set];
      dispatchIdeShellTreeSelection({ workspace, paths: next });
      lastTreeClickRef.current = { workspace, path: relPath };
      if (!isDir) {
        if (!isNodeModulesListMarker(relPath)) {
          dispatchIdeShellOpenFile(relPath, workspace);
        }
      } else {
        dispatchIdeShellPlugin(workspace);
      }
      return;
    }
    dispatchIdeShellTreeSelection({ workspace, paths: [relPath] });
    lastTreeClickRef.current = { workspace, path: relPath };
    if (!isDir) {
      if (!isNodeModulesListMarker(relPath)) {
        dispatchIdeShellOpenFile(relPath, workspace);
      }
    } else {
      dispatchIdeShellPlugin(workspace);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-sidebar-border border-b px-1 py-1.5">
        <div className="flex flex-wrap gap-1">
          <button
            ref={fileBtnRef}
            type="button"
            className={menuBtn}
            aria-expanded={menu === "file"}
            aria-haspopup="true"
            onClick={() => setMenu((m) => (m === "file" ? null : "file"))}
          >
            File
          </button>
          <button
            ref={editBtnRef}
            type="button"
            className={menuBtn}
            aria-expanded={menu === "edit"}
            aria-haspopup="true"
            onClick={() => setMenu((m) => (m === "edit" ? null : "edit"))}
          >
            Edit
          </button>
          <button
            ref={buildBtnRef}
            type="button"
            className={menuBtn}
            aria-expanded={menu === "build"}
            aria-haspopup="true"
            onClick={() => setMenu((m) => (m === "build" ? null : "build"))}
          >
            Build
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-archon-own-contextmenu>
        <div className="border-sidebar-border border-b px-3 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Plugins
          </span>
        </div>
        {state.folders.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-muted-foreground">
            No plugin workspaces yet. Use File → Add plugin workspace…, or Build
            → Load parent (.archonplugin).
          </p>
        ) : (
          <ul className="m-0 list-none py-1">
            {state.folders.map((folder) => {
              const open = !!expandedFolders[folder.name];
              const activeWs = folder.name === pf;
              const tree = buildFileTree(folder.fileList ?? []);
              const orderedPaths = collectTreePaths(tree, "");
              return (
                <li key={folder.name} className="list-none">
                  <div
                    className="flex items-center gap-0.5 py-[2px] pr-2"
                    style={{ paddingLeft: 6 }}
                  >
                    <button
                      type="button"
                      className="flex h-7 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted/50"
                      aria-expanded={open}
                      title={open ? "Collapse files" : "Expand files"}
                      aria-label={
                        open ? `Collapse ${folder.name}` : `Expand ${folder.name}`
                      }
                      onClick={() => toggleFolderExpanded(folder.name)}
                    >
                      <span
                        className={`inline-block text-[12px] transition-transform ${open ? "rotate-90" : ""}`}
                      >
                        ›
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`min-w-0 flex-1 truncate rounded-sm px-1 py-1 text-left font-mono text-[12px] hover:bg-muted/40 ${
                        activeWs
                          ? "font-semibold text-foreground"
                          : "text-foreground"
                      }`}
                      title={`Open workspace ${folder.name}`}
                      onClick={() => dispatchIdeShellPlugin(folder.name)}
                      onContextMenu={(ev) => {
                        ev.preventDefault();
                        setCtxMenu({
                          top: ev.clientY,
                          left: ev.clientX,
                          workspace: folder.name,
                          path: WORKSPACE_TITLE_CTX_PATH,
                          isDir: true,
                        });
                      }}
                    >
                      {folder.name}
                    </button>
                  </div>
                  {open && folder.fileList == null ? (
                    <div
                      className={`pb-2 text-[11px] text-muted-foreground ${PLUGIN_TREE_ROOT_OFFSET_CLASS}`}
                      aria-live="polite"
                    >
                      Loading…
                    </div>
                  ) : null}
                  {open && folder.fileList != null ? (
                    <ul
                      className={`m-0 list-none py-0.5 ${PLUGIN_TREE_ROOT_OFFSET_CLASS}`}
                      onDragOver={(ev) => {
                        ev.preventDefault();
                        ev.dataTransfer.dropEffect = ev.shiftKey ? "copy" : "move";
                      }}
                      onDrop={(ev) => {
                        ev.preventDefault();
                        const p = parseTreeDndPayload(ev);
                        if (!p) {
                          return;
                        }
                        dispatchIdeShellTreeFsOp({
                          kind: ev.shiftKey ? "dndCopy" : "dndMove",
                          fromPlugin: p.fromPlugin,
                          fromRel: p.fromRel,
                          fromIsDir: p.fromIsDir,
                          toPlugin: folder.name,
                          toDirRel: "",
                        });
                      }}
                    >
                      {renderEditorTabSidebarTreeNodes({
                        state,
                        nodes: tree,
                        depth: 0,
                        treePluginFolder: folder.name,
                        parentRel: "",
                        orderedPaths,
                        setCtxMenu,
                        handleTreeClick,
                      })}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <EditorTabMenuPortal
        menu={menu}
        menuPos={menuPos}
        menuPortalRef={menuPortalRef}
        state={state}
        pf={pf}
        busy={busy}
        hasOpen={hasOpen}
        dirty={dirty}
        canPathOp={canPathOp}
        canRename={canRename}
        setMenu={setMenu}
      />
      <EditorTabCtxMenuPortal
        ctxMenu={ctxMenu}
        ctxPortalRef={ctxPortalRef}
        busy={busy}
        setCtxMenu={setCtxMenu}
      />
    </div>
  );
};

export default EditorTabSidebar;
