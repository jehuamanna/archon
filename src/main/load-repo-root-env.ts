import * as fs from "fs";
import * as path from "path";

let loaded = false;

/**
 * Load repo-root `.env` into `process.env` (does not override existing vars).
 * Webpack main output lives under `.webpack/main`; two levels up is the monorepo root.
 */
export function loadRepoRootEnvOnce(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  try {
    const envPath = path.resolve(__dirname, "../../.env");
    if (!fs.existsSync(envPath)) {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dotenv = require("dotenv") as { config: (opts: { path: string }) => void };
    dotenv.config({ path: envPath });
  } catch {
    /* missing dotenv or unreadable file */
  }
}
