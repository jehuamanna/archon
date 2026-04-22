import type { BrowserWindow } from "electron";
import type { FSWatcher } from "chokidar";
import type { PluginLoader } from "../core/plugin-loader";
import type { McpClientManager } from "../core/mcp-client";

/** Mutable main-process state shared across IPC modules (set during `app.ready`). */
export const ctx = {
  mainWindow: null as BrowserWindow | null,
  pluginLoader: null as PluginLoader | null,
  notesPersistencePath: null as string | null,
  projectRootPath: null as string | null,
  workspaceRoots: [] as string[],
  /** True when the primary root is a temp scratch dir (no JSON written until save to folder). */
  scratchSession: false,
  ideWorkspaceWatch: null as FSWatcher | null,
  ideWorkspaceWatchTimer: null as ReturnType<typeof setTimeout> | null,
  mcpClientManager: null as McpClientManager | null,
};

export function getPluginLoader(): PluginLoader {
  if (!ctx.pluginLoader) {
    throw new Error("PluginLoader not initialized");
  }
  return ctx.pluginLoader;
}
