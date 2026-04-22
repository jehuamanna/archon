import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import MainDebugDockContent from "./MainDebugDockContent";
import { useMainDebugLogStream } from "./useMainDebugLogStream";

/** When set, the bottom debug dock starts expanded after first layout. */
const MAIN_DEBUG_DOCK_OPEN_KEY = "archon-main-debug-dock-open";

type MainDebugDockContextValue = {
  toggleMainDebugDock: () => void;
  /** True when the dock panel is not collapsed. */
  mainDebugDockExpanded: boolean;
};

const MainDebugDockContext = createContext<MainDebugDockContextValue | null>(
  null,
);

export function useMainDebugDock(): MainDebugDockContextValue {
  const ctx = useContext(MainDebugDockContext);
  if (!ctx) {
    throw new Error("useMainDebugDock must be used within MainDebugDockProvider");
  }
  return ctx;
}

export function MainDebugDockProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const bottomPanelRef = useRef<ImperativePanelHandle | null>(null);
  const [mainDebugDockExpanded, setMainDebugDockExpanded] = useState(
    () => localStorage.getItem(MAIN_DEBUG_DOCK_OPEN_KEY) === "1",
  );
  const log = useMainDebugLogStream();

  const toggleMainDebugDock = useCallback(() => {
    const p = bottomPanelRef.current;
    if (!p) {
      return;
    }
    if (p.isCollapsed()) {
      p.expand();
      localStorage.setItem(MAIN_DEBUG_DOCK_OPEN_KEY, "1");
      setMainDebugDockExpanded(true);
    } else {
      p.collapse();
      localStorage.removeItem(MAIN_DEBUG_DOCK_OPEN_KEY);
      setMainDebugDockExpanded(false);
    }
  }, []);

  useEffect(() => {
    const open = localStorage.getItem(MAIN_DEBUG_DOCK_OPEN_KEY) === "1";
    const id = window.setTimeout(() => {
      if (open) {
        bottomPanelRef.current?.expand();
      } else {
        bottomPanelRef.current?.collapse();
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  const value = useMemo(
    () => ({ toggleMainDebugDock, mainDebugDockExpanded }),
    [toggleMainDebugDock, mainDebugDockExpanded],
  );

  return (
    <MainDebugDockContext.Provider value={value}>
      <PanelGroup
        direction="vertical"
        autoSaveId="archon-main-debug-dock"
        className="min-h-0 flex-1"
      >
        <Panel defaultSize={78} minSize={35} className="min-h-0">
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            {children}
          </div>
        </Panel>
        <PanelResizeHandle className="archon-panel-sash relative h-1 shrink-0 bg-transparent transition-colors before:absolute before:inset-x-0 before:top-1/2 before:z-10 before:h-px before:-translate-y-1/2 before:bg-border before:transition-colors hover:before:bg-resize-handle-hover data-[panel-resize-handle-active=true]:before:bg-resize-handle-active" />
        <Panel
          ref={bottomPanelRef}
          collapsible
          collapsedSize={0}
          minSize={12}
          defaultSize={22}
          className="min-h-0 flex flex-col"
          onCollapse={() => {
            localStorage.removeItem(MAIN_DEBUG_DOCK_OPEN_KEY);
            setMainDebugDockExpanded(false);
          }}
          onExpand={() => {
            localStorage.setItem(MAIN_DEBUG_DOCK_OPEN_KEY, "1");
            setMainDebugDockExpanded(true);
          }}
        >
          <MainDebugDockContent
            mainDebugLogs={log.mainDebugLogs}
            logScrollRef={log.logScrollRef}
            clearMainDebugLogs={log.clearMainDebugLogs}
            onHide={toggleMainDebugDock}
          />
        </Panel>
      </PanelGroup>
    </MainDebugDockContext.Provider>
  );
}
