import * as fs from "fs";
import * as path from "path";

const FILE = "plugin-disabled.json";

type FileShape = { disabled?: unknown };

function safePath(userDataPath: string): string {
  return path.join(userDataPath, FILE);
}

export function readDisabledPluginIds(userDataPath: string): Set<string> {
  const p = safePath(userDataPath);
  try {
    if (!fs.existsSync(p)) {
      return new Set();
    }
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw) as FileShape;
    if (!j || !Array.isArray(j.disabled)) {
      return new Set();
    }
    return new Set(
      j.disabled.filter((x): x is string => typeof x === "string" && x.length > 0),
    );
  } catch {
    return new Set();
  }
}

export function writeDisabledPluginIds(
  userDataPath: string,
  ids: Set<string>,
): void {
  const p = safePath(userDataPath);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      `${JSON.stringify({ disabled: [...ids].sort() }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    /* ignore */
  }
}
