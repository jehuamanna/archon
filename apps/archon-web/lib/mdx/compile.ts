import { compile } from "@mdx-js/mdx";
import { getCompiled, putCompiled, sha256Hex } from "./compile-cache.js";

/** Compile MDX source → JS module source, cached by sha256(source+sdkVersion). */
export async function compileMdxCached(
  source: string,
  sdkVersion: string,
): Promise<string> {
  const cacheKey = await sha256Hex(`${sdkVersion}\n${source}`);
  const cached = await getCompiled(cacheKey);
  if (cached) return cached;

  const file = await compile(source, {
    jsxRuntime: "automatic",
    providerImportSource: undefined,
    development: false,
  });
  const compiled = String(file);
  await putCompiled(cacheKey, compiled);
  return compiled;
}
