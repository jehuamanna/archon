import { getArchon } from "../../../../../shared/archon-host-access";
import type { ArchonRendererApi } from "../../../../../shared/archon-renderer-api";
import type { ArchonContributionRegistry } from "../../../archon-contribution-registry";
import type { ShellLayoutStore } from "../../../layout/ShellLayoutStore";
import type { ShellRegistries } from "../../../registries/ShellRegistriesContext";
import type { ShellViewRegistry } from "../../../views/ShellViewRegistry";
import { buildArchonShellApi, type ArchonDevtoolsShellApi } from "../../../devtoolsShellExpose";

type ArchonNotebookShellAugment = {
  /** Same as `window.archon.shell` (layout, commands, views, tabs, keymap, …). */
  shell: ArchonDevtoolsShellApi;
  /** Alias for `archon.shell` (parity with older notebook docs). */
  devtools: ArchonDevtoolsShellApi;

  /** Back-compat helpers used in docs/examples. */
  commands: {
    run(commandId: string, args?: Record<string, unknown>): void | Promise<void>;
  };
  openNote(noteId: string): void | Promise<void>;
  openPalette(): void | Promise<void>;
  openMiniBar(prefill?: string): void | Promise<void>;
  openJsNotebookScratch(): void | Promise<void>;
};

/** Injected as the `archon` builtin: `window.Archon`, `window.archon.*`, and notebook helpers. */
export type ArchonNotebookHost = ArchonRendererApi & ArchonNotebookShellAugment & Record<string, unknown>;

/** Command ids exposed to notebooks (allowlist documentation). */
export const ARCHON_NOTEBOOK_DOCUMENTED_COMMANDS = [
  "archon.notes.open",
  "archon.shell.openPalette",
  "archon.shell.openMiniBar",
  "archon.jsNotebook.open",
  "archon.script.repl.toggle",
  "archon.shell.toggle.menuRail",
  "archon.shell.toggle.sidebarPanel",
  "archon.shell.toggle.companion",
  "archon.shell.toggle.bottomDock",
  "archon.shell.toggle.miniBar",
  "archon.shell.toggle.modeLine",
  "archon.shell.closeActiveTab",
  "archon.docs.open",
] as const;

export function createNotebookArchonHost(opts: {
  invoke: (id: string, args?: Record<string, unknown>) => void | Promise<void>;
  registry: ArchonContributionRegistry;
  registries: ShellRegistries;
  layout: ShellLayoutStore;
  views: ShellViewRegistry;
}): ArchonNotebookHost {
  const { invoke, registry, registries, layout, views } = opts;

  const shell = buildArchonShellApi({ registry, layout, views, registries });

  const fromBridge =
    typeof globalThis !== "undefined" && (globalThis as unknown as { Archon?: ArchonRendererApi }).Archon
      ? (globalThis as unknown as { Archon: ArchonRendererApi }).Archon
      : ({} as Partial<ArchonRendererApi>);

  const archonWin: Record<string, unknown> =
    typeof window !== "undefined" && window.archon && typeof window.archon === "object"
      ? { ...(window.archon as object) }
      : {};
  delete archonWin.shell;

  const thin: ArchonNotebookShellAugment = {
    shell,
    devtools: shell,
    commands: {
      run: (commandId, args) => invoke(commandId, args),
    },
    openNote: (noteId) => invoke("archon.notes.open", { noteId: String(noteId).trim() }),
    openPalette: () => invoke("archon.shell.openPalette"),
    openMiniBar: (prefill) =>
      invoke("archon.shell.openMiniBar", prefill != null && prefill !== "" ? { prefill: String(prefill) } : {}),
    openJsNotebookScratch: () => invoke("archon.jsNotebook.open"),
  };

  return Object.assign({}, fromBridge, archonWin, thin) as ArchonNotebookHost;
}
