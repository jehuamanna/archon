import * as fs from "fs";
import * as path from "path";

/** Append one UTF-8 line to `userData/logs/archon-YYYY-MM-DD.log` (creates dirs as needed). */
export function appendArchonDailyLog(userDataPath: string, line: string): void {
  const dir = path.join(userDataPath, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const file = path.join(dir, `archon-${y}-${m}-${day}.log`);
  fs.appendFileSync(file, `${line}\n`, "utf8");
}
