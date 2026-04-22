import { useEffect } from "react";
import { useShellRegistries } from "../registries/ShellRegistriesContext";

/**
 * Default keybindings live in the keymap registry so plugins can override them.
 * This is intentionally minimal: bindings should map to commands.
 */
export function useRegisterShellDefaultKeybindings(): void {
  const regs = useShellRegistries();
  useEffect(() => {
    // Register defaults (id-stable); later we can gate by platform.
    return regs.keymap.registerMany([
      {
        id: "shell.keys.palette.primary",
        title: "Open command palette",
        chord: "ctrl+shift+k",
        commandId: "archon.shell.openPalette",
      },
      {
        id: "shell.keys.palette.f1",
        title: "Open command palette (F1)",
        chord: "f1",
        commandId: "archon.shell.openPalette",
      },
      {
        id: "shell.keys.minibuffer",
        title: "Open minibuffer (M-x)",
        chord: "alt+x",
        commandId: "archon.shell.openMiniBar",
      },
      {
        id: "shell.keys.repl",
        title: "Toggle REPL overlay",
        chord: "ctrl+`",
        commandId: "archon.script.repl.toggle",
      },
      {
        id: "shell.keys.closeActiveTab",
        title: "Close active tab",
        chord: "ctrl+w",
        commandId: "archon.shell.closeActiveTab",
        ignoreWhenInput: true,
      },
    ]);
  }, [regs.keymap]);
}

