#!/usr/bin/env node

const useHttp = process.argv.includes("--http");

if (useHttp) {
  import("./http-server.js").then(({ runMcpHttpServer }) =>
    runMcpHttpServer().catch((err) => {
      console.error("[archon-mcp]", err);
      process.exit(1);
    }),
  );
} else {
  import("./server.js").then(({ runMcpStdioServer }) =>
    runMcpStdioServer().catch((err) => {
      console.error("[archon-mcp]", err);
      process.exit(1);
    }),
  );
}
