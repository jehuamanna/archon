import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import {
  McpClientManager,
  readMcpServersConfig,
  writeMcpServersConfig,
} from "../core/mcp-client";
import type { McpServerConfig } from "../core/mcp-client";
import { ctx } from "./main-context";

export function registerMcpClientIpc(userDataPath: string): void {
  const manager = new McpClientManager();
  ctx.mcpClientManager = manager;

  // Forward events to renderer
  manager.onEvent((serverId, event) => {
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send(IPC_CHANNELS.MCP_CLIENT_EVENT, {
        serverId,
        event,
      });
    }
  });

  // --- Config CRUD ---

  ipcMain.handle(IPC_CHANNELS.MCP_CLIENT_LIST_SERVERS, () => {
    return readMcpServersConfig(userDataPath);
  });

  ipcMain.handle(
    IPC_CHANNELS.MCP_CLIENT_ADD_SERVER,
    async (_event, config: Omit<McpServerConfig, "id">) => {
      const configs = readMcpServersConfig(userDataPath);
      const newConfig: McpServerConfig = { ...config, id: randomUUID() };
      configs.push(newConfig);
      writeMcpServersConfig(userDataPath, configs);
      if (newConfig.enabled) {
        await manager.connectServer(newConfig).catch(() => {});
      }
      return newConfig;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_CLIENT_UPDATE_SERVER,
    async (_event, config: McpServerConfig) => {
      const configs = readMcpServersConfig(userDataPath);
      const idx = configs.findIndex((c) => c.id === config.id);
      if (idx === -1) throw new Error(`Server ${config.id} not found`);
      configs[idx] = config;
      writeMcpServersConfig(userDataPath, configs);
      // Reconnect if enabled, disconnect if disabled
      if (config.enabled) {
        await manager.connectServer(config).catch(() => {});
      } else {
        await manager.disconnectServer(config.id);
      }
      return config;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_CLIENT_REMOVE_SERVER,
    async (_event, serverId: string) => {
      await manager.disconnectServer(serverId);
      const configs = readMcpServersConfig(userDataPath);
      const filtered = configs.filter((c) => c.id !== serverId);
      writeMcpServersConfig(userDataPath, filtered);
      return { ok: true };
    },
  );

  // --- Connection management ---

  ipcMain.handle(
    IPC_CHANNELS.MCP_CLIENT_CONNECT,
    async (_event, serverId: string) => {
      const configs = readMcpServersConfig(userDataPath);
      const config = configs.find((c) => c.id === serverId);
      if (!config) throw new Error(`Server ${serverId} not found in config`);
      await manager.connectServer(config);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_CLIENT_DISCONNECT,
    async (_event, serverId: string) => {
      await manager.disconnectServer(serverId);
      return { ok: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS.MCP_CLIENT_DISCONNECT_ALL, async () => {
    await manager.disconnectAll();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MCP_CLIENT_GET_STATUS, (_event, serverId: string) => {
    const conn = manager.getConnection(serverId);
    if (!conn) return { status: "disconnected" as const };
    return { status: conn.status, error: conn.error };
  });

  // --- Tool / Resource / Prompt operations ---

  ipcMain.handle(
    IPC_CHANNELS.MCP_CLIENT_LIST_TOOLS,
    async (_event, serverId: string) => {
      return manager.listTools(serverId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_CLIENT_CALL_TOOL,
    async (_event, serverId: string, name: string, args?: Record<string, unknown>) => {
      return manager.callTool(serverId, name, args);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_CLIENT_LIST_RESOURCES,
    async (_event, serverId: string) => {
      return manager.listResources(serverId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_CLIENT_READ_RESOURCE,
    async (_event, serverId: string, uri: string) => {
      return manager.readResource(serverId, uri);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_CLIENT_LIST_PROMPTS,
    async (_event, serverId: string) => {
      return manager.listPrompts(serverId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_CLIENT_GET_PROMPT,
    async (_event, serverId: string, name: string, args?: Record<string, string>) => {
      return manager.getPrompt(serverId, name, args);
    },
  );

  // Auto-connect enabled servers on startup
  const configs = readMcpServersConfig(userDataPath);
  for (const config of configs) {
    if (config.enabled) {
      manager.connectServer(config).catch((err) => {
        console.warn(`[MCP Client] Failed to auto-connect ${config.name}:`, err.message);
      });
    }
  }
}
