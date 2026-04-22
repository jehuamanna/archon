import { getArchon } from "../../shared/archon-host-access";
import { clientLog } from "../logging/clientLog";

/**
 * Format plugin source with Prettier when enabled; returns original content on failure.
 */
export async function formatPluginSourceWithPrettier(
  pluginFolder: string,
  content: string,
  relativePath: string,
): Promise<string> {
  const lower = relativePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : "";
  const supported = new Set([
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "json",
    "css",
    "md",
  ]);
  if (!supported.has(ext)) {
    return content;
  }
  try {
    const prettier = await import("prettier/standalone");
    const estree = await import("prettier/plugins/estree");
    const plugins: object[] = [estree];
    let parser: string;
    if (ext === "ts" || ext === "tsx") {
      plugins.push(await import("prettier/plugins/typescript"));
      parser = "typescript";
    } else if (
      ext === "js" ||
      ext === "jsx" ||
      ext === "mjs" ||
      ext === "cjs"
    ) {
      plugins.push(await import("prettier/plugins/babel"));
      parser = "babel";
    } else if (ext === "json") {
      plugins.push(await import("prettier/plugins/babel"));
      parser = "json";
    } else if (ext === "css") {
      plugins.push(await import("prettier/plugins/postcss"));
      parser = "css";
    } else {
      plugins.push(await import("prettier/plugins/markdown"));
      parser = "markdown";
    }
    const rc: Record<string, unknown> = {};
    for (const cfg of [".prettierrc.json", ".prettierrc"] as const) {
      try {
        const raw = await getArchon().readPluginSourceFile(pluginFolder, cfg);
        if (raw === null) {
          continue;
        }
        Object.assign(rc, JSON.parse(raw) as Record<string, unknown>);
        break;
      } catch {
        /* try next */
      }
    }
    const out = await prettier.format(content, {
      ...rc,
      parser,
      plugins,
    } as Parameters<typeof prettier.format>[1]);
    return out;
  } catch (e) {
    clientLog({
      component: "PluginIDE",
      level: "warn",
      message: `Prettier: ${e instanceof Error ? e.message : String(e)}`,
    });
    return content;
  }
}
