import * as esbuild from "esbuild";

export type CompilePluginSourceOptions = {
  sourcefile?: string;
  /** `esm` for tooling; `cjs` for SES Compartment evaluation. */
  format?: "esm" | "cjs";
};

/**
 * Compile a single plugin module (ts/tsx/js/jsx).
 * Production hosts should load pre-hashed bundles; this is for dev / IDE / Electron.
 */
export async function compilePluginSource(
  source: string,
  loader: "ts" | "tsx" | "js" | "jsx",
  opts?: CompilePluginSourceOptions,
): Promise<{ code: string; warnings: esbuild.Message[] }> {
  const format = opts?.format ?? "esm";
  const result = await esbuild.transform(source, {
    loader,
    format,
    target: "es2022",
    sourcemap: "inline",
    sourcefile: opts?.sourcefile ?? `plugin.${loader}`,
  });
  return { code: result.code, warnings: result.warnings };
}
