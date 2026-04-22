import type { BrowserWindow } from "electron";
import { app } from "electron";
import util from "util";
import type { ClientLogLevel } from "../shared/client-log";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { appendArchonDailyLog } from "./archon-file-log";

export type MainDebugLogLevel = "log" | "info" | "warn" | "error" | "debug";

export type MainDebugLogEntry = {
  ts: number;
  level: MainDebugLogLevel;
  text: string;
};

const MAX_LINES = 3000;
const buffer: MainDebugLogEntry[] = [];

let getMainWindow: (() => BrowserWindow | null) | null = null;

let origConsole: {
  log: (...a: unknown[]) => void;
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
  debug: (...a: unknown[]) => void;
} | null = null;

export function setMainDebugLogWindow(getWin: () => BrowserWindow | null): void {
  getMainWindow = getWin;
}

function broadcast(entry: MainDebugLogEntry): void {
  const win = getMainWindow?.();
  if (!win || win.isDestroyed()) {
    return;
  }
  try {
    win.webContents.send(IPC_CHANNELS.PLUGIN_IDE_MAIN_DEBUG_LOG, entry);
  } catch {
    /* ignore */
  }
}

function pushEntry(entry: MainDebugLogEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX_LINES) {
    buffer.splice(0, buffer.length - MAX_LINES);
  }
  broadcast(entry);
}

function tryFileLine(line: string): void {
  try {
    if (app.isReady()) {
      appendArchonDailyLog(app.getPath("userData"), line);
    }
  } catch {
    /* ignore */
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) =>
      typeof a === "string"
        ? a
        : util.inspect(a, {
            depth: 5,
            maxStringLength: 12_000,
            breakLength: 100,
            compact: false,
          }),
    )
    .join(" ");
}

function append(level: MainDebugLogLevel, args: unknown[]): void {
  const text = formatArgs(args);
  const iso = new Date().toISOString();
  const line = `${iso} [Main:console.${level}] ${text}`;
  const entry: MainDebugLogEntry = { ts: Date.now(), level, text: line };
  pushEntry(entry);
  tryFileLine(line);
}

let installed = false;

export function installMainProcessDebugLogTap(): void {
  if (installed) {
    return;
  }
  installed = true;
  const c = globalThis.console;
  origConsole = {
    log: c.log.bind(c),
    info: c.info.bind(c),
    warn: c.warn.bind(c),
    error: c.error.bind(c),
    debug: c.debug.bind(c),
  };
  const o = origConsole;

  c.log = (...args: unknown[]) => {
    append("log", args);
    o.log(...args);
  };
  c.info = (...args: unknown[]) => {
    append("info", args);
    o.info(...args);
  };
  c.warn = (...args: unknown[]) => {
    append("warn", args);
    o.warn(...args);
  };
  c.error = (...args: unknown[]) => {
    append("error", args);
    o.error(...args);
  };
  c.debug = (...args: unknown[]) => {
    append("debug", args);
    o.debug(...args);
  };
}

export function getMainDebugLogBuffer(): MainDebugLogEntry[] {
  return buffer.slice();
}

export function clearMainDebugLogBuffer(): void {
  buffer.length = 0;
}

function mapClientLevel(l: ClientLogLevel): MainDebugLogLevel {
  return l;
}

/**
 * Ingest a structured line from the renderer without double-tapping the console patch.
 */
export function ingestRendererStructuredLog(payload: {
  level: ClientLogLevel;
  component: string;
  message: string;
  noteId?: string;
  noteTitle?: string;
}): void {
  const level = mapClientLevel(payload.level);
  const iso = new Date().toISOString();
  let line = `${iso} [Renderer:${payload.component}] ${payload.message}`;
  if (payload.noteId) {
    line += ` note=${payload.noteId}`;
  }
  if (payload.noteTitle) {
    line += ` "${payload.noteTitle}"`;
  }
  const entry: MainDebugLogEntry = { ts: Date.now(), level, text: line };
  pushEntry(entry);
  tryFileLine(line);
  const o = origConsole;
  if (o) {
    switch (level) {
      case "log":
        o.log(line);
        break;
      case "info":
        o.info(line);
        break;
      case "warn":
        o.warn(line);
        break;
      case "error":
        o.error(line);
        break;
      case "debug":
        o.debug(line);
        break;
      default:
        o.log(line);
    }
  }
}
