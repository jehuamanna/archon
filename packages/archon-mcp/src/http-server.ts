import { randomUUID } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createArchonMcpServer,
  loadMcpRuntimeAndClient,
} from "./server.js";

const PORT = parseInt(process.env.ARCHON_MCP_HTTP_PORT ?? "3100", 10);
const HOST = process.env.ARCHON_MCP_HTTP_HOST ?? "127.0.0.1";
const BEARER_TOKEN = process.env.ARCHON_MCP_HTTP_TOKEN ?? "";

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!BEARER_TOKEN) {
    next();
    return;
  }
  const header = req.headers.authorization ?? "";
  if (header !== `Bearer ${BEARER_TOKEN}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

export async function runMcpHttpServer(): Promise<void> {
  const { runtime, client } = loadMcpRuntimeAndClient();
  const app = express();

  app.use(authMiddleware);

  // --- Streamable HTTP transport (modern) ---
  // Each session gets its own McpServer + Transport pair.
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: McpServer }
  >();

  // Handle POST /mcp — initialize or send messages
  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Existing session
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // Reject unknown session IDs
    if (sessionId && !sessions.has(sessionId)) {
      res.status(404).json({ error: "session not found" });
      return;
    }

    // New session — create transport + server
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    const server = createArchonMcpServer(runtime, client);

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    await server.connect(transport);

    // Store after connect so sessionId is set
    if (transport.sessionId) {
      sessions.set(transport.sessionId, { transport, server });
    }

    await transport.handleRequest(req, res, req.body);
  });

  // Handle GET /mcp — SSE stream for Streamable HTTP sessions
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: "missing or invalid mcp-session-id header" });
      return;
    }
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
  });

  // Handle DELETE /mcp — terminate a session
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    const session = sessions.get(sessionId)!;
    await session.transport.close();
    sessions.delete(sessionId);
    res.status(200).json({ ok: true });
  });

  // --- Legacy SSE transport (deprecated but useful for older clients) ---
  const sseSessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    const server = createArchonMcpServer(runtime, client);

    sseSessions.set(transport.sessionId, { transport, server });
    transport.onclose = () => {
      sseSessions.delete(transport.sessionId);
    };

    await server.connect(transport);
    await transport.start();
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    if (!sessionId || !sseSessions.has(sessionId)) {
      res.status(400).json({ error: "missing or invalid sessionId query parameter" });
      return;
    }
    const session = sseSessions.get(sessionId)!;
    await session.transport.handlePostMessage(req, res, req.body);
  });

  // --- Start server ---
  app.listen(PORT, HOST, () => {
    console.log(`[archon-mcp] HTTP server listening on http://${HOST}:${PORT}`);
    console.log(`[archon-mcp]   Streamable HTTP: POST/GET/DELETE /mcp`);
    console.log(`[archon-mcp]   Legacy SSE:      GET /sse + POST /messages`);
  });
}
