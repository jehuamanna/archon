import { getArchon } from "../../../shared/archon-host-access";
import type { PluginModuleDefinition } from "../../../../packages/archon-plugin-ui/src/index";
import type { PluginHostCapabilities } from "../../../shared/plugin-host-capabilities";
import { compilePluginSource } from "./compilePluginSource";
import { evaluateCompiledPluginInCompartment } from "./evaluatePluginInCompartment";

export type LoadPluginModuleFromSourceOptions = {
  source: string;
  loader: "ts" | "tsx" | "js" | "jsx";
  sourcefile?: string;
  capabilities: PluginHostCapabilities;
};

/**
 * Dev pipeline: compile TS/JS → CJS → SES Compartment → {@link PluginModuleDefinition}.
 */
export async function loadPluginModuleFromSource(
  opts: LoadPluginModuleFromSourceOptions,
): Promise<PluginModuleDefinition> {
  const { code } = await compilePluginSource(opts.source, opts.loader, {
    sourcefile: opts.sourcefile,
    format: "cjs",
  });
  return evaluateCompiledPluginInCompartment({
    cjsCode: code,
    capabilities: opts.capabilities,
  });
}

/**
 * Prod: dynamic import of ESM (content-hashed URL from {@link PluginBundleIndex}).
 */
export async function loadPluginModuleFromUrl(url: string): Promise<PluginModuleDefinition> {
  const mod = (await import(/* webpackIgnore: true */ url)) as {
    default?: PluginModuleDefinition;
  };
  const plugin = mod.default;
  if (!plugin || typeof plugin !== "object" || !plugin.id) {
    throw new Error(`Plugin module at ${url} must export default definePlugin({ id, ... })`);
  }
  return plugin;
}

/** Build {@link PluginHostCapabilities} from `getArchon()` + mediated fetch. */
export function buildRendererPluginHostCapabilities(): PluginHostCapabilities {
  const archon = getArchon();
  const mediatedFetch: PluginHostCapabilities["fetch"] = (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/")) {
      return fetch(input, init);
    }
    return Promise.reject(new Error(`Blocked fetch to ${url}`));
  };
  return {
    apiVersion: "0.1",
    archon,
    fetch: mediatedFetch,
  };
}
