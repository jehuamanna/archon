import { getArchon } from "../../shared/archon-host-access";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DND_ASSET_MIME,
  type SidebarAssetDragPayload,
} from "../../shared/sidebar-asset-dnd";

type DragPayload = SidebarAssetDragPayload;

function assetDirname(rel: string): string {
  const s = rel.replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i === -1 ? "" : s.slice(0, i);
}

function readExpandedMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem("archon.projectAssetsExpanded");
    if (!raw) {
      return {};
    }
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== "object") {
      return {};
    }
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === "boolean") {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeExpandedKey(storageKey: string, expanded: boolean): void {
  try {
    const m = readExpandedMap();
    m[storageKey] = expanded;
    localStorage.setItem("archon.projectAssetsExpanded", JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

type Props = {
  projectRoot: string;
  depth: number;
  storageKey: string;
  /** Project-level refresh tick to keep current folder but re-list entries. */
  refreshTick?: number;
  onOpenFile: (relativePath: string) => void;
  onAssetMoved?: () => void;
};

export default function ProjectAssetsInline({
  projectRoot,
  depth,
  storageKey,
  refreshTick,
  onOpenFile,
  onAssetMoved,
}: Props) {
  const pad = 6 + depth * 12;
  const [expanded, setExpanded] = useState(() => {
    const m = readExpandedMap();
    return m[storageKey] !== false;
  });
  const [relDir, setRelDir] = useState("");
  const [entries, setEntries] = useState<
    { name: string; isDirectory: boolean }[]
  >([]);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  const [dropZoneActive, setDropZoneActive] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    fullRel: string;
  } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRelDir("");
  }, [projectRoot]);

  useEffect(() => {
    if (!ctxMenu) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (ctxMenuRef.current?.contains(e.target as Node)) {
        return;
      }
      setCtxMenu(null);
    };
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
    };
  }, [ctxMenu]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await getArchon().listAssets(relDir, projectRoot);
      if (cancelled) {
        return;
      }
      if (!r.ok) {
        setErr(r.error);
        setEntries([]);
        return;
      }
      setErr(null);
      setEntries(r.entries);
    })();
    return () => {
      cancelled = true;
    };
  }, [relDir, projectRoot, tick, refreshTick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const pathJoin = (dir: string, name: string) =>
    dir ? `${dir}/${name}` : name;

  const parseDragPayload = (e: React.DragEvent): DragPayload | null => {
    const raw = e.dataTransfer.getData(DND_ASSET_MIME);
    if (!raw) {
      return null;
    }
    try {
      const o = JSON.parse(raw) as unknown;
      if (
        !o ||
        typeof o !== "object" ||
        typeof (o as DragPayload).fromProject !== "string" ||
        typeof (o as DragPayload).fromRel !== "string"
      ) {
        return null;
      }
      return o as DragPayload;
    } catch {
      return null;
    }
  };

  const runMove = useCallback(
    async (payload: DragPayload, toDirRel: string): Promise<void> => {
      if (
        payload.fromProject === projectRoot &&
        assetDirname(payload.fromRel) === toDirRel
      ) {
        return;
      }
      const r = await getArchon().moveProjectAsset({
        fromProject: payload.fromProject,
        fromRel: payload.fromRel,
        toProject: projectRoot,
        toDirRel,
      });
      if (!r.ok) {
        return;
      }
      refresh();
      onAssetMoved?.();
    },
    [projectRoot, refresh, onAssetMoved],
  );

  const goUp = () => {
    if (!relDir) {
      return;
    }
    const i = relDir.lastIndexOf("/");
    setRelDir(i === -1 ? "" : relDir.slice(0, i));
  };

  const toggleExpanded = () => {
    setExpanded((e) => {
      const n = !e;
      writeExpandedKey(storageKey, n);
      return n;
    });
  };

  return (
    <li className="list-none">
      <div
        className="rounded-md border border-dashed border-border/50 bg-sidebar-accent/15"
        style={{ marginLeft: pad }}
      >
        <div className="flex items-center gap-1 border-b border-border/40 px-1 py-1">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-sidebar-accent/50"
            onClick={toggleExpanded}
            aria-expanded={expanded}
          >
            <span className="w-4 shrink-0 text-center text-[10px] text-muted-foreground">
              {expanded ? "▾" : "▸"}
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Assets
            </span>
          </button>
        </div>
        {expanded ? (
          <div
            className="max-h-52 overflow-y-auto px-1 py-1"
            data-archon-own-contextmenu
          >
            {relDir ? (
              <button
                type="button"
                className="mb-0.5 flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-sidebar-accent/50"
                onClick={goUp}
              >
                <span className="opacity-70">↑</span> ..
              </button>
            ) : null}
            {err ? (
              <div className="px-1 py-0.5 text-[10px] text-foreground/85">{err}</div>
            ) : entries.length === 0 ? (
              <div className="px-1 py-1 text-[10px] text-muted-foreground">
                Empty
              </div>
            ) : (
              <ul className="space-y-px">
                {entries.map((ent) => {
                  const fullRel = pathJoin(relDir, ent.name);
                  return (
                    <li key={ent.name}>
                      <div
                        className={`flex w-full cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] hover:bg-sidebar-accent/60 ${
                          dragOverDir === fullRel ? "bg-foreground/8 ring-1 ring-foreground/25" : ""
                        }`}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(
                            DND_ASSET_MIME,
                            JSON.stringify({
                              fromProject: projectRoot,
                              fromRel: fullRel,
                            } satisfies DragPayload),
                          );
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(ev) => {
                          if (!ev.dataTransfer.types.includes(DND_ASSET_MIME)) {
                            return;
                          }
                          ev.preventDefault();
                          ev.dataTransfer.dropEffect = "move";
                          if (ent.isDirectory) {
                            setDragOverDir(fullRel);
                          }
                        }}
                        onDragLeave={(ev) => {
                          const r = ev.relatedTarget as Node | null;
                          if (
                            r &&
                            (ev.currentTarget as HTMLElement).contains(r)
                          ) {
                            return;
                          }
                          setDragOverDir(null);
                        }}
                        onDrop={(ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          setDragOverDir(null);
                          const p = parseDragPayload(ev);
                          if (!p) {
                            return;
                          }
                          if (ent.isDirectory) {
                            void runMove(p, fullRel);
                          } else {
                            void runMove(p, assetDirname(fullRel));
                          }
                        }}
                        onClick={() => {
                          if (ent.isDirectory) {
                            setRelDir(fullRel);
                          } else {
                            onOpenFile(fullRel);
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setCtxMenu({
                            x: e.clientX,
                            y: e.clientY,
                            fullRel,
                          });
                        }}
                      >
                        <span className="w-3 shrink-0 text-center text-[9px] text-muted-foreground">
                          {ent.isDirectory ? "▸" : "·"}
                        </span>
                        <span className="min-w-0 truncate">{ent.name}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div
              className={`mt-1 rounded border border-dashed px-1.5 py-1 text-[9px] ${
                dropZoneActive
                  ? "border-foreground/30 bg-foreground/8 text-foreground"
                  : "border-transparent text-muted-foreground/80"
              }`}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DND_ASSET_MIME)) {
                  return;
                }
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                setDropZoneActive(true);
              }}
              onDragLeave={(e) => {
                const r = e.relatedTarget as Node | null;
                if (r && (e.currentTarget as HTMLElement).contains(r)) {
                  return;
                }
                setDropZoneActive(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDropZoneActive(false);
                const p = parseDragPayload(e);
                if (!p) {
                  return;
                }
                void runMove(p, relDir);
              }}
            >
              Drop here → move into{" "}
              <span className="font-mono">
                {relDir ? `assets/${relDir}` : "assets/"}
              </span>
            </div>
          </div>
        ) : null}
      </div>
      {ctxMenu && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={ctxMenuRef}
              role="menu"
              className="fixed z-[200] min-w-[200px] rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-md"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
            >
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-[11px] hover:bg-muted/80"
                onClick={() => {
                  const rel = ctxMenu.fullRel;
                  setCtxMenu(null);
                  void getArchon().revealAssetInFileManager(rel, projectRoot);
                }}
              >
                Open containing folder
              </button>
            </div>,
            document.body,
          )
        : null}
    </li>
  );
}
