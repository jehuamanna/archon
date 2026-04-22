import { Suspense, type ReactElement } from "react";
import { McpAuthInner } from "./mcp-auth-inner";

export default function McpAuthPage(): ReactElement {
  return (
    <Suspense fallback={<p style={{ margin: 48, fontFamily: "system-ui" }}>Loading…</p>}>
      <McpAuthInner />
    </Suspense>
  );
}
