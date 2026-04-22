import * as fs from "fs";
import * as path from "path";
import * as esbuild from "esbuild";
import { rollup } from "rollup";
import nodeResolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import replace from "@rollup/plugin-replace";
import esbuildPlugin from "rollup-plugin-esbuild";
import { pluginCacheManager } from "./plugin-cache-manager";
import { emitPluginProgress } from "./plugin-progress";
import type { PluginManifest } from "./plugin-loader";
import type { Plugin as EsbuildPlugin } from "esbuild";
import { resolveArchonPluginUiEntry } from "./resolve-archon-plugin-ui";

export interface BundleOptions {
  minify?: boolean;
  sourcemap?: boolean;
  /** Where to write `main.bundle.js` / `ui.bundle.js` (default: `<pluginPath>/dist`) */
  distDir?: string;
  /**
   * Root used for manifest-relative paths (main/ui). Default: parent of `dist` when `distDir` ends with `dist`, else `distDir` (flat output e.g. `bin/<name>`).
   */
  bundleOutputRoot?: string;
  /** Emit progress lines for logging / IPC */
  onProgress?: (message: string) => void;
}

export interface BundleResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  /** Relative paths from plugin root (or staging root) for manifest */
  mainBundle?: string;
  uiBundle?: string;
}

const REACT_EXTERNALS = ["react", "react-dom", "react-dom/client"] as const;

/** Same ESM entry as host webpack (avoids CJS `min/vs` + nls loader issues). */
function resolveMonacoEditorEsm(pluginPath: string): string | undefined {
  const local = path.join(
    pluginPath,
    "node_modules",
    "monaco-editor",
    "esm",
    "vs",
    "editor",
    "editor.main.js",
  );
  if (fs.existsSync(local)) {
    return local;
  }
  try {
    return require.resolve("monaco-editor/esm/vs/editor/editor.main.js");
  } catch {
    return undefined;
  }
}

function archonPluginUiEsbuildPlugin(): EsbuildPlugin {
  return {
    name: "archon-plugin-ui-alias",
    setup(build) {
      build.onResolve({ filter: /^@archon\/plugin-ui$/ }, () => {
        const entry = resolveArchonPluginUiEntry();
        if (!entry) {
          return {
            errors: [
              {
                text: "Could not resolve @archon/plugin-ui (packages/archon-plugin-ui not found). Run from repo root.",
              },
            ],
          };
        }
        return { path: entry };
      });
    },
  };
}

function archonPluginUiRollupPlugin(): {
  name: string;
  resolveId(id: string): string | null;
} {
  return {
    name: "archon-plugin-ui-alias",
    resolveId(id: string) {
      if (id !== "@archon/plugin-ui") {
        return null;
      }
      return resolveArchonPluginUiEntry();
    },
  };
}

function monacoEditorAliasEsbuildPlugin(pluginPath: string): EsbuildPlugin {
  const target = resolveMonacoEditorEsm(pluginPath);
  return {
    name: "monaco-editor-esm-alias",
    setup(build) {
      if (!target) {
        return;
      }
      build.onResolve({ filter: /^monaco-editor$/ }, () => ({ path: target }));
    },
  };
}

function monacoEditorAliasRollupPlugin(pluginPath: string): {
  name: string;
  resolveId(id: string): string | null;
} {
  const target = resolveMonacoEditorEsm(pluginPath);
  return {
    name: "monaco-editor-esm-alias",
    resolveId(id: string) {
      if (!target || id !== "monaco-editor") {
        return null;
      }
      return target;
    },
  };
}

/** Monaco (and others) ship `.css` / font imports Rollup must not choke on. */
function rollupStubAssetImports(): {
  name: string;
  load(id: string): string | null;
} {
  return {
    name: "stub-asset-imports",
    load(id: string) {
      if (id.endsWith(".css")) {
        return "export default {}";
      }
      if (/\.(ttf|woff2?|woff|eot)$/i.test(id)) {
        return "export default ''";
      }
      return null;
    },
  };
}

