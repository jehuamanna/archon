import { useEffect } from "react";
import { useArchonContributionRegistry } from "../../../ArchonContributionContext";
import { useShellLayoutStore } from "../../../layout/ShellLayoutContext";
import { useShellRegistries } from "../../../registries/ShellRegistriesContext";
import { useShellViewRegistry } from "../../../views/ShellViewContext";
import { JsNotebookShellView } from "./JsNotebookShellView";

export const JS_NOTEBOOK_PLUGIN_ID = "plugin.js-notebook";

const VIEW_PRIMARY = "plugin.js-notebook.primary";
const TAB_NOTEBOOK = "plugin.js-notebook.tab";

export function useRegisterJsNotebookPlugin(): void {
  const regs = useShellRegistries();
  const views = useShellViewRegistry();
  const layout = useShellLayoutStore();
  const contrib = useArchonContributionRegistry();

  useEffect(() => {
    const disposers: Array<() => void> = [];

    disposers.push(
      views.registerView({
        id: VIEW_PRIMARY,
        title: "JS notebook",
        defaultRegion: "mainArea",
        component: JsNotebookShellView,
        capabilities: { allowedCommands: "allShellCommands", readContext: true },
      }),
    );

    disposers.push(
      regs.tabs.registerTabType({
        id: TAB_NOTEBOOK,
        title: "JS notebook",
        order: 9,
        viewId: VIEW_PRIMARY,
      }),
    );

    // JS notebook (Observable-style) rail icon hidden — still reachable via
    // the command palette and `archon.jsNotebook.open` command.
    // disposers.push(
    //   regs.menuRail.registerItem({
    //     id: "plugin.js-notebook.rail",
    //     title: "JS notebook",
    //     icon: "◉",
    //     order: 18,
    //     tabTypeId: TAB_NOTEBOOK,
    //     tabReuseKey: "plugin.js-notebook",
    //     expandChrome: { menuRail: true },
    //   }),
    // );

    disposers.push(
      contrib.registerCommand({
        id: "archon.jsNotebook.open",
        title: "JS notebook: Open",
        category: "Notebook",
        sourcePluginId: JS_NOTEBOOK_PLUGIN_ID,
        doc: "Open the JS notebook tab in the primary area.",
        api: {
          summary: "Open a new JS notebook tab and focus it in the main column.",
          args: [],
          exampleInvoke: {},
          returns: {
            type: "void",
            description: "Registers a new ShellTabsRegistry instance for plugin.js-notebook.tab.",
          },
        },
        handler: () => {
          layout.setVisible("menuRail", true);
          const inst = regs.tabs.openOrReuseTab(TAB_NOTEBOOK, {
            title: "JS notebook",
            reuseKey: "plugin.js-notebook",
          });
          const vid = regs.tabs.resolveViewForInstance(inst.instanceId);
          if (vid) views.openView(vid, "mainArea");
        },
      }),
    );

    return () => {
      for (const d of disposers) d();
    };
  }, [contrib, layout, regs, views]);
}
