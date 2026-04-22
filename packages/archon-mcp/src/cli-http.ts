#!/usr/bin/env node
import { runMcpHttpServer } from "./http-server.js";

void runMcpHttpServer().catch((err) => {
  console.error("[archon-mcp]", err);
  process.exit(1);
});