/** Dev-only: bundle UI for iframe; `react` maps to `window.Archon.React` at runtime. */
function archonReactShimPlugins(): EsbuildPlugin {
  return {
    name: "archon-react-shims",
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({
        path: "virtual:archon-react",
        namespace: "archon-shim",
      }));
      build.onResolve({ filter: /^react-dom\/client$/ }, () => ({
        path: "virtual:archon-rdc",
        namespace: "archon-shim",
      }));
      build.onLoad({ filter: /.*/, namespace: "archon-shim" }, (args) => {
        if (args.path === "virtual:archon-react") {
          return {
            loader: "js",
            contents: `
              const R = typeof window !== "undefined" && window.Archon && window.Archon.React
                ? window.Archon.React
                : {};
              module.exports = R;
              module.exports.default = R;
            `,
          };
        }
        if (args.path === "virtual:archon-rdc") {
          return {
            loader: "js",
            contents: `
              const RD = typeof window !== "undefined" && window.Archon && window.Archon.ReactDOM
                ? window.Archon.ReactDOM
                : {};
              module.exports = {
                createRoot: function (c) {
                  return RD.createRoot.call(RD, c);
                },
              };
            `,
          };
        }
        return null;
      });
    },
  };
}

function readManifest(pluginPath: string): PluginManifest {
  const raw = fs.readFileSync(
    path.join(pluginPath, "manifest.json"),
    "utf8",
  );
  return JSON.parse(raw) as PluginManifest;
}

/** Prefer workspace `node_modules`, then global plugin-cache (Electron cache dir). */
function cacheNodeModulesPath(pluginPath: string): string | undefined {
  try {
    const manifest = readManifest(pluginPath);
    const localNm = path.join(pluginPath, "node_modules");
    if (fs.existsSync(localNm)) {
      return localNm;
    }
    const cacheNm = pluginCacheManager.getNodeModulesPath(manifest.name);
    return fs.existsSync(cacheNm) ? cacheNm : undefined;
  } catch {
    return undefined;
  }
}

export class PluginBundler {
  /**
   * UI bundle for development iframe (esbuild async API; plugins require async `esbuild.build`).
   * React comes from Archon bridge.
   */
  async bundleUiForDevIframe(
    pluginPath: string,
    uiRelative: string,
    minify = false,
  ): Promise<string> {
    const uiEntry = path.join(pluginPath, uiRelative);
    if (!fs.existsSync(uiEntry)) {
      throw new Error(`UI entry not found: ${uiRelative}`);
    }

    const cacheNm = cacheNodeModulesPath(pluginPath);
    const result = await esbuild.build({
      absWorkingDir: pluginPath,
      entryPoints: [uiEntry],
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      minify,
      /** Use React's production jsx-runtime (no `require("react")` inside jsx-runtime). */
      define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
      },
      jsx: "transform",
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
      loader: {
        ".ts": "ts",
        ".tsx": "tsx",
        ".css": "empty",
        ".ttf": "empty",
        ".woff": "empty",
        ".woff2": "empty",
      },
      plugins: [
        monacoEditorAliasEsbuildPlugin(pluginPath),
        archonPluginUiEsbuildPlugin(),
        archonReactShimPlugins(),
      ],
      logLevel: "silent",
      ...(cacheNm ? { nodePaths: [cacheNm] } : {}),
    });

    if (!result.outputFiles?.length) {
      throw new Error("UI bundle produced no output");
    }

