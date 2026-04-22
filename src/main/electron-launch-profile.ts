import * as fs from "fs";
import * as path from "path";

/** Persisted so the main process can open the first BrowserWindow with the right WPN backend before any renderer runs. */
export type ElectronPrimaryWpnBackend = "file" | "cloud";

const FILE_NAME = "electron-primary-wpn-backend.json";

function profilePath(userDataPath: string): string {
  return path.join(userDataPath, FILE_NAME);
}

export function readPrimaryWpnBackend(userDataPath: string): ElectronPrimaryWpnBackend {
  try {
    const raw = fs.readFileSync(profilePath(userDataPath), "utf8");
    const j = JSON.parse(raw) as { primary?: string };
    return j.primary === "cloud" ? "cloud" : "file";
  } catch {
    return "file";
  }
}

export function writePrimaryWpnBackend(
  userDataPath: string,
  backend: ElectronPrimaryWpnBackend,
): void {
  const p = profilePath(userDataPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ primary: backend }, null, 2), "utf8");
}
