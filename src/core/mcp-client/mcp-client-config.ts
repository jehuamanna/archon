import fs from "node:fs";
import path from "node:path";

export type McpStdioTransportConfig = {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type McpSseTransportConfig = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
};

export type McpStreamableHttpTransportConfig = {
  type: "streamable-http";
  url: string;
  headers?: Record<string, string>;
};

export type McpTransportConfig =
  | McpStdioTransportConfig
  | McpSseTransportConfig
  | McpStreamableHttpTransportConfig;

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransportConfig;
}

const CONFIG_FILENAME = "archon-mcp-servers.json";

function configPath(userDataPath: string): string {
  return path.join(userDataPath, CONFIG_FILENAME);
}

export function readMcpServersConfig(userDataPath: string): McpServerConfig[] {
  const p = configPath(userDataPath);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeMcpServersConfig(
  userDataPath: string,
  configs: McpServerConfig[],
): void {
  const p = configPath(userDataPath);
  fs.writeFileSync(p, JSON.stringify(configs, null, 2), "utf-8");
}
