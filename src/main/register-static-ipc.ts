import { registerStaticIpcNotesRegistryHandlers } from "./register-static-ipc-notes-registry";
import { registerStaticIpcPluginIdeMaintHandlers } from "./register-static-ipc-plugin-ide-maint";
import { registerStaticIpcPluginPackagingHandlers } from "./register-static-ipc-plugin-packaging";
import { registerStaticIpcPluginWorkspaceHandlers } from "./register-static-ipc-plugin-workspace";
import { registerRunAppReadyAssetsUndoIpc } from "./register-run-app-ready-assets-undo-ipc";
import { registerStaticIpcWpnHandlers } from "./register-static-ipc-wpn";
import { registerMcpClientIpc } from "./register-mcp-client-ipc";
import { app } from "electron";

export function registerStaticIpcHandlers(): void {
  registerStaticIpcNotesRegistryHandlers();
  registerStaticIpcPluginPackagingHandlers();
  registerStaticIpcPluginWorkspaceHandlers();
  registerStaticIpcPluginIdeMaintHandlers();
  registerStaticIpcWpnHandlers();
  /** Asset listing/import + undo/redo; registered early so renderer cannot outrace `app.ready` (e.g. HMR). */
  registerRunAppReadyAssetsUndoIpc();
  /** MCP Client: connect to external MCP servers (tools, resources, prompts). */
  registerMcpClientIpc(app.getPath("userData"));
}
