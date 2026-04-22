/**
 * Headless production export for plugins under test-inputs/plugins (same bundle + zip
 * logic as PluginLoaderZipExport.exportProductionPackage, without Electron).
 *
 * Usage: from repo root, after `npm ci`
 *   npx tsx scripts/build-plugins-release.ts
 *
 * Env:
 *   PLUGIN_RELEASE_ROOT — default plugins/marketplace
 *   PLUGIN_RELEASE_OUT  — default dist/plugins (.archonplugin zips)
 *   PLUGIN_RELEASE_ONLY — optional plugin folder name (under root) OR absolute path
 *   PLUGIN_RELEASE_CONCURRENCY — max parallel plugin builds (default: min(CPU, 8), min 1)
 *
 * Plugin authors: add README.md under each plugin folder for marketplace copy ({name}-markdown.md)
 * and readmeSnippet in marketplace-index.json (README is also bundled inside the .archonplugin).
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pluginBundler } from "../src/core/plugin-bundler";
import { packageManager } from "../src/core/package-manager";
import type { PluginManifest } from "../src/core/plugin-loader-types";
import { isSafePluginName } from "../src/shared/validators";
import {
  MARKETPLACE_INDEX_FILENAME,
  MARKETPLACE_INDEX_SCHEMA_VERSION,
  type MarketplaceIndexEntry,
} from "../src/shared/marketplace-index";

function pluginReleaseConcurrency(): number {
  const raw = process.env.PLUGIN_RELEASE_CONCURRENCY?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n >= 1) return Math.min(n, 32);
  }
  return Math.min(Math.max(2, os.cpus().length), 8);
}

/** Run async tasks over `items` with at most `concurrency` in flight (order of completion may differ). */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.min(Math.max(1, concurrency), items.length);
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

function copyPluginProductionAssets(
  pluginPath: string,
  stagingPath: string,
  manifest: PluginManifest,
): void {
  for (const extra of ["README.md", "LICENSE"]) {
    const from = path.join(pluginPath, extra);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(stagingPath, extra));
    }
  }
  if (manifest.assets?.length) {
    for (const a of manifest.assets) {
      const from = path.join(pluginPath, a);
      if (!fs.existsSync(from)) {
        continue;
      }
      const to = path.join(stagingPath, a);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      const st = fs.statSync(from);
      if (st.isDirectory()) {
        fs.cpSync(from, to, { recursive: true });
      } else {
        fs.copyFileSync(from, to);
      }
    }
  }
}

type ExportPluginResult = {
  zipPath: string;
  manifest: PluginManifest;
  devRoot: string;
};

function readmeSnippetFromPath(readmePath: string, maxLen: number): string {
  try {
    const text = fs.readFileSync(readmePath, "utf8").trim();
    const oneLine = text.replace(/\s+/g, " ");
    return oneLine.length <= maxLen ? oneLine : `${oneLine.slice(0, maxLen - 1)}…`;
  } catch {
    return "";
  }
}

