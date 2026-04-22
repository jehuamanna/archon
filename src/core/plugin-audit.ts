import * as fs from "fs";
import * as path from "path";

export type PluginAuditEntry = {
  t: number;
  action: string;
  pluginName?: string;
  detail?: string;
  ok?: boolean;
};

export function appendPluginAudit(
  userDataPath: string,
  entry: Omit<PluginAuditEntry, "t">,
): void {
  const line: PluginAuditEntry = { ...entry, t: Date.now() };
  const file = path.join(userDataPath, "plugin-audit.jsonl");
  try {
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
  } catch (e) {
    console.warn("[PluginAudit] append failed:", e);
  }
}
