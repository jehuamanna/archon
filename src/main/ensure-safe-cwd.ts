/**
 * Run before the rest of the main bundle. Some dependencies (notably `esbuild/lib/main.js`)
 * call `process.cwd()` at module load time; if the process was started with a cwd that was
 * later deleted, `cwd()` throws ENOENT and the app crashes before any UI.
 */
import * as fs from "fs";
import * as os from "os";

function ensureSafeCwd(): void {
  try {
    void process.cwd();
    return;
  } catch {
    /* ENOENT: working directory no longer exists */
  }
  const tmp = os.tmpdir();
  const candidates: string[] = [
    os.homedir(),
    process.env.TMPDIR || "",
    tmp,
    "/",
  ].filter((d): d is string => typeof d === "string" && d.length > 0);

  for (const dir of candidates) {
    try {
      if (dir !== "/") {
        fs.mkdirSync(dir, { recursive: true });
      }
      process.chdir(dir);
      return;
    } catch {
      /* try next */
    }
  }
}

ensureSafeCwd();