    return result.outputFiles[0].text;
  }

  /**
   * Bundle plugin backend (esbuild) and optional UI (Rollup + esbuild transform).
   * React / ReactDOM are external and expected as `Archon.React` / `Archon.ReactDOM` in the iframe.
   */
  async bundle(pluginPath: string, options: BundleOptions = {}): Promise<BundleResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const minify = options.minify !== false;
    const sourcemap = options.sourcemap !== false;
    const distDir = options.distDir ?? path.join(pluginPath, "dist");
    const bundleOutputRoot =
      options.bundleOutputRoot ??
      (path.basename(distDir) === "dist"
        ? path.dirname(distDir)
        : distDir);
    let pluginLabel = path.basename(pluginPath);

    let manifest: PluginManifest;
    try {
      manifest = readManifest(pluginPath);
    } catch (e) {
      return {
        success: false,
        errors: [
          e instanceof Error ? e.message : "Failed to read manifest.json",
        ],
        warnings,
      };
    }

    pluginLabel = manifest.name;

    const progress = (m: string) => {
      options.onProgress?.(m);
      emitPluginProgress({
        op: "bundle",
        phase: "progress",
        message: m,
        pluginName: pluginLabel,
      });
    };

    emitPluginProgress({
      op: "bundle",
      phase: "start",
      message: "Bundle started",
      pluginName: pluginLabel,
    });

    fs.mkdirSync(distDir, { recursive: true });

    const mainEntry = path.join(pluginPath, manifest.main);
    if (!fs.existsSync(mainEntry)) {
      return {
        success: false,
        errors: [`Backend entry not found: ${manifest.main}`],
        warnings,
      };
    }

    const mainOut = path.join(distDir, "main.bundle.js");
    const cacheNm = cacheNodeModulesPath(pluginPath);
    progress("Bundling backend (esbuild)…");

    try {
      await esbuild.build({
        absWorkingDir: pluginPath,
        entryPoints: [mainEntry],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: mainOut,
        minify,
        sourcemap,
        logLevel: "silent",
        external: ["electron"],
        ...(cacheNm ? { nodePaths: [cacheNm] } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`esbuild (main): ${msg}`);
      return { success: false, errors, warnings };
    }

    const mainRelative = path
      .relative(bundleOutputRoot, mainOut)
      .split(path.sep)
      .join("/");
    let uiRelative: string | undefined;

    if (manifest.ui) {
      const uiEntry = path.join(pluginPath, manifest.ui);
      if (!fs.existsSync(uiEntry)) {
        return {
          success: false,
          errors: [`UI entry not found: ${manifest.ui}`],
          warnings,
        };
      }

      const uiOut = path.join(distDir, "ui.bundle.js");
      progress("Bundling frontend (Rollup)…");

      try {
        const bundle = await rollup({
          input: uiEntry,
          external: [...REACT_EXTERNALS],
          plugins: [
            monacoEditorAliasRollupPlugin(pluginPath),
            archonPluginUiRollupPlugin(),
            rollupStubAssetImports(),
            replace({
              preventAssignment: true,
              values: {
                "process.env.NODE_ENV": JSON.stringify("production"),
              },
            }),
            nodeResolve({
              extensions: [".js", ".jsx", ".ts", ".tsx", ".json"],
              preferBuiltins: false,
              ...(cacheNm ? { modulePaths: [cacheNm] } : {}),
            }),
            commonjs(),
            esbuildPlugin({
              include: /\.[jt]sx?$/,
              minify,
              sourceMap: sourcemap,
              jsx: "transform",
              jsxFactory: "React.createElement",
              jsxFragment: "React.Fragment",
              target: "es2020",
            }),
          ],
          onwarn: (w) => {
            warnings.push(
              `${w.code ?? "warn"}: ${w.message}${w.loc ? ` (${w.loc.file})` : ""}`,
            );
          },
        });

        await bundle.write({
          file: uiOut,
          format: "iife",
          sourcemap,
          inlineDynamicImports: true,
          globals: {
            react: "Archon.React",
            "react-dom": "Archon.ReactDOM",
            "react-dom/client": "Archon.ReactDOM",
          },
        });
        await bundle.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`rollup (ui): ${msg}`);
        return { success: false, errors, warnings };
      }

      uiRelative = path
        .relative(bundleOutputRoot, uiOut)
        .split(path.sep)
        .join("/");
    }

    if (manifest.workers?.length) {
      const workersDir = path.join(distDir, "workers");
      fs.mkdirSync(workersDir, { recursive: true });
      progress("Processing worker entries…");

      for (const w of manifest.workers) {
        const srcAbs = path.join(pluginPath, w);
        if (!fs.existsSync(srcAbs)) {
          errors.push(`Worker file not found: ${w}`);
          return { success: false, errors, warnings };
        }

        const base = path.basename(w);
        if (/\.(tsx?|jsx?)$/i.test(w)) {
          const outFile = path.join(
            workersDir,
            base.replace(/\.(tsx?|jsx?)$/i, ".bundle.js"),
          );
          try {
            await esbuild.build({
              absWorkingDir: pluginPath,
              entryPoints: [srcAbs],
              bundle: true,
              platform: "browser",
              format: "esm",
              outfile: outFile,
              minify,
              sourcemap,
              logLevel: "silent",
              ...(cacheNm ? { nodePaths: [cacheNm] } : {}),
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            errors.push(`esbuild (worker ${w}): ${msg}`);
            return { success: false, errors, warnings };
          }
        } else {
          fs.copyFileSync(srcAbs, path.join(workersDir, base));
        }
      }
    }

    progress("Bundle complete.");
    emitPluginProgress({
      op: "bundle",
      phase: "done",
      message: "Bundle complete",
      pluginName: pluginLabel,
    });
    return {
      success: true,
      errors,
      warnings,
      mainBundle: mainRelative,
      uiBundle: uiRelative,
    };
  }
}

export const pluginBundler = new PluginBundler();
