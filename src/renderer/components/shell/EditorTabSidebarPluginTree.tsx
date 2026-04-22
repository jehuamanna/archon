import React from "react";
import {
  dispatchIdeShellTreeFsOp,
  type IdeShellStateDetail,
} from "../../plugin-ide/ideShellBridge";
import {
  TREE_DND_MIME,
  TREE_DEPTH_PAD_BASE,
  TREE_DEPTH_STEP_PX,
  type DndPayload,
  type TreeCtxMenu,
} from "./editor-tab-sidebar-constants";
import { parseTreeDndPayload } from "./editor-tab-sidebar-dnd";
import type { FileTreeNode } from "./editor-tab-sidebar-tree";
import {
  fsRelFromTreePath,
  isNodeModulesListMarker,
  pathLooksLikeDir,
} from "./editor-tab-sidebar-tree";

type Props = {
  state: IdeShellStateDetail;
  nodes: FileTreeNode[];
  depth: number;
  treePluginFolder: string;
  parentRel: string;
  orderedPaths: string[];
  setCtxMenu: (m: TreeCtxMenu | null) => void;
  handleTreeClick: (
    ev: React.MouseEvent,
    workspace: string,
    relPath: string,
    isDir: boolean,
    orderedPaths: string[],
  ) => void;
};

