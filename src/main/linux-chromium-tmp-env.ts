/**
 * Must run before `import "electron"` so every Chromium subprocess inherits `TMPDIR`.
 * Otherwise `platform_shared_memory_region_posix` keeps using `/tmp` and can spam
 * errors / thrash when `/tmp` is unusable in the user’s environment.
 *
 * Path matches typical Linux `app.getPath("userData")` (~/.config/<name>).
 * Opt out: `ARCHON_SKIP_CHROMIUM_TEMP_REDIRECT=1`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Keep in sync with package.json `name` (Electron userData folder on Linux). */
const LINUX_APP_CONFIG_NAME = "archon";

if (process.platform === "linux" && process.env.ARCHON_SKIP_CHROMIUM_TEMP_REDIRECT !== "1") {
  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const dir = path.join(configHome, LINUX_APP_CONFIG_NAME, "chromium-tmp");
  try {
    fs.mkdirSync(dir, { recursive: true });
    process.env.TMPDIR = dir;
    process.env.TMP = dir;
    process.env.TEMP = dir;
  } catch {
    /* ignore */
  }
}
