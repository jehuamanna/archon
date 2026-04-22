import type { ArchonContributionRegistry } from "../archon-contribution-registry";

export const SYSTEM_SHELL_PLUGIN_ID = "archon.system.shell";

/**
 * System "plugin" surface for command palette + mini buffer open commands.
 * Registered once from {@link useArchonShell} when the shell VM is active.
 */
export function registerSystemPaletteCommands(
  registry: ArchonContributionRegistry,
  handlers: {
    openPalette: () => void;
    openMiniBar: (prefill?: string) => void;
  },
): () => void {
  const disposePalette = registry.registerCommand({
    id: "archon.shell.openPalette",
    title: "Shell: Open command palette",
    category: "Shell",
    sourcePluginId: SYSTEM_SHELL_PLUGIN_ID,
    doc: "Open the command palette UI.",
    api: {
      summary: "Open the command palette to search and run registered commands.",
      args: [],
      exampleInvoke: {},
      returns: {
        type: "void",
        description: "Opens UI overlay; no return value.",
      },
    },
    handler: () => handlers.openPalette(),
  });
  const disposeMini = registry.registerCommand({
    id: "archon.shell.openMiniBar",
    title: "Shell: Open mini buffer (M-x)",
    category: "Shell",
    sourcePluginId: SYSTEM_SHELL_PLUGIN_ID,
    doc: "Open the mini buffer input UI.",
    api: {
      summary: "Open the minibuffer (M-x) for typing a command id and optional JSON args.",
      args: [
        {
          name: "prefill",
          type: "string",
          required: false,
          description: "Text inserted into the minibuffer when it opens.",
          default: "",
        },
      ],
      exampleInvoke: { prefill: "archon.shell.openPalette" },
      returns: {
        type: "void",
        description: "Focuses minibuffer; optional CustomEvent archon-minibar-focus.",
      },
    },
    handler: (args) => {
      const prefill = String(args?.prefill ?? "");
      try {
        window.dispatchEvent(new CustomEvent("archon-minibar-focus", { detail: { prefill } }));
      } catch {
        /* ignore */
      }
      handlers.openMiniBar(prefill);
    },
  });
  return () => {
    disposePalette();
    disposeMini();
  };
}
