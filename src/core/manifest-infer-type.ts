import * as fs from "fs";
import * as path from "path";
import type { PluginManifest, PluginType } from "./plugin-loader";

export function inferPluginTypeFromDisk(
  pluginPath: string,
  manifest: PluginManifest,
): PluginType {
  const mainPath = path.join(pluginPath, manifest.main);
  const mainOk = fs.existsSync(mainPath);

  const uiOk =
    Boolean(manifest.ui) && fs.existsSync(path.join(pluginPath, manifest.ui!));
  const htmlOk =
    Boolean(manifest.html) &&
    fs.existsSync(path.join(pluginPath, manifest.html!));

  let looseJsx = false;
  try {
    const entries = fs.readdirSync(pluginPath, { withFileTypes: true });
    const mainBase = path.basename(manifest.main);
    for (const e of entries) {
      if (!e.isFile()) {
        continue;
      }
      if (/\.(jsx|tsx)$/.test(e.name) && e.name !== mainBase) {
        looseJsx = true;
        break;
      }
    }
  } catch {
    /* ignore */
  }

  const hasFrontendHint = uiOk || htmlOk || looseJsx;
  if (hasFrontendHint && mainOk) {
    return "hybrid";
  }
  if (hasFrontendHint) {
    return "ui";
  }
  return "backend";
}
