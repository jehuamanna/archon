import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  MeasuringStrategy,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useSelector } from "react-redux";
import { getArchon } from "../../shared/archon-host-access";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { useShellLayoutState, useShellLayoutStore } from "./layout/ShellLayoutContext";
import { closeShellTabInstance } from "./shellTabClose";
import {
  hashForActiveTab,
  parseShellHash,
  replaceWindowHash,
  type ShellNoteTabState,
} from "./shellTabUrlSync";
import {
  getCachedCanonicalVfsPathForNoteId,
  setNoteIdVfsPathCacheFromWpnNotes,
  subscribeNoteVfsPathCacheInvalidated,
} from "./noteIdVfsPathCache";
import { resolveNoteIdFromVfsPath } from "../utils/resolve-note-vfs-path";
import type { OpenNoteInShellOptions } from "./openNoteInShell";
import { applyShellTabFromUrlHash, applyShellWelcomeHash } from "./shellRailNavigation";
import { useShellNavigation } from "./useShellNavigation";
import { useShellProjectWorkspace } from "./useShellProjectWorkspace";
import { ShellViewHost } from "./views/ShellViewHost";
import { useShellViewRegistry } from "./views/ShellViewContext";
import { useShellRegistries } from "./registries/ShellRegistriesContext";
import type { ShellAppMenuItem } from "./registries/ShellAppMenuRegistry";
import type { ShellTabInstance, ShellTabsRegistry } from "./registries/ShellTabsRegistry";
import {
  isShellNoteEditorTabType,
  SHELL_TAB_WELCOME_TYPE_ID,
} from "./first-party/shellWorkspaceIds";
import {
  SHELL_ACTIVITY_BAR_WIDTH_PX,
  SHELL_COMPANION_MIN_EXPANDED_PX,
  SHELL_SIDEBAR_MIN_EXPANDED_PX,
} from "./shellResponsiveConstants";
import { useAuth } from "../auth/AuthContext";
import { PostAuthChromeOverlay } from "../auth/PostAuthChromeOverlay";
import { isElectronCloudWpnSession } from "../auth/electron-cloud-session";
import { resetElectronScratchClearData } from "../auth/electron-scratch";
import {
  exitWebScratchKeepData,
  isWebScratchSession,
  resetWebScratchClearLocalData,
} from "../auth/web-scratch";
import { ArchonLogo } from "../components/ArchonLogo";
import { isElectronUserAgent } from "../archon-web-shim";
import {
  isSignedInCloudWpnOffline,
  shouldSkipDurableChromePersistence,
} from "../cloud-sync/signed-in-cloud-offline";
import type { RootState } from "../store";

function IconBottomDockLayout({ className }: { className?: string }): React.ReactElement {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <rect x="3" y="10" width="10" height="4" rx="0.75" fill="currentColor" />
    </svg>
  );
}

function IconCompanionLayout({ className }: { className?: string }): React.ReactElement {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <rect x="10" y="3" width="4" height="10" rx="0.75" fill="currentColor" />
    </svg>
  );
}

function IconPrimarySidebarLayout({ className }: { className?: string }): React.ReactElement {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <rect x="3" y="3" width="4" height="10" rx="0.75" fill="currentColor" />
    </svg>
  );
}

function ShellAppMenuList({
  items,
  depth,
  invokeCommand,
  onDone,
}: {
  items: ShellAppMenuItem[];
  depth: number;
  invokeCommand: (commandId: string, args?: Record<string, unknown>) => unknown;
  onDone: () => void;
}): React.ReactElement {
  return (
    <>
      {items.map((item) =>
        item.children?.length ? (
          <div key={item.id}>
            <div
              className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              style={{ paddingLeft: 12 + depth * 10 }}
            >
              {item.title}
            </div>
            <ShellAppMenuList
              items={item.children}
              depth={depth + 1}
              invokeCommand={invokeCommand}
              onDone={onDone}
            />
          </div>
        ) : item.commandId ? (
          <button
            key={item.id}
            type="button"
            className="block w-full px-3 py-2 text-left text-[11px] text-foreground hover:bg-muted/40"
            style={{ paddingLeft: 12 + depth * 10 }}
            onClick={() => {
              onDone();
              void Promise.resolve(invokeCommand(item.commandId!, item.args));
            }}
          >
            {item.title}
          </button>
        ) : null,
      )}
    </>
  );
}

