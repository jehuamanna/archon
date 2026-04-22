export type PluginProgressPayload = {
  op: "bundle" | "export" | "npm" | "import";
  phase: string;
  message: string;
  pluginName?: string;
};

let sink: ((p: PluginProgressPayload) => void) | null = null;

export function setPluginProgressSink(fn: typeof sink): void {
  sink = fn;
}

export function emitPluginProgress(p: PluginProgressPayload): void {
  try {
    sink?.(p);
  } catch {
    /* ignore */
  }
}