async function exportOneDevPlugin(
  devRoot: string,
  outputDir: string,
): Promise<ExportPluginResult> {
  const manifestPath = path.join(devRoot, "manifest.json");
  const manifest: PluginManifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf8"),
  );

  if (!isSafePluginName(manifest.name)) {
    throw new Error(`Invalid plugin name in manifest: ${manifest.name}`);
  }

  if (manifest.mode === "production") {
    const zipPath = await packageManager.createProductionPackage({
      pluginPath: devRoot,
      outputPath: outputDir,
      mode: "production",
    });
    return { zipPath, manifest, devRoot };
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "archon-prod-"));
  try {
    const distStaging = path.join(staging, "dist");
    const result = await pluginBundler.bundle(devRoot, {
      distDir: distStaging,
      minify: true,
      sourcemap: true,
      onProgress: (m) => {
        console.log(`[build-plugins-release] ${manifest.name}: ${m}`);
      },
    });

    if (!result.success) {
      throw new Error(result.errors.join("\n"));
    }

    const prodManifest: PluginManifest = {
      ...manifest,
      mode: "production",
      main: result.mainBundle!,
    };
    if (result.uiBundle) {
      prodManifest.ui = result.uiBundle;
    } else {
      delete prodManifest.ui;
    }
    delete prodManifest.dependencies;
    delete prodManifest.devDependencies;

    fs.writeFileSync(
      path.join(staging, "manifest.json"),
      JSON.stringify(prodManifest, null, 2),
    );

    copyPluginProductionAssets(devRoot, staging, manifest);

    const zipPath = await packageManager.createProductionPackage({
      pluginPath: staging,
      outputPath: outputDir,
      mode: "production",
    });
    return { zipPath, manifest, devRoot };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function npmInstallIfNeeded(pluginDir: string): void {
  const pkg = path.join(pluginDir, "package.json");
  if (!fs.existsSync(pkg)) {
    return;
  }
  const hasLock =
    fs.existsSync(path.join(pluginDir, "package-lock.json")) ||
    fs.existsSync(path.join(pluginDir, "npm-shrinkwrap.json"));
  const preferCi =
    hasLock &&
    (process.env.FORCE_NPM_CI === "1" ||
      process.env.CI === "true" ||
      process.env.GITHUB_ACTIONS === "true");

  const run = (cmd: string) => {
    console.log(`[build-plugins-release] ${cmd} in ${pluginDir}`);
    execSync(cmd, { cwd: pluginDir, stdio: "inherit", env: process.env });
  };

  if (!preferCi) {
    run("npm install");
    return;
  }

  try {
    run("npm ci");
  } catch (e) {
    console.warn(
      `[build-plugins-release] npm ci failed (lockfile out of sync?). Falling back to npm install for ${pluginDir}.`,
    );
    run("npm install");
  }
}

async function main(): Promise<void> {
  const root = path.resolve(
    process.env.PLUGIN_RELEASE_ROOT ?? "plugins/marketplace",
  );
  const outDir = path.resolve(
    process.env.PLUGIN_RELEASE_OUT ?? "dist/plugins",
  );
  const only = (process.env.PLUGIN_RELEASE_ONLY ?? "").trim();

  if (!fs.existsSync(root)) {
    console.warn(`[build-plugins-release] Missing ${root}, skipping plugins.`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  const dirs: string[] = [];
  if (only.length > 0) {
    const candidate = path.isAbsolute(only) ? only : path.join(root, only);
    if (!fs.existsSync(path.join(candidate, "manifest.json"))) {
      throw new Error(
        `[build-plugins-release] PLUGIN_RELEASE_ONLY not found or missing manifest.json: ${candidate}`,
      );
    }
    dirs.push(candidate);
  } else {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    dirs.push(
      ...entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => path.join(root, e.name))
        .filter((d) => fs.existsSync(path.join(d, "manifest.json"))),
    );
  }

  if (dirs.length === 0) {
    console.warn(
      `[build-plugins-release] No plugin folders with manifest.json under ${root}`,
    );
    return;
  }

  const conc = pluginReleaseConcurrency();
  if (dirs.length > 1) {
    console.log(
      `[build-plugins-release] ${dirs.length} plugins, concurrency ${Math.min(conc, dirs.length)}`,
    );
  }
  const built = await mapPool(dirs, conc, async (pluginDir) => {
    npmInstallIfNeeded(pluginDir);
    const out = await exportOneDevPlugin(pluginDir, outDir);
    console.log(`[build-plugins-release] OK ${out.zipPath}`);
    return out;
  });

  const indexPlugins: MarketplaceIndexEntry[] = [];
  for (const { zipPath, manifest, devRoot } of built) {
    const packageFile = path.basename(zipPath);
    const readmePath = path.join(devRoot, "README.md");
    let markdownFile: string | null = null;
    if (fs.existsSync(readmePath)) {
      const sidecar = path.join(outDir, `${manifest.name}-markdown.md`);
      fs.copyFileSync(readmePath, sidecar);
      markdownFile = `${manifest.name}-markdown.md`;
    }
    const snippet = fs.existsSync(readmePath)
      ? readmeSnippetFromPath(readmePath, 400)
      : "";
    indexPlugins.push({
      name: manifest.name,
      version: manifest.version,
      displayName: manifest.displayName,
      description: manifest.description,
      packageFile,
      markdownFile,
      readmeSnippet: snippet || undefined,
    });
  }
  indexPlugins.sort((a, b) => a.name.localeCompare(b.name));
  const indexDoc = {
    schemaVersion: MARKETPLACE_INDEX_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    plugins: indexPlugins,
  };
  fs.writeFileSync(
    path.join(outDir, MARKETPLACE_INDEX_FILENAME),
    JSON.stringify(indexDoc, null, 2),
    "utf8",
  );
  console.log(
    `[build-plugins-release] Wrote ${MARKETPLACE_INDEX_FILENAME} (${indexPlugins.length} plugins)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
