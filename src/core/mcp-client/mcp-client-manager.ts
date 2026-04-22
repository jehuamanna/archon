import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  McpServerConfig,
  McpTransportConfig,
} from "./mcp-client-config";

type AnyTransport = InstanceType<typeof StdioClientTransport> | InstanceType<typeof SSEClientTransport> | InstanceType<typeof StreamableHTTPClientTransport>;

export type McpConnectionStatus = "connected" | "connecting" | "disconnected" | "error";

export interface McpConnection {
  config: McpServerConfig;
  client: Client;
  transport: AnyTransport;
  status: McpConnectionStatus;
  error?: string;
}

export type McpClientEventType =
  | "status-changed"
  | "tools-changed"
  | "resources-changed"
  | "prompts-changed";

export type McpClientEventHandler = (
  serverId: string,
  event: McpClientEventType,
) => void;

function createTransport(cfg: McpTransportConfig): AnyTransport {
  switch (cfg.type) {
    case "stdio":
      return new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        cwd: cfg.cwd,
      });
    case "sse":
      return new SSEClientTransport(new URL(cfg.url));
    case "streamable-http":
      return new StreamableHTTPClientTransport(new URL(cfg.url));
  }
}

export class McpClientManager {
  private connections = new Map<string, McpConnection>();
  private listeners: McpClientEventHandler[] = [];

  onEvent(handler: McpClientEventHandler): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((h) => h !== handler);
    };
  }

  private emit(serverId: string, event: McpClientEventType): void {
    for (const h of this.listeners) {
      try {
        h(serverId, event);
      } catch {
        // ignore listener errors
      }
    }
  }

  async connectServer(config: McpServerConfig): Promise<void> {
    // Disconnect existing connection if any
    if (this.connections.has(config.id)) {
      await this.disconnectServer(config.id);
    }

    const transport = createTransport(config.transport);
    const client = new Client(
      { name: "archon-desktop", version: "1.0.0" },
      {
        capabilities: {},
        listChanged: {
          tools: { onChanged: () => this.emit(config.id, "tools-changed") },
          resources: { onChanged: () => this.emit(config.id, "resources-changed") },
          prompts: { onChanged: () => this.emit(config.id, "prompts-changed") },
        },
      },
    );

    const conn: McpConnection = {
      config,
      client,
      transport,
      status: "connecting",
    };
    this.connections.set(config.id, conn);
    this.emit(config.id, "status-changed");

    try {
      await client.connect(transport);
      conn.status = "connected";
      this.emit(config.id, "status-changed");

      transport.onclose = () => {
        conn.status = "disconnected";
        this.emit(config.id, "status-changed");
      };

      transport.onerror = (err) => {
        conn.status = "error";
        conn.error = err.message;
        this.emit(config.id, "status-changed");
      };
    } catch (err) {
      conn.status = "error";
      conn.error = err instanceof Error ? err.message : String(err);
      this.emit(config.id, "status-changed");
      throw err;
    }
  }

  async disconnectServer(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;
    try {
      await conn.client.close();
    } catch {
      // best-effort
    }
    conn.status = "disconnected";
    this.connections.delete(id);
    this.emit(id, "status-changed");
  }

  async disconnectAll(): Promise<void> {
    const ids = [...this.connections.keys()];
    await Promise.allSettled(ids.map((id) => this.disconnectServer(id)));
  }

  getConnection(id: string): McpConnection | undefined {
    return this.connections.get(id);
  }

  getConnections(): McpConnection[] {
    return [...this.connections.values()];
  }

  async listTools(serverId: string) {
    const conn = this.connections.get(serverId);
    if (!conn || conn.status !== "connected") {
      throw new Error(`Server ${serverId} is not connected`);
    }
    return conn.client.listTools();
  }

  async callTool(serverId: string, name: string, args?: Record<string, unknown>) {
    const conn = this.connections.get(serverId);
    if (!conn || conn.status !== "connected") {
      throw new Error(`Server ${serverId} is not connected`);
    }
    return conn.client.callTool({ name, arguments: args });
  }

  async listResources(serverId: string) {
    const conn = this.connections.get(serverId);
    if (!conn || conn.status !== "connected") {
      throw new Error(`Server ${serverId} is not connected`);
    }
    return conn.client.listResources();
  }

  async readResource(serverId: string, uri: string) {
    const conn = this.connections.get(serverId);
    if (!conn || conn.status !== "connected") {
      throw new Error(`Server ${serverId} is not connected`);
    }
    return conn.client.readResource({ uri });
  }

  async listPrompts(serverId: string) {
    const conn = this.connections.get(serverId);
    if (!conn || conn.status !== "connected") {
      throw new Error(`Server ${serverId} is not connected`);
    }
    return conn.client.listPrompts();
  }

  async getPrompt(serverId: string, name: string, args?: Record<string, string>) {
    const conn = this.connections.get(serverId);
    if (!conn || conn.status !== "connected") {
      throw new Error(`Server ${serverId} is not connected`);
    }
    return conn.client.getPrompt({ name, arguments: args });
  }
}
