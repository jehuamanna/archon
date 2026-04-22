import React, { useEffect } from "react";
import { ensureSesLockdown } from "./shell/sandbox/sesLockdown";
import { ChromeOnlyWorkbench } from "./shell/ChromeOnlyWorkbench";
import { ArchonCommandPalette } from "./shell/ArchonCommandPalette";
import { ArchonMiniBar } from "./shell/ArchonMiniBar";
import { ArchonModeLineHost } from "./shell/ArchonModeLineHost";
import { ArchonReplOverlay } from "./shell/ArchonReplOverlay";
import { useArchonShell } from "./shell/useArchonShell";
import { useNotificationsPolling } from "./shell/useNotificationsPolling";
import { useShellLayoutState } from "./shell/layout/ShellLayoutContext";
import { useRegisterShellCoreBlocks } from "./shell/first-party/registerShellCoreBlocks";
import { useRegisterShellDefaultKeybindings } from "./shell/first-party/registerShellDefaultKeybindings";
import { useRegisterAdminPlugin } from "./shell/first-party/plugins/admin/useRegisterAdminPlugin";
import { useRegisterNotificationsPlugin } from "./shell/first-party/plugins/notifications/useRegisterNotificationsPlugin";
import { useRegisterDocumentationPlugin } from "./shell/first-party/plugins/documentation/useRegisterDocumentationPlugin";
import { useRegisterNotesExplorerPlugin } from "./shell/first-party/plugins/notes-explorer/useRegisterNotesExplorerPlugin";
import { useRegisterJsNoteEditor } from "./shell/first-party/plugins/js-notebook/useRegisterJsNoteEditor";
import { useRegisterJsNotebookPlugin } from "./shell/first-party/plugins/js-notebook/useRegisterJsNotebookPlugin";
import { useRegisterNotesShellPlugin } from "./shell/first-party/useRegisterNotesShellPlugin";
import { useRegisterMarkdownNotePlugin } from "./shell/first-party/plugins/markdown/useRegisterMarkdownNotePlugin";
import { useRegisterImageNotesPlugin } from "./shell/first-party/plugins/image-notes/useRegisterImageNotesPlugin";
import { GlobalContextMenuHost } from "./shell/GlobalContextMenuHost";
import { AcceptInviteScreen } from "./auth/AcceptInviteScreen";
import { AuthProvider } from "./auth/AuthContext";
import { AuthGate } from "./auth/AuthGate";
import { WebPostAuthRedirectBootstrap } from "./auth/WebPostAuthRedirectBootstrap";
import { isElectronScratchSession } from "./auth/electron-scratch";
import { isWebScratchSession } from "./auth/web-scratch";
import { initCloudSyncRuntime } from "./cloud-sync/initCloudSyncRuntime";
import { isElectronUserAgent } from "./archon-web-shim";
import { platformDeps, store } from "./store";
import { hydrateCloudNotesFromRxDbThunk } from "./store/cloudNotesSlice";

ensureSesLockdown();

function readInviteTokenFromUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const m = window.location.pathname.match(/^\/invite\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

function WebScratchCloudHydrator(): null {
  useEffect(() => {
    if (typeof window === "undefined" || isElectronUserAgent()) {
      return;
    }
    if (!isWebScratchSession()) {
      return;
    }
    void store.dispatch(hydrateCloudNotesFromRxDbThunk());
  }, []);
  return null;
}

function ElectronScratchCloudHydrator(): null {
  useEffect(() => {
    if (typeof window === "undefined" || !isElectronUserAgent()) {
      return;
    }
    if (!isElectronScratchSession()) {
      return;
    }
    void store.dispatch(hydrateCloudNotesFromRxDbThunk());
  }, []);
  return null;
}

function CloudRuntimeBootstrap(): null {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    initCloudSyncRuntime(platformDeps, store.dispatch);
  }, []);
  return null;
}

const App: React.FC = () => {
  const shellVm = useArchonShell();
  const layout = useShellLayoutState();
  useRegisterMarkdownNotePlugin();
  useRegisterImageNotesPlugin();
  useRegisterShellCoreBlocks();
  useRegisterShellDefaultKeybindings();
  useRegisterJsNotebookPlugin();
  useRegisterJsNoteEditor();
  useRegisterDocumentationPlugin();
  useRegisterNotesShellPlugin();
  useRegisterNotesExplorerPlugin();
  useRegisterAdminPlugin();
  useRegisterNotificationsPlugin();
  useNotificationsPolling();

  const inviteToken = readInviteTokenFromUrl();

  if (inviteToken) {
    return (
      <AuthProvider>
        <div className="min-h-screen w-full" data-testid="archon-app-root">
          <AcceptInviteScreen
            token={inviteToken}
            onAccepted={() => {
              if (typeof window !== "undefined") {
                window.history.replaceState(null, "", "/");
                window.location.reload();
              }
            }}
          />
        </div>
      </AuthProvider>
    );
  }

  return (
    <AuthProvider>
      <WebPostAuthRedirectBootstrap />
      <div className="min-h-screen w-full" data-testid="archon-app-root">
        <AuthGate>
          <CloudRuntimeBootstrap />
          <WebScratchCloudHydrator />
          <ElectronScratchCloudHydrator />
          <div className="flex h-screen min-h-0 flex-col">
            {/* Reserve vertical space for mode line + minibuffer so they do not overlay the workbench. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <ChromeOnlyWorkbench />
            </div>
            {/* Emacs order: mode line above minibuffer; minibuffer sits on the bottom edge. */}
            {layout.visible.modeLine ? <ArchonModeLineHost /> : null}
            <ArchonCommandPalette vm={shellVm} />
            {layout.visible.miniBar ? <ArchonMiniBar vm={shellVm} /> : null}
            <ArchonReplOverlay />
            <GlobalContextMenuHost />
          </div>
        </AuthGate>
      </div>
    </AuthProvider>
  );
};

export default App;
