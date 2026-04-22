export type ClientLogLevel = "log" | "info" | "warn" | "error" | "debug";

export type ClientLogPayload = {
  level: ClientLogLevel;
  component: string;
  message: string;
  noteId?: string;
  noteTitle?: string;
};
