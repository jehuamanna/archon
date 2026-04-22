export type ShellContext = {
  primary: {
    tabTypeId: string;
    instanceId: string;
    title?: string;
    noteId?: string;
    noteType?: string;
    metadata?: Record<string, unknown>;
  } | null;
};

export type ShellRpcRequest =
  | {
      type: "archon.shell.rpc";
      id: string;
      method:
        | "commands.invoke"
        | "commands.list"
        | "keymap.list"
        | "context.get"
        | "devtools.describe";
      params: unknown;
    };

export type ShellRpcResponse = {
  type: "archon.shell.rpc.result";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
};

export function postContextUpdateToFrames(ctx: ShellContext): void {
  if (typeof document === "undefined") return;
  const frames = document.querySelectorAll("iframe[data-archon-view-id]");
  for (const f of Array.from(frames)) {
    const win = (f as HTMLIFrameElement).contentWindow;
    if (!win) continue;
    try {
      win.postMessage(
        { type: "archon.context.update", payload: ctx },
        "*",
      );
    } catch {
      /* ignore */
    }
  }
}