function SortableTabRow({
  tab,
  active,
  onSelect,
  onClose,
  onPinNoteTab,
}: {
  tab: ShellTabInstance;
  active: boolean;
  onSelect: () => void;
  onClose: (e: React.MouseEvent) => void;
  onPinNoteTab?: (instanceId: string, tabTypeId: string) => void;
}): React.ReactElement {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: tab.instanceId,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.88 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex shrink-0 items-stretch gap-0.5 rounded-md border border-transparent hover:border-border/60"
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="archon-tab-drag-handle cursor-grab touch-none rounded-l-md border border-transparent px-1 py-1 text-[10px] text-muted-foreground hover:bg-muted/30 active:cursor-grabbing"
        aria-label="Reorder tab"
        title="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        ⣿
      </button>
      <button
        type="button"
        className={`max-w-[10rem] truncate border px-2 py-1 text-left text-[11px] ${
          active
            ? "border-border bg-muted/50 text-foreground"
            : "border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-muted/30"
        }`}
        onClick={onSelect}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (isShellNoteEditorTabType(tab.tabTypeId) && onPinNoteTab) {
            onPinNoteTab(tab.instanceId, tab.tabTypeId);
          }
        }}
        title={
          isShellNoteEditorTabType(tab.tabTypeId)
            ? "Double-click title to pin this note tab"
            : tab.instanceId
        }
      >
        {tab.pinned ? "📌 " : ""}
        {tab.title ?? tab.tabTypeId}
      </button>
      <button
        type="button"
        data-archon-tab-close=""
        className="relative z-10 rounded-r-md border border-transparent px-1.5 text-[12px] leading-none text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
        aria-label="Close tab"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose(e);
        }}
      >
        ×
      </button>
    </div>
  );
}

function applyShellHashVfsNoteTarget(
  tabs: ShellTabsRegistry,
  openNoteById: (id: string, opts?: OpenNoteInShellOptions) => void,
  parsed: { vfsPath: string; markdownHeadingSlug?: string },
): void {
  const active = tabs.getActiveTab();
  let baseNoteId: string | undefined;
  if (active && isShellNoteEditorTabType(active.tabTypeId)) {
    const st = active.state as ShellNoteTabState | undefined;
    baseNoteId = st?.noteId;
  }
  void resolveNoteIdFromVfsPath(parsed.vfsPath, baseNoteId).then((id) => {
    if (!id) return;
    openNoteById(id, {
      markdownHeadingSlug: parsed.markdownHeadingSlug,
      canonicalVfsPath: parsed.vfsPath,
    });
  });
}

function applyShellHashNoteTarget(
  tabs: ShellTabsRegistry,
  openNoteById: (id: string, opts?: OpenNoteInShellOptions) => void,
  parsed: { kind: "note"; noteId: string; markdownHeadingSlug?: string },
): void {
  const active = tabs.getActiveTab();
  const st = active?.state as ShellNoteTabState | undefined;
  const slug = parsed.markdownHeadingSlug;
  if (active && isShellNoteEditorTabType(active.tabTypeId) && st?.noteId === parsed.noteId) {
    const vfs =
      getCachedCanonicalVfsPathForNoteId(parsed.noteId) ?? st.canonicalVfsPath;
    if (slug) {
      tabs.updateTabPresentation(active.instanceId, {
        state: {
          noteId: parsed.noteId,
          markdownHeadingSlug: slug,
          ...(vfs ? { canonicalVfsPath: vfs } : {}),
        },
      });
      window.dispatchEvent(
        new CustomEvent("archon:markdown-scroll-to-heading", {
          detail: { noteId: parsed.noteId, slug },
        }),
      );
    } else {
      tabs.updateTabPresentation(active.instanceId, {
        state: {
          noteId: parsed.noteId,
          ...(vfs ? { canonicalVfsPath: vfs } : {}),
        },
      });
    }
    return;
  }
  const cachedPath = getCachedCanonicalVfsPathForNoteId(parsed.noteId);
  openNoteById(parsed.noteId, {
    ...(slug ? { markdownHeadingSlug: slug } : {}),
    ...(cachedPath ? { canonicalVfsPath: cachedPath } : {}),
  });
}

