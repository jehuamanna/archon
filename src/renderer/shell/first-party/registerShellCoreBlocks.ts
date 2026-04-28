import { useEffect } from "react";
import { useShellRegistries } from "../registries/ShellRegistriesContext";
import { useShellViewRegistry } from "../views/ShellViewContext";
import { parseShellHash } from "../shellTabUrlSync";
import { WelcomeShellView } from "./WelcomeShellView";
import { SHELL_TAB_WELCOME_TYPE_ID } from "./shellWorkspaceIds";

/**
 * Minimal first-party shell blocks (React views, no iframes).
 */
export function useRegisterShellCoreBlocks(): void {
  const regs = useShellRegistries();
  const views = useShellViewRegistry();

  useEffect(() => {
    const disposers: Array<() => void> = [];

    disposers.push(
      views.registerView({
        id: "shell.welcome",
        title: "Welcome",
        defaultRegion: "mainArea",
        component: WelcomeShellView,
        capabilities: { allowedCommands: "allShellCommands", readContext: true },
      }),
    );

    disposers.push(
      regs.menuRail.registerItem({
        id: "shell.rail.welcome",
        title: "Welcome",
        icon: "N",
        order: 0,
        tabTypeId: SHELL_TAB_WELCOME_TYPE_ID,
        tabReuseKey: "shell:welcome",
        // Welcome is self-contained — the sidebar should be empty and
        // collapsed when activating it. Without this, switching to the
        // Welcome tab would leave whatever sidebar view was previously
        // open hanging around.
        collapseChrome: { sidebarPanel: true },
      }),
    );

    disposers.push(
      regs.tabs.registerTabType({
        id: SHELL_TAB_WELCOME_TYPE_ID,
        title: "Welcome",
        order: 0,
        viewId: "shell.welcome",
      }),
    );
    const initialHash = typeof window !== "undefined" ? parseShellHash() : null;
    const skipDefaultWelcome = initialHash?.kind === "tab" || initialHash?.kind === "welcome";
    if (!skipDefaultWelcome) {
      regs.tabs.openOrReuseTab(SHELL_TAB_WELCOME_TYPE_ID, {
        title: "Welcome",
        reuseKey: "shell:welcome",
      });
    }

    return () => {
      for (const d of disposers) d();
    };
  }, [regs, views]);
}