export function renderEditorTabSidebarTreeNodes({
  state,
  nodes,
  depth,
  treePluginFolder,
  parentRel,
  orderedPaths,
  setCtxMenu,
  handleTreeClick,
}: Props): React.ReactNode {
  return nodes.map((n) => {
    const isDir =
      n.children.length > 0 ||
      n.path === null ||
      pathLooksLikeDir(n.path);
    const pad = TREE_DEPTH_PAD_BASE + depth * TREE_DEPTH_STEP_PX;
    const dirRel = parentRel ? `${parentRel}/${n.name}` : n.name;
    const rowPath =
      isDir && n.children.length > 0 ? dirRel : (n.path ?? dirRel);
    const selected =
      state.treeSelectionWorkspace === treePluginFolder &&
      state.treeSelectedPaths.includes(rowPath);
    if (isDir && n.children.length > 0) {
      const rowSelected = selected;
      return (
        <li key={`${depth}-${dirRel}`} className="list-none">
          <div
            draggable
            className={`flex cursor-grab truncate py-[3px] font-mono text-[12px] active:cursor-grabbing ${
              rowSelected
                ? "border-l-2 border-primary bg-muted/50 text-foreground"
                : "border-l-2 border-transparent text-muted-foreground"
            }`}
            style={{ paddingLeft: pad }}
            onDragStart={(ev) => {
              ev.dataTransfer.setData(
                TREE_DND_MIME,
                JSON.stringify({
                  fromPlugin: treePluginFolder,
                  fromRel: dirRel,
                  fromIsDir: true,
                } satisfies DndPayload),
              );
              ev.dataTransfer.effectAllowed = "copyMove";
            }}
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
              if (
                p.fromPlugin === treePluginFolder &&
                (p.fromRel === dirRel || dirRel.startsWith(p.fromRel + "/"))
              ) {
                return;
              }
              dispatchIdeShellTreeFsOp({
                kind: ev.shiftKey ? "dndCopy" : "dndMove",
                fromPlugin: p.fromPlugin,
                fromRel: p.fromRel,
                fromIsDir: p.fromIsDir,
                toPlugin: treePluginFolder,
                toDirRel: dirRel,
              });
            }}
            onContextMenu={(ev) => {
              ev.preventDefault();
              setCtxMenu({
                top: ev.clientY,
                left: ev.clientX,
                workspace: treePluginFolder,
                path: dirRel,
                isDir: true,
              });
            }}
            onClick={(ev) =>
              handleTreeClick(ev, treePluginFolder, dirRel, true, orderedPaths)
            }
            title={dirRel}
          >
            <span className="mr-1 inline-block w-3 shrink-0 text-[10px] text-muted-foreground/90">
              ▸
            </span>
            <span className="font-medium">{n.name}</span>
          </div>
          <ul className="m-0 p-0">
            {renderEditorTabSidebarTreeNodes({
              state,
              nodes: n.children,
              depth: depth + 1,
              treePluginFolder,
              parentRel: dirRel,
              orderedPaths,
              setCtxMenu,
              handleTreeClick,
            })}
          </ul>
        </li>
      );
    }
    const rel = n.path ?? "";
    const active =
      state.activePath === rel && state.pluginFolder === treePluginFolder;
    const rowSel =
      state.treeSelectionWorkspace === treePluginFolder &&
      state.treeSelectedPaths.includes(rel);
    if (isNodeModulesListMarker(rel)) {
      return (
        <li key={rel} className="list-none">
          <div
            className={`w-full cursor-default truncate border-l-2 py-[4px] pr-2 text-left font-mono text-[12px] leading-snug text-muted-foreground ${
              rowSel ? "border-primary bg-muted/50" : "border-transparent"
            }`}
            style={{ paddingLeft: pad }}
            title="npm dependencies (on disk; not opened in editor)"
            onContextMenu={(ev) => {
              ev.preventDefault();
              setCtxMenu({
                top: ev.clientY,
                left: ev.clientX,
                workspace: treePluginFolder,
                path: "node_modules",
                isDir: true,
              });
            }}
            onClick={(ev) =>
              handleTreeClick(ev, treePluginFolder, rel, false, orderedPaths)
            }
          >
            <span className="mr-1 inline-block w-3 shrink-0 text-[10px]">▸</span>
            {n.name}
          </div>
        </li>
      );
    }
    if (pathLooksLikeDir(rel) && !isNodeModulesListMarker(rel)) {
      const fsRel = fsRelFromTreePath(rel);
      return (
        <li key={rel} className="list-none">
          <div
            draggable
            style={{ paddingLeft: pad }}
            className={`flex w-full cursor-grab truncate border-l-2 py-[4px] pr-2 text-left font-mono text-[12px] leading-snug active:cursor-grabbing ${
              rowSel
                ? "border-primary bg-muted/50 font-medium text-foreground"
                : "border-transparent text-muted-foreground"
            }`}
            title={rel}
            onDragStart={(ev) => {
              ev.dataTransfer.setData(
                TREE_DND_MIME,
                JSON.stringify({
                  fromPlugin: treePluginFolder,
                  fromRel: fsRel,
                  fromIsDir: true,
                } satisfies DndPayload),
              );
              ev.dataTransfer.effectAllowed = "copyMove";
            }}
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
              if (
                p.fromPlugin === treePluginFolder &&
                (p.fromRel === fsRel || fsRel.startsWith(p.fromRel + "/"))
              ) {
                return;
              }
              dispatchIdeShellTreeFsOp({
                kind: ev.shiftKey ? "dndCopy" : "dndMove",
                fromPlugin: p.fromPlugin,
                fromRel: p.fromRel,
                fromIsDir: p.fromIsDir,
                toPlugin: treePluginFolder,
                toDirRel: fsRel,
              });
            }}
            onContextMenu={(ev) => {
              ev.preventDefault();
              setCtxMenu({
                top: ev.clientY,
                left: ev.clientX,
                workspace: treePluginFolder,
                path: fsRel,
                isDir: true,
              });
            }}
            onClick={(ev) =>
              handleTreeClick(ev, treePluginFolder, rel, true, orderedPaths)
            }
          >
            <span className="mr-1 inline-block w-3 shrink-0 text-[10px] text-muted-foreground/90">
              ▸
            </span>
            <span className="font-medium">{n.name}</span>
          </div>
        </li>
      );
    }
    return (
      <li key={rel || `${depth}-${n.name}`} className="list-none">
        <button
          type="button"
          draggable
          style={{ paddingLeft: pad }}
          className={`w-full cursor-grab truncate border-l-2 py-[4px] pr-2 text-left font-mono text-[12px] leading-snug transition-colors hover:bg-muted/50 active:cursor-grabbing ${
            active || rowSel
              ? "border-primary bg-muted/50 font-medium text-foreground"
              : "border-transparent text-foreground"
          }`}
          title={rel}
          onDragStart={(ev) => {
            ev.dataTransfer.setData(
              TREE_DND_MIME,
              JSON.stringify({
                fromPlugin: treePluginFolder,
                fromRel: rel,
                fromIsDir: false,
              } satisfies DndPayload),
            );
            ev.dataTransfer.effectAllowed = "copyMove";
          }}
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
            const parentDir = rel.includes("/")
              ? rel.slice(0, rel.lastIndexOf("/"))
              : "";
            if (
              p.fromPlugin === treePluginFolder &&
              (p.fromRel === rel || rel.startsWith(p.fromRel + "/"))
            ) {
              return;
            }
            dispatchIdeShellTreeFsOp({
              kind: ev.shiftKey ? "dndCopy" : "dndMove",
              fromPlugin: p.fromPlugin,
              fromRel: p.fromRel,
              fromIsDir: p.fromIsDir,
              toPlugin: treePluginFolder,
              toDirRel: parentDir,
            });
          }}
          onContextMenu={(ev) => {
            ev.preventDefault();
            setCtxMenu({
              top: ev.clientY,
              left: ev.clientX,
              workspace: treePluginFolder,
              path: rel,
              isDir: false,
            });
          }}
          onClick={(ev) =>
            handleTreeClick(ev, treePluginFolder, rel, false, orderedPaths)
          }
        >
          <span className="mr-1 inline-block w-3 shrink-0 text-center text-[10px] text-muted-foreground">
            ·
          </span>
          {n.name}
        </button>
      </li>
    );
  });
}