export function ChromeOnlyWorkbench(): React.ReactElement {
  const auth = useAuth();
  const cloudAuth = useSelector((s: RootState) => s.cloudAuth);
  const noteRenameEpoch = useSelector((s: RootState) => s.notes.noteRenameEpoch);
  const notesListLength = useSelector((s: RootState) => s.notes.notesList.length);
  const { workspaceRoots } = useShellProjectWorkspace();
  const projectOpen = workspaceRoots.length > 0;
  const isElectronScratchWorkbench =
    isElectronUserAgent() && auth.electronRunMode === "scratch";
  const isElectronVaultWorkbench =
    isElectronUserAgent() &&
    (auth.electronRunMode === "local" || auth.electronRunMode === "cloud");
  const layout = useShellLayoutState();
  const store = useShellLayoutStore();
  const views = useShellViewRegistry();
  const { menuRail, appMenu, panelMenu, tabs, widgetSlots } = useShellRegistries();
  const { openFromRailItem, openNoteById, invokeCommand, deps: shellNavDeps } = useShellNavigation();
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const appMenuWrapRef = useRef<HTMLDivElement>(null);
  const lastSyncedHash = useRef<string>("");
  const initialHashApplied = useRef(false);

  const primaryRef = React.useRef<ImperativePanelHandle>(null);
  const mainPanelRef = React.useRef<ImperativePanelHandle>(null);
  const companionRef = React.useRef<ImperativePanelHandle>(null);
  const bottomRef = React.useRef<ImperativePanelHandle>(null);
  const horizontalWorkspaceRef = useRef<HTMLDivElement>(null);
  const lastViewportWidthRef = useRef(0);
  /** True after we hid the side panel because the workspace was too narrow; used to restore on widen. */
  const sidebarAutoCollapsedByWidthRef = useRef(false);
  const lastPrimaryPctWithSidebarRef = useRef<number>(layout.sizes.primaryPct);
  const pendingPanelGroupLayoutRef = useRef<number[] | null>(null);
  const panelGroupLayoutRafRef = useRef<number | null>(null);
  const [workspaceWidthPx, setWorkspaceWidthPx] = useState(0);
  const [signedInCloudReadOnlyOffline, setSignedInCloudReadOnlyOffline] = useState(
    () => (typeof window !== "undefined" ? isSignedInCloudWpnOffline() : false),
  );

  useEffect(() => {
    const sync = (): void => {
      setSignedInCloudReadOnlyOffline(isSignedInCloudWpnOffline());
    };
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    sync();
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, [cloudAuth.status, cloudAuth.userId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const hSizes = useMemo(() => {
    const { primaryPct, mainPct, secondaryPct } = layout.sizes;
    const total = Math.max(1, primaryPct + mainPct + secondaryPct);
    return [
      (primaryPct / total) * 100,
      (mainPct / total) * 100,
      (secondaryPct / total) * 100,
    ];
  }, [layout.sizes]);

  const showMenuRail = layout.visible.menuRail;
  const showSidebarPanel = layout.visible.sidebarPanel;
  const showCompanion = layout.visible.companion;
  const showBottom = layout.visible.bottomArea;

  const minCompanionPct = useMemo(() => {
    if (!showCompanion || workspaceWidthPx <= 0) return 0;
    return Math.min(
      99,
      Math.max(1, Math.ceil((SHELL_COMPANION_MIN_EXPANDED_PX / workspaceWidthPx) * 100)),
    );
  }, [showCompanion, workspaceWidthPx]);

  const primaryViewId = views.getOpenViewId("primarySidebar");
  const mainViewId = views.getOpenViewId("mainArea");
  const companionViewId = views.getOpenViewId("companion");
  const bottomViewId = views.getOpenViewId("bottomArea");

  const primaryView = primaryViewId ? views.getView(primaryViewId) : undefined;
  const mainView = mainViewId ? views.getView(mainViewId) : undefined;
  const companionView = companionViewId ? views.getView(companionViewId) : undefined;
  const bottomView = bottomViewId ? views.getView(bottomViewId) : undefined;

  const railItems = menuRail.list();
  const appMenuItems = appMenu.list();

  /**
   * Ensure `ChromeOnlyWorkbench` always re-renders when the tabs registry emits.
   * We still read `tabs.listOpenTabs()` below, but this subscription guarantees React sees the change.
   */
  const tabsEpoch = useSyncExternalStore(
    (onStoreChange) => tabs.subscribe(onStoreChange),
    () => {
      const list = tabs.listOpenTabs();
      const active = tabs.getActiveTab()?.instanceId ?? "";
      return `${list.length}:${list.map((t) => t.instanceId).join(",")}:${active}:${tabs.getChangeEpoch()}`;
    },
    () => "0::",
  );
  void tabsEpoch;

  const openTabs = tabs.listOpenTabs();
  const activeTab = tabs.getActiveTab();

  const closeTabInstance = useCallback(
    (instanceId: string) => (e: React.MouseEvent) => {
      e.stopPropagation();
      closeShellTabInstance(tabs, instanceId);
    },
    [tabs],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = openTabs.findIndex((t) => t.instanceId === active.id);
      const newIndex = openTabs.findIndex((t) => t.instanceId === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      tabs.reorderTabs(oldIndex, newIndex);
    },
    [openTabs, tabs],
  );

  useEffect(() => {
    const instId = activeTab?.instanceId ?? null;
    if (!instId) return;
    const viewId = tabs.resolveViewForInstance(instId);
    if (!viewId) return;
    views.openView(viewId, "mainArea");
  }, [activeTab?.instanceId, tabs, views]);

  /** Sync primary sidebar + companion to active tab type; omit companion ids → close region + collapse chrome. */
  useEffect(() => {
    const tabTypeId = activeTab?.tabTypeId ?? null;
    if (!tabTypeId) {
      views.closeRegion("primarySidebar");
      views.closeRegion("companion");
      store.setVisible("sidebarPanel", false);
      store.setVisible("companion", false);
      return;
    }
    const t = tabs.getTabType(tabTypeId);
    if (!t) {
      views.closeRegion("primarySidebar");
      views.closeRegion("companion");
      store.setVisible("sidebarPanel", false);
      store.setVisible("companion", false);
      return;
    }
    if (t.primarySidebarViewId) {
      views.openView(t.primarySidebarViewId, "primarySidebar");
      store.setVisible("sidebarPanel", true);
    } else {
      views.closeRegion("primarySidebar");
      store.setVisible("sidebarPanel", false);
    }
    if (t.secondaryViewId) {
      views.openView(t.secondaryViewId, "companion");
      store.setVisible("companion", true);
    } else {
      views.closeRegion("companion");
      store.setVisible("companion", false);
    }
  }, [activeTab?.tabTypeId, activeTab?.instanceId, tabs, views, store]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      if (initialHashApplied.current) return;
      initialHashApplied.current = true;
      const parsed = parseShellHash();
      if (parsed?.kind === "note") {
        applyShellHashNoteTarget(tabs, openNoteById, parsed);
      } else if (parsed?.kind === "vfsNote") {
        applyShellHashVfsNoteTarget(tabs, openNoteById, parsed);
      } else if (parsed?.kind === "welcome") {
        applyShellWelcomeHash(parsed.segment, shellNavDeps, invokeCommand);
      } else if (parsed?.kind === "tab") {
        applyShellTabFromUrlHash(parsed.instanceId, shellNavDeps, invokeCommand, parsed.documentationSegments);
        if (tabs.listOpenTabs().length === 0) {
          tabs.openOrReuseTab(SHELL_TAB_WELCOME_TYPE_ID, { title: "Welcome", reuseKey: "shell:welcome" });
        }
      }
    }, 50);
    return () => window.clearTimeout(id);
  }, [invokeCommand, openNoteById, shellNavDeps, tabs]);

  useEffect(() => {
    if (!appMenuOpen) return;
    const onDocDown = (e: MouseEvent): void => {
      const el = appMenuWrapRef.current;
      if (el && !el.contains(e.target as Node)) {
        setAppMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [appMenuOpen]);

  const pushHashForActiveTab = useCallback((): void => {
    if (shouldSkipDurableChromePersistence()) {
      return;
    }
    const a = tabs.getActiveTab();
    const h = hashForActiveTab(a);
    if (!h) {
      if (lastSyncedHash.current !== "") {
        replaceWindowHash("");
        lastSyncedHash.current = "";
      }
      return;
    }
    if (typeof window !== "undefined" && window.location.hash === h) {
      lastSyncedHash.current = h;
      return;
    }
    if (h === lastSyncedHash.current) return;
    replaceWindowHash(h);
    lastSyncedHash.current = h;
  }, [tabs]);

  useEffect(() => {
    if (!projectOpen) {
      return;
    }
    const archon = getArchon();
    if (typeof archon.wpnListAllNotesWithContext !== "function") {
      return;
    }
    let cancelled = false;
    void archon
      .wpnListAllNotesWithContext()
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.notes) ? res.notes : [];
        setNoteIdVfsPathCacheFromWpnNotes(list);
      })
      .catch(() => {
        /* no project / backend race — avoid crashing shell */
      });
    return () => {
      cancelled = true;
    };
  }, [noteRenameEpoch, notesListLength, projectOpen]);

  useEffect(() => {
    return subscribeNoteVfsPathCacheInvalidated(() => {
      pushHashForActiveTab();
    });
  }, [pushHashForActiveTab]);

  useEffect(() => {
    return tabs.subscribe(() => {
      pushHashForActiveTab();
    });
  }, [tabs, pushHashForActiveTab]);

  useEffect(() => {
    const onHash = (): void => {
      const parsed = parseShellHash();
      if (parsed?.kind === "note") {
        applyShellHashNoteTarget(tabs, openNoteById, parsed);
      } else if (parsed?.kind === "vfsNote") {
        applyShellHashVfsNoteTarget(tabs, openNoteById, parsed);
      } else if (parsed?.kind === "welcome") {
        applyShellWelcomeHash(parsed.segment, shellNavDeps, invokeCommand);
      } else if (parsed?.kind === "tab") {
        applyShellTabFromUrlHash(parsed.instanceId, shellNavDeps, invokeCommand, parsed.documentationSegments);
        if (tabs.listOpenTabs().length === 0) {
          tabs.openOrReuseTab(SHELL_TAB_WELCOME_TYPE_ID, { title: "Welcome", reuseKey: "shell:welcome" });
        }
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [invokeCommand, openNoteById, shellNavDeps, tabs]);

  const renderSash = (key: string) => (
    <PanelResizeHandle
      key={key}
      className="archon-panel-sash relative w-1 shrink-0 bg-transparent transition-colors before:absolute before:inset-y-0 before:left-1/2 before:z-10 before:w-px before:-translate-x-1/2 before:bg-border before:transition-colors hover:before:bg-resize-handle-hover data-[panel-resize-handle-active=true]:before:bg-resize-handle-active"
    />
  );

  const sortableIds = openTabs.map((t) => t.instanceId);

  const schedulePersistPanelLayout = useCallback(
    (sizes: number[]) => {
      pendingPanelGroupLayoutRef.current = sizes;
      if (panelGroupLayoutRafRef.current != null) return;
      panelGroupLayoutRafRef.current = window.requestAnimationFrame(() => {
        panelGroupLayoutRafRef.current = null;
        const next = pendingPanelGroupLayoutRef.current;
        pendingPanelGroupLayoutRef.current = null;
        if (!next) return;
        store.patch((cur) => {
          if (next.length >= 3) {
            const [p, m, s] = next;
            if (store.get().visible.sidebarPanel) lastPrimaryPctWithSidebarRef.current = p;
            return {
              ...cur,
              sizes: {
                ...cur.sizes,
                primaryPct: p,
                mainPct: m,
                secondaryPct: s,
              },
            };
          }
          const [p, m] = next;
          if (store.get().visible.sidebarPanel) lastPrimaryPctWithSidebarRef.current = p;
          return {
            ...cur,
            sizes: {
              ...cur.sizes,
              primaryPct: p,
              mainPct: m,
            },
          };
        });
      });
    },
    [store],
  );

  useEffect(() => {
    return () => {
      if (panelGroupLayoutRafRef.current != null) {
        window.cancelAnimationFrame(panelGroupLayoutRafRef.current);
        panelGroupLayoutRafRef.current = null;
      }
      pendingPanelGroupLayoutRef.current = null;
    };
  }, []);

  /** Collapse/expand the side panel `Panel` based on store visibility. */
  useLayoutEffect(() => {
    if (!showSidebarPanel) {
      primaryRef.current?.collapse();
      return;
    }
    primaryRef.current?.expand(Math.max(10, lastPrimaryPctWithSidebarRef.current || hSizes[0]));
  }, [showSidebarPanel]);

  /** Collapse/expand companion `Panel` so toggles match store (panel stays mounted). */
  useLayoutEffect(() => {
    if (!showCompanion) {
      companionRef.current?.collapse();
      return;
    }
    const id = window.requestAnimationFrame(() => {
      try {
        companionRef.current?.expand(Math.max(12, hSizes[2]));
      } catch {
        /* refs not ready */
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [showCompanion, hSizes[2]]);

  /** Keep bottom dock expanded size in sync when `bottomArea` is visible (e.g. after sash collapse + toolbar toggle). */
  useLayoutEffect(() => {
    if (!showBottom) return;
    const id = window.requestAnimationFrame(() => {
      try {
        bottomRef.current?.expand(Math.max(10, layout.bottomTabs.heightPct));
      } catch {
        /* refs not ready */
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [showBottom, layout.bottomTabs.heightPct]);

  useEffect(() => {
    const tabTypeId = activeTab?.tabTypeId ?? null;
    const ty = tabTypeId ? tabs.getTabType(tabTypeId) : null;
    if (!ty?.primarySidebarViewId) {
      sidebarAutoCollapsedByWidthRef.current = false;
    }
  }, [activeTab?.tabTypeId, tabs]);

  useEffect(() => {
    if (layout.visible.sidebarPanel) {
      sidebarAutoCollapsedByWidthRef.current = false;
    }
  }, [layout.visible.sidebarPanel]);

  /** Shrink: collapse companion/sidebar when columns fall below min width. Grow: restore sidebar if we auto-collapsed it. */
  useEffect(() => {
    const el = horizontalWorkspaceRef.current;
    if (!el) return;
    let raf = 0;
    const run = (): void => {
      const W = el.clientWidth;
      if (W <= 0) return;
      setWorkspaceWidthPx((prev) => (prev !== W ? W : prev));
      const prevW = lastViewportWidthRef.current;
      lastViewportWidthRef.current = W;

      const { primaryPct: p, mainPct: m, secondaryPct: s } = layout.sizes;
      const total = Math.max(1, p + m + s);
      const railW = showMenuRail ? SHELL_ACTIVITY_BAR_WIDTH_PX : 0;
      const panelWorkspaceW = Math.max(0, W - railW);
      const leftPx = (panelWorkspaceW * p) / total;
      const rightPx = (panelWorkspaceW * s) / total;

      const shrinking = prevW === 0 || W < prevW;
      const growing = prevW !== 0 && W > prevW;

      const tabTypeId = activeTab?.tabTypeId ?? null;
      const ty = tabTypeId ? tabs.getTabType(tabTypeId) : null;
      const tabAllowsSidebar = Boolean(ty?.primarySidebarViewId);

      if (shrinking) {
        if (showCompanion && rightPx < SHELL_COMPANION_MIN_EXPANDED_PX) {
          companionRef.current?.collapse();
        }
        if (showSidebarPanel && leftPx < SHELL_SIDEBAR_MIN_EXPANDED_PX) {
          sidebarAutoCollapsedByWidthRef.current = true;
          store.setVisible("sidebarPanel", false);
        }
      }

      if ((growing || prevW === 0) && tabAllowsSidebar) {
        const pRestore = Math.max(10, lastPrimaryPctWithSidebarRef.current || p);
        const totalRestore = Math.max(1, pRestore + m + s);
        const leftIfExpanded = (panelWorkspaceW * pRestore) / totalRestore;
        if (
          sidebarAutoCollapsedByWidthRef.current &&
          !store.get().visible.sidebarPanel &&
          leftIfExpanded >= SHELL_SIDEBAR_MIN_EXPANDED_PX
        ) {
          sidebarAutoCollapsedByWidthRef.current = false;
          store.setVisible("sidebarPanel", true);
        }
      }
    };
    const schedule = (): void => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        run();
      });
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    schedule();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [activeTab?.tabTypeId, layout.sizes, showCompanion, showMenuRail, showSidebarPanel, store, tabs]);

  return (
    <div className="archon-app-pad box-border flex min-h-0 flex-1 flex-col bg-muted/45 text-foreground dark:bg-muted/25">
      {signedInCloudReadOnlyOffline ? (
        <div
          className="mb-1 shrink-0 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-1.5 text-center text-[11px] text-amber-950 dark:text-amber-100"
          role="status"
        >
          Offline — cloud workspace is read-only. Connect to the internet to save note edits and
          UI settings.
        </div>
      ) : null}
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-sm box-border outline-none"
        data-archon-main-surface
        tabIndex={-1}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-2 py-1.5">
          <div className="relative" ref={appMenuWrapRef}>
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted/20 text-[12px] font-semibold hover:bg-muted/40"
              title="App menu — Welcome and shell actions"
              aria-expanded={appMenuOpen}
              aria-haspopup="menu"
              onClick={() => {
                if (appMenuItems.length === 0) {
                  store.toggle("sidebarPanel");
                  return;
                }
                setAppMenuOpen((v) => !v);
              }}
            >
              <span className="text-primary">
                <ArchonLogo className="h-4 w-4" title="Archon" />
              </span>
            </button>
            {appMenuOpen && appMenuItems.length > 0 ? (
              <div
                className="absolute left-0 top-full z-50 mt-1 min-w-[13rem] overflow-hidden rounded-md border border-border bg-background py-1 shadow-lg"
                role="menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-2 text-left text-[11px] text-foreground hover:bg-muted/40"
                  onClick={() => {
                    setAppMenuOpen(false);
                    tabs.openOrReuseTab(SHELL_TAB_WELCOME_TYPE_ID, {
                      title: "Welcome",
                      reuseKey: "shell:welcome",
                    });
                  }}
                >
                  Welcome
                </button>
                <div className="my-1 border-t border-border" role="separator" />
                <ShellAppMenuList
                  items={appMenuItems}
                  depth={0}
                  invokeCommand={invokeCommand}
                  onDone={() => setAppMenuOpen(false)}
                />
              </div>
            ) : null}
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
            modifiers={[restrictToHorizontalAxis]}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                {openTabs.map((t) => (
                  <SortableTabRow
                    key={t.instanceId}
                    tab={t}
                    active={t.instanceId === activeTab?.instanceId}
                    onSelect={() => tabs.setActiveTab(t.instanceId)}
                    onClose={closeTabInstance(t.instanceId)}
                    onPinNoteTab={(instanceId, tabTypeId) => tabs.pinNoteTab(instanceId, tabTypeId)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          <div className="flex shrink-0 items-center gap-1">
            {!isElectronUserAgent() && isWebScratchSession() ? (
              <>
                <button
                  type="button"
                  className="rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                  onClick={() => exitWebScratchKeepData()}
                  title="Exit try-out: return to home. Try-out notes stay in this browser (localStorage flag + IndexedDB)."
                >
                  Exit session
                </button>
                <button
                  type="button"
                  className="rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Start a new try-out session? This clears try-out data in this browser (localStorage + IndexedDB). You cannot undo this.",
                      )
                    ) {
                      void resetWebScratchClearLocalData();
                    }
                  }}
                  title="New try-out session: clear localStorage + IndexedDB for scratch, then reload"
                >
                  New session
                </button>
              </>
            ) : null}
            {isElectronScratchWorkbench ? (
              <>
                <button
                  type="button"
                  className="rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                  onClick={() => auth.exitElectronSessionToWelcome()}
                  title="Exit scratch: return to welcome. Ephemeral data stays in local storage until you start a new scratch session."
                >
                  Exit session
                </button>
                <button
                  type="button"
                  className="rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Start a new scratch session? This clears scratch data in this app (IndexedDB). You cannot undo this.",
                      )
                    ) {
                      void resetElectronScratchClearData();
                    }
                  }}
                  title="Discard this scratch session and reload with an empty scratch workspace"
                >
                  New session
                </button>
              </>
            ) : null}
            {isElectronVaultWorkbench &&
            !(isElectronCloudWpnSession() && cloudAuth.status === "signedIn") ? (
              <button
                type="button"
                className="rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                onClick={() => auth.exitElectronSessionToWelcome()}
                title="Close: return to welcome. Files on disk are unchanged."
              >
                Close
              </button>
            ) : null}
            <PostAuthChromeOverlay />
            {cloudAuth.status === "signedIn" ? (
              <button
                type="button"
                className="mr-1 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                onClick={() => {
                  if (isElectronUserAgent()) {
                    auth.exitElectronSessionToWelcome();
                  } else {
                    void auth.logout();
                  }
                }}
                title={
                  isElectronUserAgent()
                    ? "Sign out of sync and return to the home dashboard. Your data on disk and on the server is unchanged."
                    : "Sign out and return to the home screen. Server-side data stays in the cloud."
                }
              >
                Logout
              </button>
            ) : null}
            <button
              type="button"
              className={`flex h-8 w-8 items-center justify-center rounded-md border border-border/60 bg-background hover:bg-muted/30 ${
                showBottom ? "border-border text-foreground" : "text-muted-foreground"
              }`}
              onClick={() => store.toggle("bottomArea")}
              title="Toggle bottom dock"
              aria-label="Toggle bottom dock"
            >
              <IconBottomDockLayout className="shrink-0" />
            </button>
            <button
              type="button"
              className={`flex h-8 w-8 items-center justify-center rounded-md border border-border/60 bg-background hover:bg-muted/30 ${
                showCompanion ? "border-border text-foreground" : "text-muted-foreground"
              }`}
              onClick={() => store.toggle("companion")}
              title="Toggle companion"
              aria-label="Toggle companion"
            >
              <IconCompanionLayout className="shrink-0" />
            </button>
          </div>
        </div>

        {/*
          Horizontal workbench: activity bar (fixed px) | sidebar (resizable, collapsible) | center (main ± bottom dock) | companion (resizable, collapsible).
          primaryRef = sidebar panel; companionRef = companion column; bottom dock sits only under the main editor column.
        */}
        <div
          ref={horizontalWorkspaceRef}
          className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-row box-border"
        >
          {showMenuRail ? (
            <div
              className="flex h-full min-h-0 shrink-0 flex-col border-r border-border bg-muted/15"
              style={{ width: SHELL_ACTIVITY_BAR_WIDTH_PX }}
            >
              {(() => {
                const renderRailButton = (it: typeof railItems[number]) => {
                  const railActive = Boolean(
                    activeTab?.tabTypeId && it.tabTypeId && it.tabTypeId === activeTab.tabTypeId,
                  );
                  const Badge = it.BadgeOverlay;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md border text-[12px] ${
                        railActive
                          ? "border-border bg-muted/50 text-foreground"
                          : "border-transparent text-muted-foreground hover:border-border hover:bg-muted/30"
                      }`}
                      title={it.title}
                      onClick={() => openFromRailItem(it)}
                    >
                      {it.icon ?? "•"}
                      {Badge ? <Badge /> : null}
                    </button>
                  );
                };
                const topItems = railItems.filter((it) => (it.placement ?? "top") === "top");
                const bottomItems = railItems.filter((it) => it.placement === "bottom");
                return (
                  <>
                    <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
                      {topItems.map(renderRailButton)}
                      {widgetSlots.list("rail").map((w) => {
                        const W = w.component;
                        return (
                          <div key={w.id} className="w-full border-t border-border/40 pt-1">
                            <W slotId="rail" />
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex shrink-0 flex-col items-center gap-1 border-t border-border/40 py-2">
                      {bottomItems.map(renderRailButton)}
                      <button
                        type="button"
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border ${
                          showSidebarPanel
                            ? "border-border bg-muted/50 text-foreground"
                            : "border-transparent text-muted-foreground hover:border-border hover:bg-muted/30"
                        }`}
                        title="Toggle side panel"
                        aria-label="Toggle side panel"
                        onClick={() => store.toggle("sidebarPanel")}
                      >
                        <IconPrimarySidebarLayout className="shrink-0" />
                      </button>
                    </div>
                  </>
                );
              })()}
            </div>
          ) : null}

          <PanelGroup
            direction="horizontal"
            className="h-full min-h-0 min-w-0 flex-1 box-border"
            onLayout={(sizes) => schedulePersistPanelLayout(sizes)}
          >
            <Panel ref={primaryRef} defaultSize={hSizes[0]} minSize={1} collapsible collapsedSize={0} className="min-w-0">
              <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                {primaryView ? (
                  <div className="flex h-full min-h-0 min-w-0 flex-col">
                    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/10 px-2 py-1">
                      <div className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
                        {primaryView.title}
                      </div>
                      {panelMenu.listFor("primarySidebar", primaryView.id).length > 0 ? (
                        <div className="relative">
                          <button
                            type="button"
                            className="rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/30"
                            onClick={() => setPanelMenuOpen((v) => !v)}
                            title="Side panel menu"
                          >
                            ⋯
                          </button>
                          {panelMenuOpen ? (
                            <div className="absolute right-0 top-full z-20 mt-1 min-w-44 overflow-hidden rounded-md border border-border bg-background shadow-lg">
                              {panelMenu.listFor("primarySidebar", primaryView.id).map((item) => (
                                <button
                                  key={item.id}
                                  type="button"
                                  className="block w-full px-3 py-2 text-left text-[11px] text-foreground hover:bg-muted/40"
                                  onClick={() => {
                                    setPanelMenuOpen(false);
                                    void Promise.resolve(invokeCommand(item.commandId, item.commandArgs));
                                  }}
                                >
                                  {item.title}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <div className="min-h-0 min-w-0 flex-1">
                      <ShellViewHost view={primaryView} />
                    </div>
                  </div>
                ) : (
                  <div className="h-full min-h-0 min-w-0 w-full bg-background" />
                )}
              </div>
            </Panel>
            {renderSash("sash-primary")}
            <Panel
              ref={mainPanelRef}
              defaultSize={hSizes[1]}
              minSize={30}
              className="min-h-0 min-w-0"
            >
              {showBottom ? (
                <PanelGroup
                  direction="vertical"
                  className="h-full min-h-0 min-w-0 box-border"
                >
                  <Panel
                    defaultSize={100 - layout.bottomTabs.heightPct}
                    minSize={40}
                    className="min-h-0"
                  >
                    <div
                      className="h-full min-h-0 min-w-0 w-full bg-background"
                      role="region"
                      aria-label="Main area"
                    >
                      {mainView ? (
                        <ShellViewHost view={mainView} activeMainTab={activeTab} />
                      ) : null}
                    </div>
                  </Panel>
                  <PanelResizeHandle className="archon-panel-sash relative h-1 shrink-0 bg-transparent transition-colors before:absolute before:inset-x-0 before:top-1/2 before:z-10 before:h-px before:-translate-y-1/2 before:bg-border before:transition-colors hover:before:bg-resize-handle-hover data-[panel-resize-handle-active=true]:before:bg-resize-handle-active" />
                  <Panel
                    ref={bottomRef}
                    defaultSize={layout.bottomTabs.heightPct}
                    minSize={10}
                    collapsible
                    collapsedSize={0}
                    onCollapse={() => store.setVisible("bottomArea", false)}
                    onExpand={() => store.setVisible("bottomArea", true)}
                    className="min-h-0"
                    onResize={(size) => {
                      store.patch((cur) => ({
                        ...cur,
                        bottomTabs: { ...cur.bottomTabs, heightPct: size },
                      }));
                    }}
                  >
                    <div className="h-full min-h-0 w-full bg-background">
                      {bottomView ? <ShellViewHost view={bottomView} /> : null}
                    </div>
                  </Panel>
                </PanelGroup>
              ) : (
                <div
                  className="h-full min-h-0 min-w-0 w-full bg-background"
                  role="region"
                  aria-label="Main area"
                >
                  {mainView ? <ShellViewHost view={mainView} activeMainTab={activeTab} /> : null}
                </div>
              )}
            </Panel>
            {renderSash("sash-companion")}
            <Panel
              ref={companionRef}
              defaultSize={hSizes[2]}
              minSize={minCompanionPct}
              collapsible
              collapsedSize={0}
              onCollapse={() => store.setVisible("companion", false)}
              onExpand={() => store.setVisible("companion", true)}
              className="min-w-0"
            >
              <div className="h-full min-h-0 min-w-0 w-full bg-background">
                {companionView ? (
                  <ShellViewHost view={companionView} activeMainTab={activeTab} />
                ) : null}
              </div>
            </Panel>
          </PanelGroup>
        </div>
      </div>
    </div>
  );
}
