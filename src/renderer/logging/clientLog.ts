import { getArchon } from "../../shared/archon-host-access";
import type { ClientLogLevel, ClientLogPayload } from "../../shared/client-log";

export type ClientLogOptions = {
  level?: ClientLogLevel;
  component: string;
  message: string;
  noteId?: string;
  noteTitle?: string;
};

const LEVEL_METHOD: Record<
  ClientLogLevel,
  "log" | "info" | "warn" | "error" | "debug"
> = {
  log: "log",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
};

function formatLocalLine(
  component: string,
  message: string,
  noteId?: string,
  noteTitle?: string,
): string {
  const iso = new Date().toISOString();
  let line = `${iso} [Renderer:${component}] ${message}`;
  if (noteId) {
    line += ` note=${noteId}`;
  }
  if (noteTitle) {
    line += ` "${noteTitle}"`;
  }
  return line;
}

/**
 * Renderer unified log: DevTools + IPC to main (terminal, debug dock, daily log file).
 */
export function clientLog(opts: ClientLogOptions): void {
  const level = opts.level ?? "log";
  const line = formatLocalLine(
    opts.component,
    opts.message,
    opts.noteId,
    opts.noteTitle,
  );
  const m = LEVEL_METHOD[level];
  // eslint-disable-next-line no-console
  console[m](line);
  const payload: ClientLogPayload = {
    level,
    component: opts.component,
    message: opts.message,
    noteId: opts.noteId,
    noteTitle: opts.noteTitle,
  };
  try {
    getArchon().sendClientLog?.(payload);
  } catch {
    /* ignore */
  }
}
